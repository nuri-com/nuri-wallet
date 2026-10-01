// @screen app.esim
// eSIM — opened from Settings. Buys a data eSIM from nadanada.me with Bitcoin
// over Lightning (no account; Nuri's referral code rides on every order) and
// keeps the eSIMs this wallet bought: install QR, install link, data left.
//
// Paying is NOT done here: a plan's invoice is handed to the regular Bitcoin
// send sheet (onPayInvoice), the same one a scanned Lightning invoice opens.
// The order is persisted before that hand-off and claimed by its payment hash,
// so an eSIM paid for is fetched whenever this screen is open, including after
// a restart or on a restored wallet.
import type * as React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  NuriSafeAreaProvider,
  SelectField,
  SelectFieldChevron,
  SelectFieldLabel,
  SelectFieldValue,
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
  createEsimOrder,
  createEsimTopup,
  currentEsims,
  getEsimPlaces,
  getEsimPlans,
  getEsimStatus,
  loadEsims,
  onEsimToppedUp,
  subscribeEsims,
} from "../../services/esim/EsimService";
import ChoiceSheet from "../../components/ChoiceSheet";
import { EventBus } from "../../services/events/AppEventBusService";
import {
  type EsimBundle,
  type EsimBundleState,
  type EsimPendingOrder,
  type EsimPlace,
  type EsimPlan,
  type EsimRecord,
  type EsimStatus,
  type OwnedEsim,
  currentDataLeft,
  daysLeft,
  esimDashboardUrl,
  filterPlaces,
  formatDataAmount,
  installParts,
  planSummary,
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

type InstallMethod = "iphone" | "android" | "graphene" | "qr";
const INSTALL_METHODS: InstallMethod[] = ["iphone", "android", "graphene", "qr"];

/** The guide the device itself needs; the QR (for a second device) elsewhere. */
function defaultInstallMethod(): InstallMethod {
  if (Platform.OS === "ios") return "iphone";
  if (Platform.OS === "android") return "android";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iphone";
  return "qr";
}

const BUNDLE_STATES: EsimBundleState[] = ["current", "next", "expired"];

function BundleCard({ bundle, now }: { bundle: EsimBundle; now: number }) {
  const left = daysLeft(bundle.endsAt, now);
  return (
    <View
      variant="soft"
      radius="lg"
      paddingX="lg"
      paddingY="md"
      direction="column"
      align="stretch"
      gap="xs"
    >
      <View direction="row" align="center" gap="sm">
        <View fill="grow-shrink">
          <Text size="md" emphasis>
            {bundleSummary(bundle.name)}
          </Text>
        </View>
        <Text size="sm">{t(`${K}.state_${bundle.state}`)}</Text>
      </View>
      <Text size="sm">
        {bundle.unlimited
          ? t(`${K}.unlimited`)
          : t(`${K}.usage`, {
              used: formatDataAmount(bundle.usedBytes),
              total: formatDataAmount(bundle.totalBytes),
            })}
      </Text>
      {bundle.state === "current" && left !== null ? (
        <Text size="sm" muted>
          {t(left === 1 ? `${K}.dayLeft` : `${K}.daysLeft`, { count: left })}
        </Text>
      ) : bundle.state === "next" ? (
        <Text size="sm" muted>
          {t(`${K}.startsOnArrival`)}
        </Text>
      ) : null}
    </View>
  );
}

/** One copyable value of the manual install (SM-DP+, code, full string). */
function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <View
      variant="soft"
      radius="lg"
      paddingX="lg"
      paddingY="md"
      direction="row"
      align="center"
      gap="sm"
    >
      <View fill="grow-shrink" direction="column" align="stretch" gap="xs">
        <Text size="sm" muted>
          {label}
        </Text>
        <Text size="md" mono flow="wrap">
          {value}
        </Text>
      </View>
      <IconButton
        icon="copy"
        variant="ghost"
        accessibilityLabel={`${t("common.copy")} ${label}`}
        onPress={() => void copyToClipboard(value)}
      />
    </View>
  );
}

function Steps({ steps, start = 1 }: { steps: string[]; start?: number }) {
  return (
    <View direction="column" align="stretch" gap="xs">
      {steps.map((step, index) => (
        <Text key={step} size="sm">{`${start + index}. ${step}`}</Text>
      ))}
    </View>
  );
}

