// screens/wirex/hooks/useWirexCardLifecycle.tsx
// Everything a user can do with the card itself: revealing it, issuing an
// ADDITIONAL virtual card and closing one — plus the
// manual Apple Wallet add. A screen mounts the card with nothing but the
// useWirexCard() snapshot; the rules deciding whether an action is offered at
// all (replay-unresolved issuance, a last4 the server will accept, iOS) must
// exist exactly once.
//
// Every action targets the ACCOUNT's card — the pick the
// service already made. There is no selection to make: the home lists one VISA
// rail, and that rail is that card.
//
// It also owns the two sheets that hold card secrets — the reveal and the Apple
// Wallet helper — so a screen gets one `closeAll()` for its reset path instead
// of having to remember each of them.
//
// SECURITY: no card data is stored here. PAN / expiry / CVV / PIN stay inside
// useWirexCardReveal / useWirexAppleWallet, in memory only while their sheet is
// open, with the generation guards those hooks own. Nothing here is logged.
//
// .tsx rather than .ts: closing a card confirms itself with a DS Alert rendered
// into the toast host — the sheet is gone by then and the card silently drops
// out of the account, so that toast is the only confirmation the close landed.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, AlertIcon, useToast } from "@ds";
import { t } from "../../../lib/i18n";
import { isWirexCardLast4 } from "../../../lib/wirex/cardActionMessage";
import { isAwaitingReplacementCard, isWirexCardReady } from "../../../lib/wirex/cardState";
import { wirexAccountService } from "../../../services/wirex/WirexAccountService";
import { type WirexAppleWalletState, useWirexAppleWallet } from "./useWirexAppleWallet";
import { type WirexCardRevealState, useWirexCardReveal } from "./useWirexCardReveal";
import type { WirexCardState } from "./useWirexCard";

/** The account's card, as every action here needs it. */
export type WirexActiveCard = {
  id: string;
  last4: string | null;
  isFrozen: boolean;
};

const PLACEHOLDER_CARD: WirexActiveCard = {
  id: "wirex-card",
  last4: null,
  isFrozen: false,
};

/** The WirexCardDetailsModal props this hook drives. Spread into the sheet. */
export type WirexCardLifecycleDetailsProps = {
  issueBusy: boolean;
  onIssueNewCard?: () => void;
  closeError: boolean;
  onCloseCard?: () => void;
};

export type WirexCardLifecycle = {
  /** The account's card. Null before the first read establishes one. */
  activeCard: WirexActiveCard | null;
  /** Reveal the account card's secrets. */
  revealCard: () => Promise<void>;
  reveal: WirexCardRevealState;
  appleWallet: WirexAppleWalletState;
  /** Manual "Add to Apple Wallet". Undefined → the entry point is not offered. */
  openAppleWallet: (() => void) | undefined;
  detailsProps: WirexCardLifecycleDetailsProps;
  /** Drop every sheet this hook owns (tab switch / screen reset). */
  closeAll: () => void;
};

