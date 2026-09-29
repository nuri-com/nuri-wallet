// @screen wirex.cardDetails
// Wirex card + bank details reveal. DS sheet with ListAction reveal rows.
// Composition: card actions (freeze, daily spending limit) are rows under the
// list, and the limit editor is an in-sheet sub-page with a back chevron.
// Tabs: Card (PAN / expiry / CVV + actions) and Bank (IBAN / BIC), showing only
// the fields that are present.
// SECURITY: sensitive values are masked by default; never logged or persisted.
import type React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyToClipboard } from "../../lib/copyToClipboard";
import {
  Alert,
  AlertButton,
  AlertIcon,
  Button,
  ButtonText,
  Footer,
  Header,
  type IconName,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailIcon,
  ListSeparator,
  Scroll,
  Text,
  Topbar,
  TopbarLeading,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import DsSheetHost from "../../components/DsSheetHost";
import { useReveal } from "../../components/sensitiveReveal";
import Spinner from "../../components/Spinner";
import { SwapTryAgainView } from "../../components/SwapProcessingView";
import { t } from "../../lib/i18n";
import { type WirexCardLimit, wirexService } from "../../services/wirex/WirexService";
import WirexCardLimitEditor from "./WirexCardLimitEditor";
import WirexCloseCardConfirm from "./WirexCloseCardConfirm";

type WirexDetailsTab = "card" | "bank";
type ActivePage = "details" | "limit" | "close";

type Props = {
  visible: boolean;
  onClose: () => void;
  initialTab?: WirexDetailsTab;
  loading?: boolean;
  error?: string | null;
  cardNumber: string | null;
  // The KYC'd name on the card / IBAN. Shown unmasked: it is not a secret, and
  // not knowing the exact spelling is what makes online checkouts fail.
  holderName?: string | null;
  expiry: string | null;
  cvv: string | null;
  iban: string | null;
  bic: string | null;
  wallet: string | null;
  cardId: string | null;
  isFrozen: boolean | null;
  freezeBusy?: boolean;
  freezeError?: boolean;
  onToggleFreeze?: () => void;
  // Issues an ADDITIONAL virtual card. Omitted → the CTA is not offered.
  onIssueNewCard?: () => void;
  issueBusy?: boolean;
  // PERMANENTLY closes the card this sheet is showing. Omitted → not offered.
  // Only ever called from the confirm page below.
  onCloseCard?: () => void;
  // Close attempt failed. Separate from freezeError so a failed close never
  // surfaces as an error on the details page (and vice versa).
  closeError?: boolean;
  // Asks the parent to fetch PAN/expiry/CVV. Fired once when the Card tab is
  // shown with no secrets yet (e.g. the modal was opened on the Bank tab).
  onRequestReveal?: () => void;
  // Manual "Add to Apple Wallet" (iOS; Wirex has no in-app provisioning).
  // Omitted → not offered. The Card tab keeps its own header button and does not
  // pass this; screens without that header get the row on the Card tab instead.
  onAddToWallet?: () => void;
  // Pin the sheet to `initialTab` and hide the segmented control. The unified
  // home lists IBAN and VISA as their OWN rows, so each one opens the side it
  // is about — switching between them there would contradict the row you tapped.
  lockTab?: boolean;
};

const REVEAL_MASK = "****";

type DetailRow = {
  key: string;
  icon: IconName;
  title: string;
  subtitle?: string;
  trailIcon?: IconName;
  onPress?: () => void;
};

function groupDigits(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

const WirexCardDetailsModal: React.FC<Props> = ({
  visible,
  onClose,
  initialTab,
  loading,
  error,
  cardNumber,
  holderName,
  expiry,
  cvv,
  iban,
  bic,
  wallet,
  cardId,
  isFrozen,
  freezeBusy,
  freezeError,
  onToggleFreeze,
  onIssueNewCard,
  issueBusy,
  onCloseCard,
  closeError,
  onRequestReveal,
  onAddToWallet,
  lockTab,
}) => {
  const { isRevealed, toggle, reset } = useReveal();
  const [tab, setTab] = useState<WirexDetailsTab>(initialTab ?? "card");
  const [page, setPage] = useState<ActivePage>("details");
  const [limit, setLimit] = useState<WirexCardLimit | null>(null);

  const loadLimit = useCallback(async () => {
    if (!wallet || !cardId) return;
    try {
      setLimit(await wirexService.getCardLimits(wallet, cardId));
    } catch {
      setLimit(null); // row falls back to the plain label; the editor still works
    }
  }, [wallet, cardId]);

  useEffect(() => {
    if (visible) {
      setTab(initialTab ?? "card");
      setPage("details");
      reset();
      void loadLimit();
    }
  }, [visible, initialTab, reset, loadLimit]);

  const handleClose = () => {
    onClose();
    reset();
  };

  const revealableRow = useCallback(
    (field: string, value: string, subtitle: string): DetailRow => ({
      key: field,
      icon: "card",
      title: isRevealed(field) ? value : REVEAL_MASK,
      subtitle,
      trailIcon: isRevealed(field) ? "eye" : "eye-hidden",
      onPress: () => toggle(field),
    }),
    [isRevealed, toggle],
  );

  const cardItems = useMemo(() => {
    const list: DetailRow[] = [];
    // First row on the tab: at an online checkout the name is asked for before
    // the number, and it is the field users cannot guess (Wirex holds no middle
    // name, so whatever is here is the complete name to type).
    if (holderName) {
      list.push({
        key: "holder",
        icon: "card",
        title: holderName,
        subtitle: t("screen.WirexCard.cardHolderLabel"),
        trailIcon: "copy",
        onPress: () => void copyToClipboard(holderName),
      });
    }
    if (cardNumber) {
      const grouped = groupDigits(cardNumber);
      list.push({
        key: "number",
        icon: "card",
        title: grouped,
        subtitle: t("screen.CardScreen.overlayCardNumberLabel"),
        trailIcon: "copy",
        onPress: () => void copyToClipboard(grouped.replace(/\s/g, "")),
      });
    }
    if (expiry) {
      list.push(revealableRow("expiry", expiry, t("screen.CardScreen.overlayExpiryLabel")));
    }
    if (cvv) {
      list.push(revealableRow("cvv", cvv, t("screen.CardScreen.overlayCvvLabel")));
    }
    return list;
  }, [holderName, cardNumber, expiry, cvv, revealableRow]);

  // Daily-limit row value, e.g. "€8000".
  const daily = limit?.daily_limit;
  const limitValue =
    typeof daily === "number" && daily >= 0
      ? (limit?.currency ?? "EUR") === "EUR"
        ? `EUR ${Math.round(daily)}`
        : `${limit?.currency} ${Math.round(daily)}`
      : null;

  const bankItems = useMemo(() => {
    const list: DetailRow[] = [];
    // Same name, different question: a SEPA sender has to match the holder on
    // the account, so the Bank tab must answer it without a detour to Card.
    if (holderName) {
      list.push({
        key: "accountHolder",
        icon: "bank",
        title: holderName,
        subtitle: t("screen.WirexCard.accountHolderLabel"),
        trailIcon: "copy",
        onPress: () => void copyToClipboard(holderName),
      });
    }
    if (iban) {
      list.push({
        key: "iban",
        icon: "bank",
        title: iban,
        subtitle: t("screen.WirexCard.ibanLabel"),
        trailIcon: "copy",
        onPress: () => void copyToClipboard(iban),
      });
    }
    if (bic) {
      list.push({
        key: "bic",
        icon: "bank",
        title: bic,
        subtitle: t("screen.WirexCard.bicLabel"),
        trailIcon: "copy",
        onPress: () => void copyToClipboard(bic),
      });
    }
    return list;
  }, [holderName, iban, bic]);

  // Card actions (freeze, daily limit) live under the list as rows. They only
  // need the card id — shown even when the secrets reveal failed, so the user
  // can always freeze the card.
  const showFreezeRow = Boolean(cardId && onToggleFreeze && isFrozen !== null);
  const limitRow: DetailRow | null = cardId
    ? {
        key: "limit",
        icon: "settings",
        title: limitValue ?? t("screen.CardLimitModal.title"),
        subtitle: limitValue ? t("screen.CardScreen.dailyLimitTitle") : undefined,
        trailIcon: "chevron-right",
        onPress: () => setPage("limit"),
      }
    : null;

  // Add-to-Wallet is an action on the card in hand, so it sits with the limit
  // row rather than in the footer — that slot holds ONE primary CTA (issue /
  // order / the close confirm), and a second button there has no room.
  const addToWalletRow: DetailRow | null =
    cardId && onAddToWallet
      ? {
          key: "addToWallet",
          icon: "wallet",
          title: t("screen.CardScreen.addToAppleWallet"),
          trailIcon: "chevron-right",
          onPress: onAddToWallet,
        }
      : null;

  // With no card there is nothing to reveal, freeze or limit — but issuing one is
  // still an action about the Card tab, and without the tab the footer CTA (gated
  // on it) would be unreachable. That is the only route left when the account's
  // last card was closed.
  const offersIssueOnly = !cardId && Boolean(onIssueNewCard);
  const hasCardTabContent =
    cardItems.length > 0 ||
    showFreezeRow ||
    limitRow !== null ||
    addToWalletRow !== null ||
    offersIssueOnly;
  const tabs = useMemo(() => {
    const list: { value: WirexDetailsTab; label: string }[] = [];
    if (hasCardTabContent) list.push({ value: "card", label: t("screen.WirexCard.tabCard") });
    if (bankItems.length) list.push({ value: "bank", label: t("screen.WirexCard.tabBank") });
    return list;
  }, [hasCardTabContent, bankItems.length]);

  // Locked: the caller's tab wins outright, even if that side has no rows yet
  // (a pending IBAN still belongs on the bank side, not silently on the card).
  const activeTab = lockTab
    ? (initialTab ?? "card")
    : tabs.some((x) => x.value === tab)
      ? tab
      : (tabs[0]?.value ?? "card");
  // The limit and add-to-wallet rows are shaped like the reveal rows (icon +
  // label + affordance), so they render inside the same list; only the freeze
  // and close alerts sit below.
  const cardTabRows = [...cardItems, limitRow, addToWalletRow].filter(
    (row): row is DetailRow => row !== null,
  );
  const items = activeTab === "card" ? cardTabRows : bankItems;

  const hasCardSecrets = Boolean(cardNumber || expiry || cvv);
  // Frozen cards can't reveal secrets (Wirex 400s), so the Card tab shows only
  // the freeze + limit rows plus a hint to unfreeze.
  const showFrozenRevealHint = activeTab === "card" && isFrozen === true && !hasCardSecrets;

  // Drive the reveal fetch when the Card tab is shown with no secrets yet — e.g.
  // the modal was opened on the Bank tab and the user switched to Card. Fired
  // once per open (ref guard) and only for an unfrozen card that isn't already
  // loading. Reset when the modal closes.
  const requestedRevealRef = useRef(false);
  useEffect(() => {
    if (!visible) {
      requestedRevealRef.current = false;
      return;
    }
    if (
      activeTab === "card" &&
      !hasCardSecrets &&
      loading !== true &&
      isFrozen !== true &&
      !requestedRevealRef.current
    ) {
      requestedRevealRef.current = true;
      onRequestReveal?.();
    }
  }, [visible, activeTab, hasCardSecrets, loading, isFrozen, onRequestReveal]);

  // Static heading — the current limit renders once, inside the page.
  const title =
    page === "limit"
      ? t("screen.CardLimitModal.title")
      : page === "close"
        ? t("screen.WirexCard.close.title")
        : t("screen.WirexCard.detailsTitle");

  const renderRows = (rows: DetailRow[]) => (
    <List>
      {rows.map((row, index) => (
        <Fragment key={row.key}>
          {index > 0 ? <ListSeparator /> : null}
          <ListAction accessibilityLabel={row.subtitle ?? row.title} onPress={row.onPress}>
            <ListActionLeadingAvatar name={row.icon} variant="outline" />
            <ListActionText>{row.title}</ListActionText>
            {row.subtitle ? <ListActionTextMuted>{row.subtitle}</ListActionTextMuted> : null}
            {row.trailIcon ? <ListActionTrailIcon name={row.trailIcon} /> : null}
          </ListAction>
        </Fragment>
      ))}
    </List>
  );

  const showIssueCta = page === "details" && !loading && activeTab === "card" && !!onIssueNewCard;
  // Closing is destructive and irreversible: it sits at the very bottom of the
  // Card tab, below freeze, and only opens the confirm page — never acts on tap.
  const showCloseAction =
    page === "details" && !loading && activeTab === "card" && Boolean(cardId) && !!onCloseCard;
  // The confirm itself sits in the footer, where every full-screen sheet puts its
  // primary action.
  const showCloseCta = page === "close" && !!onCloseCard;

  return (
    <DsSheetHost visible={visible} onClose={handleClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        {/* `centered` on the close page only: leading + trailing take equal
            lanes there, so the hugging title lands dead centre between the back
            and close buttons. The other pages keep `fluid` (growable title lane). */}
        <Topbar surface="transparent" layout={page === "close" ? "centered" : "fluid"}>
          {/* The chevron is only ever a step back INSIDE this sheet (limit and
              close pages). Leaving the sheet is the cross, top right, on every
              page — the one dismiss affordance every sheet in the app shows. */}
          {page !== "details" ? (
            <TopbarLeading>
              <IconButton
                icon="chevron-left"
                variant="soft"
                accessibilityLabel={t("common.back")}
                onPress={() => setPage("details")}
              />
            </TopbarLeading>
          ) : null}
          <TopbarTitle>{title}</TopbarTitle>
          <TopbarTrailing>
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel={t("common.close")}
              onPress={handleClose}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>

      <Scroll safeAreaBottom={!showIssueCta && !showCloseCta}>
        {/* The content column is full-bleed and each non-list child carries its
            own paddingX: List + ListAction already inset their rows by 18pt, so
            nesting the list in a lg-padded column pushed every row to 36pt while
            the tabs and the alert sat at 18pt. Same shape as ActivitySheet/FAQModal. */}
        <View direction="column" align="stretch" gap="lg" paddingBottom="lg">
          {page === "limit" ? (
            <View paddingX="lg">
              <WirexCardLimitEditor cardId={cardId} limit={limit} onRefresh={loadLimit} />
            </View>
          ) : page === "close" ? (
            <View paddingX="lg">
              <WirexCloseCardConfirm error={closeError} />
            </View>
          ) : loading ? (
            <View direction="column" align="center" paddingY="xl">
              <Spinner />
            </View>
          ) : (
            <>
              {tabs.length > 1 && !lockTab ? (
                // Segmented control composed from DS Buttons: selected = solid,
                // unselected = soft.
                <View direction="row" gap="sm" distribute="even" paddingX="lg">
                  {tabs.map((x) => (
                    <Button
                      key={x.value}
                      size="sm"
                      variant={activeTab === x.value ? "solid" : "soft"}
                      onPress={() => setTab(x.value)}
                      accessibilityLabel={x.label}
                    >
                      <ButtonText>{x.label}</ButtonText>
                    </Button>
                  ))}
                </View>
              ) : null}
              {showFrozenRevealHint ? (
                <View paddingX="lg">
                  <Text size="md" muted align="center">
                    {t("screen.WirexCard.frozenRevealHint")}
                  </Text>
                </View>
              ) : null}
              {error && activeTab === "card" && !hasCardSecrets ? (
                // Reveal failed (Wirex rejected or the poll errored): the shared
                // try-again state instead of the secrets rows. Freeze/limit rows
                // below stay reachable; retry re-runs the signed reveal.
                <View paddingX="lg">
                  <SwapTryAgainView inline onRetry={() => onRequestReveal?.()} />
                </View>
              ) : null}
              {items.length ? renderRows(items) : null}
              {activeTab === "card" && showFreezeRow ? (
                <View paddingX="lg">
                  {isFrozen === true ? (
                    <Alert variant="soft" accent="orange">
                      <AlertIcon name="warning-circle" />
                      {t("screen.WirexCard.frozenAlert")}
                      <AlertButton
                        accessibilityLabel={t("actions.card.unfreeze")}
                        disabled={freezeBusy}
                        onPress={() => onToggleFreeze?.()}
                      >
                        {t("actions.card.unfreeze")}
                      </AlertButton>
                    </Alert>
                  ) : (
                    // Mirror of the frozen-state Alert above: state text + a real
                    // button, so the freeze action reads as actionable (list rows
                    // stay reserved for data).
                    <Alert variant="soft" accent="neutral">
                      <AlertIcon name="card" />
                      {t("screen.WirexCard.activeAlert")}
                      <AlertButton
                        accessibilityLabel={t("actions.card.freeze")}
                        disabled={freezeBusy}
                        onPress={() => onToggleFreeze?.()}
                      >
                        {t("actions.card.freeze")}
                      </AlertButton>
                    </Alert>
                  )}
                </View>
              ) : null}
              {freezeError ? (
                <View paddingX="lg">
                  <Text size="md" muted align="center">
                    {t("screen.WirexCard.actionError")}
                  </Text>
                </View>
              ) : null}
              {showCloseAction ? (
                // Same shape as the freeze alert above — state line + action —
                // so the two read as one family; orange marks it destructive.
                // Opens the confirm page; it never closes the card on tap.
                <View paddingX="lg">
                  <Alert variant="soft" accent="orange">
                    <AlertIcon name="warning-circle" />
                    {t("screen.WirexCard.close.alert")}
                    <AlertButton
                      accessibilityLabel={t("screen.WirexCard.close.title")}
                      disabled={freezeBusy}
                      onPress={() => setPage("close")}
                    >
                      {t("screen.WirexCard.close.title")}
                    </AlertButton>
                  </Alert>
                </View>
              ) : null}
            </>
          )}
        </View>
      </Scroll>

      {showIssueCta || showCloseCta ? (
        <Footer safeAreaBottom direction="column" align="stretch" paddingBottom="sm" paddingX="lg">
          {showCloseCta ? (
            <Button
              size="lg"
              variant="solid"
              accent="orange"
              disabled={freezeBusy}
              onPress={() => onCloseCard?.()}
              accessibilityLabel={t("screen.WirexCard.close.confirm")}
            >
              <ButtonText>{t("screen.WirexCard.close.confirm")}</ButtonText>
            </Button>
          ) : null}
          {showIssueCta ? (
            <Button
              size="lg"
              variant="solid"
              accent="lilac"
              disabled={issueBusy}
              onPress={onIssueNewCard}
              accessibilityLabel={t("screen.WirexCard.issueNewCard")}
            >
              <ButtonText>{t("screen.WirexCard.issueNewCard")}</ButtonText>
            </Button>
          ) : null}
        </Footer>
      ) : null}
    </DsSheetHost>
  );
};

export default WirexCardDetailsModal;