/** nadanada's installation guide, per method, with the codes inline. */
function InstallGuide({ esim, method }: { esim: OwnedEsim; method: InstallMethod }) {
  const parts = installParts(esim.install);
  const quick =
    method === "iphone"
      ? esim.install.appleInstallUrl
      : method === "android"
        ? esim.install.androidInstallUrl
        : undefined;
  const after = <Steps steps={[t(`${K}.afterData`), t(`${K}.afterRoaming`)]} />;
  return (
    <View direction="column" align="stretch" gap="md">
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
      {method === "qr" && parts ? (
        <>
          <AddressQrTile value={parts.activation}>
            <Text size="sm" muted align="center">
              {t(`${K}.scanHint`)}
            </Text>
          </AddressQrTile>
          <Text size="sm" emphasis>
            {t(`${K}.afterInstalling`)}
          </Text>
          {after}
        </>
      ) : null}
      {method === "iphone" ? (
        <>
          {quick ? (
            <Text size="sm" muted>
              {t(`${K}.orManually`)}
            </Text>
          ) : null}
          <Steps
            steps={[t(`${K}.iphone1`), t(`${K}.iphone2`), t(`${K}.iphone3`), t(`${K}.iphone4`)]}
          />
          {parts?.smdpAddress ? (
            <CopyField label={t(`${K}.smdp`)} value={parts.smdpAddress} />
          ) : null}
          {parts?.activationCode ? (
            <CopyField label={t(`${K}.code`)} value={parts.activationCode} />
          ) : null}
          <Steps start={5} steps={[t(`${K}.iphone5`)]} />
        </>
      ) : null}
      {method === "android" ? (
        <>
          {quick ? (
            <Text size="sm" muted>
              {t(`${K}.orManually`)}
            </Text>
          ) : null}
          <Steps
            steps={[
              t(`${K}.android1`),
              t(`${K}.android2`),
              t(`${K}.android3`),
              t(`${K}.android4`),
              t(`${K}.android5`),
            ]}
          />
          {parts ? <CopyField label={t(`${K}.fullString`)} value={parts.activation} /> : null}
          <Steps
            start={6}
            steps={[t(`${K}.android6`), t(`${K}.afterData`), t(`${K}.afterRoaming`)]}
          />
        </>
      ) : null}
      {method === "graphene" ? (
        <>
          <Steps
            steps={[
              t(`${K}.graphene1`),
              t(`${K}.graphene2`),
              t(`${K}.graphene3`),
              t(`${K}.graphene4`),
            ]}
          />
          {parts ? <CopyField label={t(`${K}.fullString`)} value={parts.activation} /> : null}
          {parts?.smdpAddress ? (
            <CopyField label={t(`${K}.smdp`)} value={parts.smdpAddress} />
          ) : null}
          {parts?.activationCode ? (
            <CopyField label={t(`${K}.code`)} value={parts.activationCode} />
          ) : null}
          <Steps start={5} steps={[t(`${K}.grapheneAfter`)]} />
        </>
      ) : null}
      {method !== "qr" && !parts && !quick ? (
        <Text size="sm" muted>
          {t(`${K}.noInstallData`)}
        </Text>
      ) : null}
    </View>
  );
}

