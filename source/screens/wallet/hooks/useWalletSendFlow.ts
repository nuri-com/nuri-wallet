// screens/wallet/hooks/useWalletSendFlow.ts
// The wallet's send flow: the choice sheet (card · bitcoin · someone else) and
// the recipient screen the third one opens. The first two land on the Move card,
// which is the app's one way to state a move between the user's own rails. Kept out of any one screen so the flow can be
// offered anywhere — the unified home drives it from a rail row — without a
// second copy of the branch logic (the Wirex AA lookup, the swap hand-off, the
// scanner).
//
// It owns no data: the amounts, balances and the actual transfer stay in the
// modals and services this only decides between.
//
// iOS cannot present a modal in the same tick another is dismissed (#522), so
// every hand-off goes through a short scheduled gap; the timer is cancelled on
// unmount and on `ui:resetMainScreens` so a late firing cannot reopen a sheet
// the user just closed.
import { useCallback, useEffect, useRef, useState } from "react";

import type { ZapRemitDestination } from "../../../lib/remit/zapremitForm";
import { Platform } from "react-native";
import { isValidEvmAddress } from "../../../lib/validation";
import { EventBus } from "../../../services/events/AppEventBusService";

const MODAL_PRESENTATION_DELAY = Platform.OS === "ios" ? 350 : 0;

type Params = {
  /** False while the host screen is hidden — cancels a pending hand-off. */
  isActive?: boolean;
};

export function useWalletSendFlow(p?: Params) {
  const isActive = p?.isActive ?? true;
  const [isSendToWalletVisible, setIsSendToWalletVisible] = useState(false);
  const [sendToWalletAddress, setSendToWalletAddress] = useState<string | null>(null);
  const [sendToWalletAmount, setSendToWalletAmount] = useState<string | null>(null);
  const [sendToWalletIsCard, setSendToWalletIsCard] = useState(false);
  // Which balance pays, when the scanned code decided it. Part of the same
  // opening as the address and amount: set only when the sheet opens, cleared
  // with it. Null = the screen the Send started from decides.
  const [sendToWalletRail, setSendToWalletRail] = useState<"wallet" | "dollar" | null>(null);
  const [showWalletScan, setShowWalletScan] = useState(false);
  // A payout destination the scanner named (a TanQR merchant). Part of the
  // same opening as the address: set only when the sheet opens, cleared with it.
  const [sendToWalletPayout, setSendToWalletPayout] = useState<ZapRemitDestination | null>(null);

  const modalHandoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingModalHandoff = useCallback(() => {
    if (modalHandoffTimerRef.current !== null) {
      clearTimeout(modalHandoffTimerRef.current);
      modalHandoffTimerRef.current = null;
    }
  }, []);

  const scheduleModalHandoff = useCallback(
    (open: () => void) => {
      clearPendingModalHandoff();
      modalHandoffTimerRef.current = setTimeout(() => {
        modalHandoffTimerRef.current = null;
        open();
      }, MODAL_PRESENTATION_DELAY);
    },
    [clearPendingModalHandoff],
  );

  useEffect(() => {
    if (!isActive) clearPendingModalHandoff();
  }, [isActive, clearPendingModalHandoff]);
  useEffect(() => clearPendingModalHandoff, [clearPendingModalHandoff]);

  useEffect(() => {
    const off = EventBus.on("ui:resetMainScreens", () => {
      clearPendingModalHandoff();
    });
    return off;
  }, [clearPendingModalHandoff]);

  // Send "To someone" from Cash: the recipient scanner.
  const startRecipientScan = useCallback(() => {
    scheduleModalHandoff(() => setShowWalletScan(true));
  }, [scheduleModalHandoff]);

  const handleWalletScanResult = useCallback(
    (addr: string, amount?: string | null, rail?: "wallet" | "dollar" | null): boolean => {
      if (!isValidEvmAddress(addr)) {
        console.log("[WalletSendFlow] Scanned address invalid");
        return false;
      }
      setSendToWalletAddress(addr.trim());
      setSendToWalletAmount(amount ?? null);
      setSendToWalletRail(rail ?? null);
      setSendToWalletPayout(null);
      setSendToWalletIsCard(false);
      setShowWalletScan(false);
      // Let the scanner close before its replacement enters the shared overlay.
      // Opening both in one tick can make the closing scanner tear down the send
      // sheet on web, dropping the recipient and amount it was meant to show.
      scheduleModalHandoff(() => setIsSendToWalletVisible(true));
      return true;
    },
    [scheduleModalHandoff],
  );

  // A TanQR scanned from Cash: the send sheet opens on that merchant, paid from
  // `rail`, after the same scanner hand-off as an address.
  const handleWalletPayoutScan = useCallback(
    (payout: ZapRemitDestination, rail: "wallet" | "dollar") => {
      setSendToWalletAddress(null);
      setSendToWalletAmount(null);
      setSendToWalletRail(rail);
      setSendToWalletPayout(payout);
      setSendToWalletIsCard(false);
      setShowWalletScan(false);
      scheduleModalHandoff(() => setIsSendToWalletVisible(true));
    },
    [scheduleModalHandoff],
  );

  /**
   * Close every sheet this flow owns. The app-wide reset (biometric lock, a
   * factory reset, a deep link taking over) has to leave nothing open, and
   * cancelling the hand-off timer alone left the sheets themselves on screen —
   * they reappeared after unlock, with the recipient and amount still in them.
   */
  const closeAll = useCallback(() => {
    clearPendingModalHandoff();
    setIsSendToWalletVisible(false);
    setSendToWalletAddress(null);
    setSendToWalletAmount(null);
    setSendToWalletRail(null);
    setSendToWalletPayout(null);
    setSendToWalletIsCard(false);
    setShowWalletScan(false);
  }, [clearPendingModalHandoff]);

  return {
    closeAll,
    isSendToWalletVisible,
    setIsSendToWalletVisible,
    sendToWalletAddress,
    setSendToWalletAddress,
    sendToWalletAmount,
    setSendToWalletAmount,
    sendToWalletIsCard,
    sendToWalletRail,
    setSendToWalletRail,
    sendToWalletPayout,
    setSendToWalletPayout,
    handleWalletPayoutScan,
    showWalletScan,
    setShowWalletScan,
    startRecipientScan,
    handleWalletScanResult,
  };
}
