// screens/wirex/hooks/useWirexCardReveal.ts
// The reveal state machine behind WirexCardDetailsModal: which tab the sheet
// opens on, whether it is open, and the card secrets it renders. Extracted from
// its screen so every surface that opens that sheet drives it identically —
// there must never be a second copy of these generation guards.
//
// SECURITY: PAN / expiry / CVV / PIN live in this hook's state ONLY while the
// sheet is open. `close()` bumps a generation counter first, so a reveal still
// in flight (or the independent PIN poll, which can run up to ~2 minutes)
// cannot repopulate them afterwards, and a superseding reveal invalidates the
// previous one the same way. Nothing here is ever logged.
import { useCallback, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import { getEthereumAddress } from "../../../lib/secureKeyStorage";
import { reportErrorToSupport } from "../../../lib/support/reportErrorToSupport";
import { type WirexCardDetailsResult, wirexService } from "../../../services/wirex/WirexService";

export type WirexDetailsTab = "card" | "bank";

/** The card to reveal. */
export type WirexCardRevealTarget = { id: string };

export type WirexCardRevealState = {
  visible: boolean;
  initialTab: WirexDetailsTab;
  details: WirexCardDetailsResult | null;
  error: string | null;
  revealing: boolean;
  /** Open on a tab WITHOUT fetching secrets (bank tab, or a frozen card whose
   *  reveal Wirex would 400 — the sheet shows its unfreeze hint instead). */
  open: (tab: WirexDetailsTab) => void;
  /** Open on the card tab and fetch PAN/expiry/CVV. */
  reveal: (target: WirexCardRevealTarget) => Promise<void>;
  /** Close and drop everything sensitive. */
  close: () => void;
};

export function useWirexCardReveal(): WirexCardRevealState {
  const [visible, setVisible] = useState(false);
  const [initialTab, setInitialTab] = useState<WirexDetailsTab>("card");
  const [details, setDetails] = useState<WirexCardDetailsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  // Generation counter: invalidates a slow/superseded reveal so its async
  // result can't repopulate state after close or a newer reveal.
  const generationRef = useRef(0);

  const open = useCallback((tab: WirexDetailsTab) => {
    setInitialTab(tab);
    setVisible(true);
  }, []);

  const close = useCallback(() => {
    // Invalidate any in-flight reveal FIRST so a late resolution can't
    // repopulate what we clear below.
    generationRef.current += 1;
    setVisible(false);
    setError(null);
    setDetails(null); // don't keep PAN/expiry/CVV in memory after close
    setRevealing(false);
  }, []);

  const reveal = useCallback(async (target: WirexCardRevealTarget) => {
    if (!target.id) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    setInitialTab("card");
    setDetails(null);
    setError(null);
    setRevealing(true);
    setVisible(true); // open immediately; the sheet shows its loading state
    try {
      const wallet = await getEthereumAddress();
      if (!wallet) throw new Error("no_wallet");
      const cardId = target.id;
      const d = await wirexService.revealCardDetails({ wallet, cardId });
      // Superseded by a close or a newer reveal while we awaited: never
      // repopulate PAN/CVV.
      if (generationRef.current !== generation) return;
      setDetails(d);
    } catch (revealError) {
      // Never log the reveal payload or the error contents.
      if (generationRef.current === generation) {
        setDetails(null);
        setError(t("screen.WirexCard.detailsError"));
        void reportErrorToSupport({
          error: revealError,
          userMessage: "Card details reveal failed",
        }).catch(() => {});
      }
    } finally {
      if (generationRef.current === generation) setRevealing(false);
    }
  }, []);

  return { visible, initialTab, details, error, revealing, open, reveal, close };
}