const EsimScreen: React.FC<Props> = ({ visible, onClose, onPayInvoice }) => {
  const insets = useSafeAreaInsets();
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
  const [installMethod, setInstallMethod] = useState<InstallMethod>(defaultInstallMethod);
  const [methodPicker, setMethodPicker] = useState(false);
  const [bundleTab, setBundleTab] = useState<EsimBundleState>("current");
  /** Set while picking a plan to add to this owned eSIM (top-up). */
  const [topupFor, setTopupFor] = useState<OwnedEsim | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const homeCountry = useMemo(() => Localization.getLocales()[0]?.regionCode ?? null, []);

  useEffect(() => subscribeEsims(setRecord), []);

  // Fresh state on every open; the record itself is the service's.
  useEffect(() => {
    if (!visible) {
      setQuery("");
      setPlace(null);
      setOpenEsim(null);
      setTopupFor(null);
      setMethodPicker(false);
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
    setBundleTab("current");
    setInstallMethod(defaultInstallMethod());
    setOpenEsim(esim);
  }, []);

  // Top-up: the eSIM's own place (country or region), plans as for a new one.
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

  const buy = useCallback(
    (plan: EsimPlan) => {
      if (!place || ordering) return;
      setOrdering(plan.name);
      setOrderError(null);
      const order = topupFor
        ? createEsimTopup(topupFor, place, plan)
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
    [place, ordering, onPayInvoice, topupFor],
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
  const hasMine = record.esims.length > 0 || openOrders.length > 0;

  return (
    <>
      <Layer visible={visible} onRequestClose={onClose}>
        <NuriSafeAreaProvider top={insets.top} bottom={insets.bottom}>
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
                      <List>
                        {/* No tap on a pending order: its payment may already be
                            in flight, and a second send of the same invoice
                            would lock sats nobody can claim. */}
                        {openOrders.map((order, index) => (
                          <Fragment key={order.paymentHash}>
                            {index > 0 ? <ListSeparator /> : null}
                            {(() => {
                              const slow =
                                order.paidAt !== undefined && now - order.paidAt > SLOW_DELIVERY_MS;
                              const label = slow
                                ? t(`${K}.slow`)
                                : order.paidAt !== undefined
                                  ? t(`${K}.delivering`)
                                  : t(`${K}.pending`);
                              return (
                                <ListAction
                                  accessibilityLabel={`${order.placeName}, ${label}`}
                                  onPress={slow ? () => openSupport(order) : undefined}
                                >
                                  <ListActionText>{order.placeName}</ListActionText>
                                  <ListActionTextMuted>
                                    {bundleSummary(order.bundleName)}
                                  </ListActionTextMuted>
                                  <ListActionTrailingText>{label}</ListActionTrailingText>
                                  {slow ? <ListActionTrailIcon name="chevron-right" /> : null}
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
                              {index > 0 || openOrders.length > 0 ? <ListSeparator /> : null}
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
                            <ListAction accessibilityLabel={p.name} onPress={() => openPlace(p)}>
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
        </NuriSafeAreaProvider>
      </Layer>

      {/* Plans for one country or region, cheapest first; a tap orders it and
          hands the invoice to the Bitcoin send sheet. */}
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
                ? topupFor
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
              <View paddingX="lg">
                <Text size="sm" muted align="center">
                  {t(`${K}.payNote`)}
                </Text>
              </View>
            ) : null}
          </View>
        </Scroll>
      </DsSheetHost>

      {/* One bought eSIM: install it (link or QR), its code, data left. */}
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
                const counts = Object.fromEntries(
                  BUNDLE_STATES.map((state) => [
                    state,
                    status?.bundles.filter((b) => b.state === state).length ?? 0,
                  ]),
                ) as Record<EsimBundleState, number>;
                const bundles = status?.bundles.filter((b) => b.state === bundleTab) ?? [];
                return (
                  <View direction="column" align="stretch" gap="xl" paddingX="lg" paddingY="md">
                    {/* Install: the guide for this device first, others one tap away. */}
                    <View direction="column" align="stretch" gap="md">
                      <Text size="sm" emphasis muted>
                        {status?.installed
                          ? t(`${K}.installedSince`, {
                              date: status.firstInstalledAt
                                ? new Date(status.firstInstalledAt).toLocaleDateString()
                                : "",
                            })
                          : t(`${K}.installTitle`)}
                      </Text>
                      <SelectField
                        onPress={() => setMethodPicker(true)}
                        accessibilityLabel={t(`${K}.installMethod`)}
                        accessibilityValue={t(`${K}.method_${installMethod}`)}
                      >
                        <SelectFieldLabel>{t(`${K}.installMethod`)}</SelectFieldLabel>
                        <SelectFieldValue>{t(`${K}.method_${installMethod}`)}</SelectFieldValue>
                        <SelectFieldChevron name="caret-down" />
                      </SelectField>
                      <InstallGuide esim={openEsim} method={installMethod} />
                    </View>

                    {/* Bundles, like nadanada's own page: current, next, expired. */}
                    <View direction="column" align="stretch" gap="md">
                      <Text size="sm" emphasis muted>
                        {t(`${K}.bundles`)}
                      </Text>
                      {status ? (
                        <>
                          <View direction="row" gap="sm" distribute="even">
                            {BUNDLE_STATES.map((state) => (
                              <Button
                                key={state}
                                size="sm"
                                variant={bundleTab === state ? "solid" : "soft"}
                                accent={bundleTab === state ? "lilac" : undefined}
                                onPress={() => setBundleTab(state)}
                              >
                                <ButtonText>
                                  {t(`${K}.tab_${state}`, { count: counts[state] })}
                                </ButtonText>
                              </Button>
                            ))}
                          </View>
                          {bundles.length > 0 ? (
                            bundles.map((bundle, index) => (
                              <BundleCard
                                key={`${bundle.name}:${index}`}
                                bundle={bundle}
                                now={now}
                              />
                            ))
                          ) : (
                            <Text size="sm" muted align="center">
                              {t(`${K}.noBundles`)}
                            </Text>
                          )}
                        </>
                      ) : (
                        <View align="center" paddingY="md">
                          <Spinner />
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

                    <List>
                      <ListAction
                        accessibilityLabel={t(`${K}.dashboard`)}
                        onPress={() =>
                          void Linking.openURL(esimDashboardUrl(openEsim.iccid)).catch(() => {})
                        }
                      >
                        <ListActionText>{t(`${K}.dashboard`)}</ListActionText>
                        <ListActionTrailIcon name="chevron-right" />
                      </ListAction>
                      <ListSeparator />
                      <ListAction
                        accessibilityLabel={t(`${K}.iccid`)}
                        onPress={() => void copyToClipboard(openEsim.iccid)}
                      >
                        <ListActionText>{t(`${K}.iccid`)}</ListActionText>
                        <ListActionTrailingText>{openEsim.iccid}</ListActionTrailingText>
                        <ListActionTrailIcon name="copy" />
                      </ListAction>
                    </List>
                  </View>
                );
              })()
            : null}
        </Scroll>
      </DsSheetHost>

      <ChoiceSheet<InstallMethod>
        visible={visible && openEsim !== null && methodPicker}
        onClose={() => setMethodPicker(false)}
        title={t(`${K}.installMethod`)}
        items={INSTALL_METHODS.map((method) => ({
          key: method,
          label: t(`${K}.method_${method}`),
          ...(method === installMethod ? { sublabel: t("screen.Settings.selected") } : {}),
        }))}
        onSelect={(method) => {
          setMethodPicker(false);
          setInstallMethod(method);
        }}
      />
    </>
  );
};

export default EsimScreen;