export function useWirexCardLifecycle(snapshot: WirexCardState): WirexCardLifecycle {
  // Top-anchored, auto-dismissing DS toast (same runtime as the Copied toast).
  const toast = useToast();
  // The details sheet's open/tab state and its card secrets, including the
  // generation guards that keep a slow reveal from repopulating them after close.
  const reveal = useWirexCardReveal();
  // Apple Wallet helper (manual add). SECURITY: PAN/expiry/CVV held in memory
  // only while the sheet is open, cleared on close — same posture as the reveal.
  const appleWallet = useWirexAppleWallet();
  // Close-attempt failure, shown only on the close confirm page. Kept here (not
  // in the service's actionError) so it can't leak into the freeze alert.
  const [closeError, setCloseError] = useState(false);

  const cardReady = isWirexCardReady(snapshot);
  const awaitingReplacementCard = isAwaitingReplacementCard(snapshot);

  // The account's card. `cards` carries the per-card frozen flag, so prefer the
  // entry matching the service's own pick; a snapshot from an
  // older app version has no `cards` and falls back to the pick itself.
  // Memoised: a fresh object each render flows into revealCard, and a caller's
  // effect keyed on it would then re-run forever.
  const activeCard: WirexActiveCard | null = useMemo(() => {
    const primaryId = snapshot.card?.id;
    const listed = primaryId ? snapshot.cards.find((c) => c.id === primaryId) : snapshot.cards[0];
    if (listed) return listed;
    if (!primaryId) return null;
    return {
      ...PLACEHOLDER_CARD,
      id: primaryId,
      last4: snapshot.card?.last4 ?? null,
      isFrozen: snapshot.isFrozen === true,
    };
  }, [snapshot.cards, snapshot.card?.id, snapshot.card?.last4, snapshot.isFrozen]);

  // Both error flags are service/hook-lifetime, so a failure from a previous
  // visit would still be on screen when the sheet is reopened. Clear on open.
  useEffect(() => {
    if (!reveal.visible) return;
    setCloseError(false);
    wirexAccountService.clearActionError();
  }, [reveal.visible]);

  const revealCard = useCallback(async () => {
    if (!activeCard?.id || !snapshot.card?.id) return;
    void snapshot.silentRefetch();
    await reveal.reveal({ id: activeCard.id });
  }, [activeCard, snapshot.card?.id, snapshot.silentRefetch, reveal.reveal]);

  // Manual "Add to wallet": reveal the PAN (one biometric signing), auto-copy it
  // so the paste is ready, and show the manual steps. Wirex has no in-app
  // provisioning anywhere, so every platform does the same thing — copy the
  // number and open the wallet app — and the row is offered wherever there is a
  // usable card to add.
  const openAppleWallet = useMemo<(() => void) | undefined>(() => {
    if (!cardReady) return undefined;
    const cardId = activeCard?.id;
    if (!cardId || !snapshot.card?.id) return undefined;
    return () => void appleWallet.open(cardId);
  }, [cardReady, activeCard?.id, snapshot.card?.id, appleWallet.open]);

  const issueNewCard = useCallback(() => {
    void snapshot.issueVirtualCard().then((ok) => {
      // The new card is in the refreshed snapshot behind the sheet.
      if (ok) reveal.close();
    });
  }, [snapshot.issueVirtualCard, reveal.close]);

  const closeActiveCard = useCallback(() => {
    const cardId = activeCard?.id;
    if (!cardId) return;
    const last4 = activeCard?.last4 ?? "";
    setCloseError(false);
    void snapshot.closeCard(cardId, last4).then((ok) => {
      if (!ok) {
        setCloseError(true);
        return;
      }
      // The closed card is gone from the refreshed snapshot, so the sheet would
      // be pointing at a card that no longer exists.
      reveal.close();
      // The sheet disappears and the card silently drops out of the account —
      // the toast is the only confirmation the close actually landed.
      toast.show(
        <Alert variant="soft" accent="neutral">
          <AlertIcon name="check-circle" />
          {t("screen.WirexCard.close.success")}
        </Alert>,
      );
    });
  }, [activeCard?.id, activeCard?.last4, snapshot.closeCard, reveal.close, toast]);

  const detailsProps = useMemo<WirexCardLifecycleDetailsProps>(
    () => ({
      issueBusy: snapshot.actionBusy,
      onIssueNewCard:
        // Withheld while an earlier issuance is unresolved: a retry signs a fresh
        // request, and replay protection is per signature, so tapping again
        // before the outcome is known can produce a second card.
        (cardReady || awaitingReplacementCard) && !snapshot.issueUnresolved
          ? issueNewCard
          : undefined,
      closeError,
      onCloseCard:
        // Offered only with the digits in hand: they are signed and verified
        // server-side (format first — `last4_must_be_4_digits`), so a card whose
        // last4 we can't show as four digits can't be closed.
        activeCard?.id && isWirexCardLast4(activeCard.last4) ? closeActiveCard : undefined,
    }),
    [
      snapshot.actionBusy,
      snapshot.issueUnresolved,
      cardReady,
      awaitingReplacementCard,
      closeError,
      activeCard?.id,
      activeCard?.last4,
      issueNewCard,
      closeActiveCard,
    ],
  );

  const closeAll = useCallback(() => {
    // Invalidate any in-flight reveal and drop sensitive card data.
    reveal.close();
    appleWallet.close(); // the Apple-Wallet helper carries PAN/expiry/CVV
  }, [reveal.close, appleWallet.close]);

  return {
    activeCard,
    revealCard,
    reveal,
    appleWallet,
    openAppleWallet,
    detailsProps,
    closeAll,
  };
}
