// @screen app.esim
// eSIM — opened from Settings. Buys a data eSIM from nadanada.me with Bitcoin
// over Lightning (no account; Nuri's referral code rides on every order) and
// keeps the eSIMs this wallet bought: install QR, install link, data left.
// A second purchase for a place this wallet already has an eSIM for adds data
// to that eSIM instead of buying another one (same ICCID, nothing to install).
//
// Paying is NOT done here: a plan's invoice is handed to the regular Bitcoin
// send sheet (onPayInvoice), the same one a scanned Lightning invoice opens.
// The order is persisted before that hand-off and claimed by its payment hash,
// so an eSIM paid for is fetched whenever this screen is open, including after
// a restart or on a restored wallet.
import type * as React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking } from "react-native";
import * as Localization from "expo-localization";
import {
  Button,
  ButtonIcon,
  ButtonText,
  Header,
  IconButton,
  List,
  ListAction,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailIcon,
  ListActionTrailingText,
  ListSeparator,
  Screen,
  Scroll,
  Text,
  TextField,
  TextFieldIconButton,
  Topbar,
  TopbarLeading,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import AddressQrTile from "../../components/AddressQrTile";
import DsSheetHost from "../../components/DsSheetHost";
import { Layer } from "../../components/LayerHost";
import Spinner from "../../components/Spinner";
import { copyToClipboard } from "../../lib/copyToClipboard";
import { errMsg } from "../../lib/errorMessage";
import { t } from "../../lib/i18n";
import {
  claimPendingEsims,
  reopenEsimPayment,
  createEsimOrder,
  createEsimTopup,
  currentEsims,
  getEsimPlaces,
  getEsimPlans,
  getEsimStatus,
  installUrlFor,
  loadEsims,
  onEsimToppedUp,
  subscribeEsims,
} from "../../services/esim/EsimService";
import { lightningSendStartedFor } from "../../services/arkade/lightningSendStarted";
import { EventBus } from "../../services/events/AppEventBusService";
import {
  type EsimPendingOrder,
  type EsimPlace,
  type EsimPlan,
  type EsimRecord,
  type EsimStatus,
  type OrderDelivery,
  type OwnedEsim,
  currentDataLeft,
  daysLeft,
  filterPlaces,
  formatDataAmount,
  installParts,
  orderDelivery,
  planSummary,
  topupTarget,
  deliveredTopups,
  visiblePending,
} from "../../services/esim/esimModel";

const K = "screen.Esim";

/** Places drawn before a search narrows them. */
const PLACE_PAGE = 60;
/** A paid order nadanada hasn't delivered after this long offers support. */
const SLOW_DELIVERY_MS = 10 * 60 * 1000;

type Props = {
  visible: boolean;
  onClose: () => void;
  /**
   * Pay an order's invoice with the regular Bitcoin send flow, opened on top
   * of this screen; closing it lands back here, where the order is claimed.
   */
  onPayInvoice: (invoice: string, amountSats: number) => void;
};

const usd = (value: number) => `$${value.toFixed(2)}`;

const words = {
  unlimited: () => t(`${K}.unlimited`),
  days: (n: number) => t(n === 1 ? `${K}.day` : `${K}.days`, { count: n }),
};

function summary(plan: Pick<EsimPlan, "dataGb" | "days" | "unlimited">): string {
  return planSummary(plan, { unlimited: words.unlimited(), days: words.days });
}

function bundleSummary(bundleName: string): string {
  // fixed_1GB_7D_DE / esimc_1GB_7D_DE_V2 → "1 GB · 7 days"
  const match = bundleName.match(/_(\d+(?:\.\d+)?)GB_(\d+)D_/i);
  if (!match) return bundleName;
  return summary({ dataGb: Number(match[1]), days: Number(match[2]), unlimited: false });
}

function placeLabel(place: EsimPlace): string {
  return place.flag ? `${place.flag} ${place.name}` : place.name;
}

/** Money already on an order that nadanada is delivering: said in words. */
function DeliveringCard({ order, state }: { order: EsimPendingOrder; state: OrderDelivery }) {
  return (
    <View
      variant="soft"
      radius="lg"
      paddingX="lg"
      paddingY="md"
      direction="row"
      align="center"
      gap="md"
    >
      <Spinner />
      <View fill="grow-shrink" direction="column" align="stretch" gap="xs">
        <Text size="sm" emphasis>
          {t(`${K}.${state}`)}
        </Text>
        <Text size="sm" muted>
          {`${order.placeName} · ${bundleSummary(order.bundleName)}`}
        </Text>
      </View>
    </View>
  );
}

const EsimScreen: React.FC<Props> = ({ visible, onClose, onPayInvoice }) => {
  const [record, setRecord] = useState<EsimRecord>(currentEsims);
  const [places, setPlaces] = useState<EsimPlace[] | null>(null);
  const [placesError, setPlacesError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [place, setPlace] = useState<EsimPlace | null>(null);
  const [plans, setPlans] = useState<EsimPlan[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [ordering, setOrdering] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [openEsim, setOpenEsim] = useState<OwnedEsim | null>(null);
  const [statuses, setStatuses] = useState<Record<string, EsimStatus | null>>({});
  /**
   * The eSIM whose own "Add data" opened the plans. A wallet can hold two
   * eSIMs for one country, so the picked one wins over the place.
   */
  const [topupFor, setTopupFor] = useState<OwnedEsim | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Unpaid orders whose invoice may be paid from here (see reopenEsimPayment). */
  const [payable, setPayable] = useState<ReadonlySet<string>>(() => new Set());

  const homeCountry = useMemo(() => Localization.getLocales()[0]?.regionCode ?? null, []);

  useEffect(() => subscribeEsims(setRecord), []);

  // Fresh state on every open; the record itself is the service's.
  useEffect(() => {
    if (!visible) {
      setQuery("");
      setPlace(null);
      setOpenEsim(null);
      setTopupFor(null);
      setOrderError(null);
      return;
    }
    void loadEsims()
      .then(setRecord)
      .catch(() => {});
    setPlacesError(null);
    void getEsimPlaces()
      .then(setPlaces)
      .catch((e) => setPlacesError(errMsg(e, t(`${K}.loadFailed`))));
  }, [visible]);

  // Claiming runs app-wide (startEsimTracking); opening the page asks once
  // more at once and keeps the row labels current.
  useEffect(() => {
    if (!visible) return;
    void claimPendingEsims();
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [visible]);

  // Each owned eSIM's dashboard (install state, bundles, data), read once per
  // open and again after a top-up lands.
  const iccids = record.esims.map((e) => e.iccid).join(",");
  const refreshStatus = useCallback((iccid: string) => {
    void getEsimStatus(iccid).then((status) =>
      setStatuses((prev) => ({ ...prev, [iccid]: status ?? prev[iccid] ?? null })),
    );
  }, []);
  useEffect(() => {
    if (!visible || !iccids) return;
    for (const iccid of iccids.split(",")) refreshStatus(iccid);
  }, [visible, iccids, refreshStatus]);
  useEffect(() => onEsimToppedUp(refreshStatus), [refreshStatus]);

  const openEsimPage = useCallback((esim: OwnedEsim) => {
    setOpenEsim(esim);
  }, []);

  // An eSIM delivered while this page is open shows itself at once: an order
  // that leaves the list must never read as "nothing happened", which is what
  // makes people buy the same plan a second time.
  const orderedHashes = useRef<Set<string>>(new Set());
  const autoShown = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!visible) {
      orderedHashes.current = new Set();
      autoShown.current = new Set();
      return;
    }
    for (const order of record.pending) orderedHashes.current.add(order.paymentHash);
    const delivered = record.esims.find(
      (esim) => orderedHashes.current.has(esim.paymentHash) && !autoShown.current.has(esim.iccid),
    );
    if (!delivered) return;
    autoShown.current.add(delivered.iccid);
    openEsimPage(delivered);
  }, [visible, record, openEsimPage]);

  // A top-up delivers into an eSIM that already exists (it keeps its purchase
  // hash), so it is the order's own hash leaving `pending` that says so. The
  // card it added data to then opens, with its data re-read: a paid top-up
  // never ends on the shop list either.
  const orderedTopups = useRef<Map<string, string>>(new Map());
  const topupsShown = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!visible) {
      orderedTopups.current = new Map();
      topupsShown.current = new Set();
      return;
    }
    for (const order of record.pending) {
      if (order.topupIccid) orderedTopups.current.set(order.paymentHash, order.topupIccid);
    }
    const landed = deliveredTopups(record, orderedTopups.current, topupsShown.current);
    for (const { paymentHash, iccid } of landed) {
      topupsShown.current.add(paymentHash);
      const esim = record.esims.find((owned) => owned.iccid === iccid);
      if (!esim) continue;
      refreshStatus(iccid);
      openEsimPage(esim);
    }
  }, [visible, record, openEsimPage, refreshStatus]);

  // Add data: the eSIM's own place (country or region), plans as for a new
  // one; picking a plan adds to this eSIM (see extendTarget).
  const startTopup = useCallback(
    (esim: OwnedEsim) => {
      const target =
        (places ?? []).find((p) => p.slug === esim.placeSlug) ??
        (places ?? []).find((p) => p.name === esim.placeName);
      if (!target) {
        setOrderError(t(`${K}.topupUnavailable`));
        return;
      }
      setOpenEsim(null);
      setTopupFor(esim);
      openPlace(target);
    },
    [places],
  );

  // Plans belong to the place they were asked for: a late answer for an
  // earlier place must never show, or be bought, under the current one.
  const plansRequest = useRef(0);
  const openPlace = useCallback((next: EsimPlace) => {
    const ticket = ++plansRequest.current;
    setPlace(next);
    setPlans(null);
    setPlansError(null);
    setOrderError(null);
    void getEsimPlans(next)
      .then((list) => {
        if (plansRequest.current === ticket) setPlans(list);
      })
      .catch((e) => {
        if (plansRequest.current === ticket) setPlansError(errMsg(e, t(`${K}.loadFailed`)));
      });
  }, []);

  // The eSIM a purchase for the open place extends: the one "Add data" was
  // pressed on, else the one this wallet has for that place. Buying data for a
  // place you have an eSIM for always adds to it (same ICCID, nothing to
  // install), never buys a second one.
  const extendTarget = useMemo(
    () => (place ? topupTarget(topupFor, record.esims, place) : null),
    [place, topupFor, record.esims],
  );

  const buy = useCallback(
    (plan: EsimPlan) => {
      if (!place || ordering) return;
      setOrdering(plan.name);
      setOrderError(null);
      const order = extendTarget
        ? createEsimTopup(extendTarget, place, plan)
        : createEsimOrder(place, plan);
      void order
        .then(({ invoice, amountSats }) => {
          setPlace(null);
          setTopupFor(null);
          onPayInvoice(invoice, amountSats);
        })
        .catch((e) => setOrderError(errMsg(e, t(`${K}.orderFailed`))))
        .finally(() => setOrdering(null));
    },
    [place, ordering, onPayInvoice, extendTarget],
  );

  // A paid order that hasn't arrived: support gets the checkout id, which is
  // nadanada's own handle on the order.
  const openSupport = useCallback((order: EsimPendingOrder) => {
    void copyToClipboard(order.checkoutId);
    try {
      EventBus.emit("support:openNostrChat");
    } catch {}
  }, []);

  const shown = useMemo(() => {
    const list = filterPlaces(places ?? [], query, homeCountry);
    return query.trim() ? list : list.slice(0, PLACE_PAGE);
  }, [places, query, homeCountry]);

  // An order whose invoice expired unpaid is still claimed in the background
  // (a payment in flight at expiry can settle), but no longer listed.
  const openOrders = record.pending.filter((order) => visiblePending(order, now));
  const unpaidKey = openOrders
    .filter((order) => order.paidAt === undefined)
    .map((order) => order.paymentHash)
    .join(",");

  // Orders with money on them (a send started or a payment made) are not rows
  // to act on: they say what is happening, above the list.
  const delivering = openOrders
    .map((order) => ({ order, state: orderDelivery(order, now, SLOW_DELIVERY_MS) }))
    .filter(
      (row): row is { order: EsimPendingOrder; state: OrderDelivery } =>
        row.state === "sending" || row.state === "delivering",
    );
  const listedOrders = openOrders.filter(
    (order) => !delivering.some((row) => row.order.paymentHash === order.paymentHash),
  );

  // Which unpaid orders can be paid from their row; rechecked as time passes,
  // so a row stops offering payment shortly before its invoice expires.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` re-runs the check on the clock tick.
  useEffect(() => {
    if (!visible || !unpaidKey) {
      setPayable(new Set());
      return;
    }
    let live = true;
    void Promise.all(
      unpaidKey
        .split(",")
        .map(async (hash) =>
          (await reopenEsimPayment(hash, lightningSendStartedFor)) ? hash : null,
        ),
    ).then((hashes) => {
      if (live) setPayable(new Set(hashes.filter((h): h is string => h !== null)));
    });
    return () => {
      live = false;
    };
  }, [visible, unpaidKey, now]);

  // Asks the service again at tap time: the row may be a few seconds stale.
  const payOrder = useCallback(
    (order: EsimPendingOrder) => {
      void reopenEsimPayment(order.paymentHash, lightningSendStartedFor).then((pay) => {
        if (pay) onPayInvoice(pay.invoice, pay.amountSats);
        else setPayable((prev) => new Set([...prev].filter((h) => h !== order.paymentHash)));
      });
    },
    [onPayInvoice],
  );
  const hasMine = record.esims.length > 0 || openOrders.length > 0;

  return (
    <>
      <Layer visible={visible} onRequestClose={onClose}>
        <Screen>
          <View chrome="canvas" direction="column" align="stretch" fill="grow-shrink">
            <Header safeAreaTop chrome="canvas">
              <Topbar layout="fluid" surface="transparent">
                <TopbarTitle>{t(`${K}.title`)}</TopbarTitle>
                <TopbarTrailing>
                  <IconButton
                    icon="cross"
                    variant="soft"
                    accessibilityLabel={t("common.close")}
                    onPress={onClose}
                  />
                </TopbarTrailing>
              </Topbar>
            </Header>

            <Scroll safeAreaBottom>
              <View direction="column" align="stretch" gap="xl" paddingY="md">
                {hasMine ? (
                  <View direction="column" align="stretch" gap="sm">
                    <View paddingX="lg">
                      <Text size="sm" emphasis muted>
                        {t(`${K}.mine`)}
                      </Text>
                    </View>
                    {delivering.length > 0 ? (
                      <View direction="column" align="stretch" gap="sm" paddingX="lg">
                        {delivering.map(({ order, state }) => (
                          <DeliveringCard key={order.paymentHash} order={order} state={state} />
                        ))}
                      </View>
                    ) : null}
                    {listedOrders.length > 0 || record.esims.length > 0 ? (
                      <List>
                        {/* An unpaid order opens its invoice again, but only while
                            this wallet never started a send for it: a second
                            send of the same invoice would lock sats nobody can
                            claim (reopenEsimPayment). */}
                        {listedOrders.map((order, index) => (
                          <Fragment key={order.paymentHash}>
                            {index > 0 ? <ListSeparator /> : null}
                            {(() => {
                              const slow =
                                order.paidAt !== undefined && now - order.paidAt > SLOW_DELIVERY_MS;
                              const canPay = !slow && payable.has(order.paymentHash);
                              const label = slow
                                ? t(`${K}.slow`)
                                : canPay
                                  ? t(`${K}.payNow`)
                                  : t(`${K}.pending`);
                              return (
                                <ListAction
                                  accessibilityLabel={`${order.placeName}, ${label}`}
                                  onPress={
                                    slow
                                      ? () => openSupport(order)
                                      : canPay
                                        ? () => payOrder(order)
                                        : undefined
                                  }
                                >
                                  <ListActionText>{order.placeName}</ListActionText>
                                  <ListActionTextMuted>
                                    {bundleSummary(order.bundleName)}
                                  </ListActionTextMuted>
                                  <ListActionTrailingText>{label}</ListActionTrailingText>
                                  {slow || canPay ? (
                                    <ListActionTrailIcon name="chevron-right" />
                                  ) : null}
                                </ListAction>
                              );
                            })()}
                          </Fragment>
                        ))}
                        {record.esims.map((esim, index) => {
                          const status = statuses[esim.iccid];
                          const left = status ? currentDataLeft(status) : null;
                          return (
                            <Fragment key={esim.iccid}>
                              {index > 0 || listedOrders.length > 0 ? <ListSeparator /> : null}
                              <ListAction
                                accessibilityLabel={esim.placeName}
                                onPress={() => openEsimPage(esim)}
                              >
                                <ListActionText>{esim.placeName}</ListActionText>
                                <ListActionTextMuted>
                                  {bundleSummary(esim.bundleName)}
                                </ListActionTextMuted>
                                {status ? (
                                  <ListActionTrailingText>
                                    {!status.installed
                                      ? t(`${K}.notInstalled`)
                                      : left !== null
                                        ? t(`${K}.left`, { amount: formatDataAmount(left) })
                                        : t(`${K}.noActivePlan`)}
                                  </ListActionTrailingText>
                                ) : null}
                                <ListActionTrailIcon name="chevron-right" />
                              </ListAction>
                            </Fragment>
                          );
                        })}
                      </List>
                    ) : null}
                  </View>
                ) : null}

                <View direction="column" align="stretch" gap="sm">
                  <View paddingX="lg">
                    <Text size="sm" emphasis muted>
                      {t(`${K}.buy`)}
                    </Text>
                  </View>
                  <View paddingX="lg">
                    <TextField
                      value={query}
                      onChangeText={setQuery}
                      placeholder={t(`${K}.searchPlaceholder`)}
                      inputMode="search"
                      autoCapitalize="none"
                      accessibilityLabel={t(`${K}.search`)}
                    >
                      {query.length > 0 ? (
                        <TextFieldIconButton
                          name="cross-circle"
                          accessibilityLabel={t(`${K}.clearSearch`)}
                          onPress={() => setQuery("")}
                        />
                      ) : null}
                    </TextField>
                  </View>
                  {places === null && !placesError ? (
                    <View align="center" paddingY="lg">
                      <Spinner />
                    </View>
                  ) : null}
                  {placesError ? (
                    <View paddingX="lg">
                      <Text size="sm" muted align="center">
                        {placesError}
                      </Text>
                    </View>
                  ) : null}
                  {shown.length > 0 ? (
                    <List>
                      {shown.map((p, index) => (
                        <Fragment key={`${p.kind}:${p.code}`}>
                          {index > 0 ? <ListSeparator /> : null}
                          <ListAction
                            accessibilityLabel={p.name}
                            onPress={() => {
                              // A shop purchase is about the place: any eSIM
                              // picked on its own card no longer applies.
                              setTopupFor(null);
                              openPlace(p);
                            }}
                          >
                            <ListActionText>{placeLabel(p)}</ListActionText>
                            <ListActionTrailIcon name="chevron-right" />
                          </ListAction>
                        </Fragment>
                      ))}
                    </List>
                  ) : places && query ? (
                    <View paddingX="lg">
                      <Text size="sm" muted align="center">
                        {t(`${K}.noMatches`)}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </Scroll>
          </View>
        </Screen>
      </Layer>

      {/* Plans for one country or region, cheapest first; a tap orders it and
          hands the invoice to the Bitcoin send sheet. For a place this wallet
          already has an eSIM for, the order adds data to that eSIM. */}
      <DsSheetHost
        visible={visible && place !== null}
        onClose={() => {
          plansRequest.current += 1;
          setPlace(null);
          setTopupFor(null);
        }}
        mode="full"
      >
        <Header safeAreaTop chrome="canvas">
          <Topbar surface="transparent" layout="fluid">
            <TopbarLeading>
              <IconButton
                icon="chevron-left"
                variant="soft"
                accessibilityLabel={t("common.back")}
                onPress={() => {
                  setPlace(null);
                  setTopupFor(null);
                }}
              />
            </TopbarLeading>
            <TopbarTitle>
              {place
                ? extendTarget
                  ? t(`${K}.topupTitle`, { place: placeLabel(place) })
                  : placeLabel(place)
                : ""}
            </TopbarTitle>
          </Topbar>
        </Header>
        <Scroll safeAreaBottom>
          <View direction="column" align="stretch" gap="lg" paddingY="md">
            {plans === null && !plansError ? (
              <View align="center" paddingY="lg">
                <Spinner />
              </View>
            ) : null}
            {plansError || orderError ? (
              <View paddingX="lg">
                <Text size="sm" muted align="center">
                  {orderError ?? plansError}
                </Text>
              </View>
            ) : null}
            {plans && plans.length === 0 ? (
              <View paddingX="lg">
                <Text size="sm" muted align="center">
                  {t(`${K}.noPlans`)}
                </Text>
              </View>
            ) : null}
            {plans && plans.length > 0 ? (
              <List>
                {plans.map((plan, index) => (
                  <Fragment key={plan.name}>
                    {index > 0 ? <ListSeparator /> : null}
                    <ListAction
                      accessibilityLabel={`${summary(plan)}, ${usd(plan.priceUsd)}`}
                      onPress={ordering ? undefined : () => buy(plan)}
                    >
                      <ListActionText>{summary(plan)}</ListActionText>
                      <ListActionTrailingText>
                        {ordering === plan.name ? t(`${K}.ordering`) : usd(plan.priceUsd)}
                      </ListActionTrailingText>
                    </ListAction>
                  </Fragment>
                ))}
              </List>
            ) : null}
            {plans && plans.length > 0 ? (
              <View paddingX="lg" direction="column" align="stretch" gap="xs">
                {extendTarget ? (
                  <Text size="sm" muted align="center">
                    {t(`${K}.extendNote`)}
                  </Text>
                ) : null}
                <Text size="sm" muted align="center">
                  {t(`${K}.payNote`)}
                </Text>
              </View>
            ) : null}
          </View>
        </Scroll>
      </DsSheetHost>

      {/* One bought eSIM: the data it has left, and how to install it. Nothing
          else: nadanada's identifiers and bundle bookkeeping stay out of the
          way (support has them, the order carries them). */}
      <DsSheetHost
        visible={visible && openEsim !== null}
        onClose={() => setOpenEsim(null)}
        mode="full"
      >
        <Header safeAreaTop chrome="canvas">
          <Topbar surface="transparent" layout="fluid">
            <TopbarLeading>
              <IconButton
                icon="chevron-left"
                variant="soft"
                accessibilityLabel={t("common.back")}
                onPress={() => setOpenEsim(null)}
              />
            </TopbarLeading>
            <TopbarTitle>{openEsim?.placeName ?? ""}</TopbarTitle>
          </Topbar>
        </Header>
        <Scroll safeAreaBottom>
          {openEsim
            ? (() => {
                const status = statuses[openEsim.iccid];
                const active = status?.bundles.filter((b) => b.state === "current") ?? [];
                const left = status ? currentDataLeft(status) : null;
                const unlimited = active.some((b) => b.unlimited);
                const endsAt = active.reduce<number | null>(
                  (soonest, bundle) =>
                    bundle.endsAt !== null && (soonest === null || bundle.endsAt < soonest)
                      ? bundle.endsAt
                      : soonest,
                  null,
                );
                const leftDays = daysLeft(endsAt, now);
                const queued = status?.bundles.some((b) => b.state === "next") ?? false;
                const quick = installUrlFor(openEsim);
                const parts = installParts(openEsim.install);
                return (
                  <View direction="column" align="stretch" gap="xl" paddingX="lg" paddingY="md">
                    {/* The data left: the one number this page exists for. */}
                    <View
                      variant="soft"
                      radius="lg"
                      paddingX="lg"
                      paddingY="lg"
                      direction="column"
                      align="stretch"
                      gap="xs"
                    >
                      <Text size="sm" muted>
                        {t(`${K}.dataTitle`)}
                      </Text>
                      {status ? (
                        <>
                          <Text size="xl" emphasis>
                            {unlimited
                              ? t(`${K}.unlimited`)
                              : left !== null
                                ? formatDataAmount(left)
                                : t(`${K}.noActivePlan`)}
                          </Text>
                          {leftDays !== null ? (
                            <Text size="sm" muted>
                              {t(leftDays === 1 ? `${K}.dayLeft` : `${K}.daysLeft`, {
                                count: leftDays,
                              })}
                            </Text>
                          ) : queued ? (
                            <Text size="sm" muted>
                              {t(`${K}.startsOnUse`, { place: openEsim.placeName })}
                            </Text>
                          ) : null}
                        </>
                      ) : (
                        <Spinner />
                      )}
                    </View>

                    {/* Install. One tap where nadanada gives a link; the QR
                        covers another device and the manual path. */}
                    {status?.installed ? (
                      <Text size="sm" muted>
                        {t(`${K}.installedSince`, {
                          date: status.firstInstalledAt
                            ? new Date(status.firstInstalledAt).toLocaleDateString()
                            : "",
                        })}
                      </Text>
                    ) : (
                      <View direction="column" align="stretch" gap="md">
                        <Text size="sm" emphasis muted>
                          {t(`${K}.installTitle`)}
                        </Text>
                        {quick ? (
                          <Button
                            size="lg"
                            variant="solid"
                            accent="lilac"
                            onPress={() => void Linking.openURL(quick).catch(() => {})}
                          >
                            <ButtonIcon name="download" />
                            <ButtonText>{t(`${K}.quickInstall`)}</ButtonText>
                          </Button>
                        ) : null}
                        {parts ? (
                          <AddressQrTile value={parts.activation}>
                            <Text size="sm" muted align="center">
                              {t(quick ? `${K}.installAnother` : `${K}.manualInstall`)}
                            </Text>
                          </AddressQrTile>
                        ) : !quick ? (
                          <Text size="sm" muted align="center">
                            {t(`${K}.noInstallData`)}
                          </Text>
                        ) : null}
                        <Text size="sm" emphasis>
                          {t(`${K}.afterInstalling`)}
                        </Text>
                        <Text size="sm" muted>
                          {t(`${K}.afterData`)}
                        </Text>
                        <Text size="sm" muted>
                          {t(`${K}.afterRoaming`)}
                        </Text>
                      </View>
                    )}

                    <Button
                      size="lg"
                      variant="solid"
                      accent="lilac"
                      onPress={() => startTopup(openEsim)}
                    >
                      <ButtonIcon name="plus" />
                      <ButtonText>{t(`${K}.addBundle`)}</ButtonText>
                    </Button>
                    {orderError ? (
                      <Text size="sm" muted align="center">
                        {orderError}
                      </Text>
                    ) : null}
                  </View>
                );
              })()
            : null}
        </Scroll>
      </DsSheetHost>
    </>
  );
};

export default EsimScreen;
