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
import { Platform } from "react-native";
import { isValidEvmAddress } from "../../../lib/validation";
import { EventBus } from "../../../services/events/AppEventBusService";
import type { WalletSendChoiceKey } from "../../../types/wallet";

const MODAL_PRESENTATION_DELAY = Platform.OS === "ios" ? 350 : 0;

type Params = {
  /** False while the host screen is hidden — cancels a pending hand-off. */
  isActive?: boolean;
};

export function useWalletSendFlow(p?: Params) {
  const isActive = p?.isActive ?? true;
  const [isWalletSendChoiceVisible, setIsWalletSendChoiceVisible] = useState(false);
  const [isSendToWalletVisible, setIsSendToWalletVisible] = useState(false);
  const [sendToWalletAddress, setSendToWalletAddress] = useState<string | null>(null);
  const [sendToWalletAmount, setSendToWalletAmount] = useState<string | null>(null);
  const [sendToWalletIsCard, setSendToWalletIsCard] = useState(false);
  const [showWalletScan, setShowWalletScan] = useState(false);

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

  const handleSendPress = useCallback(() => {
    setIsWalletSendChoiceVisible(true);
  }, []);

  const handleWalletSendChoiceSelect = useCallback(
    (choice: WalletSendChoiceKey) => {
      setIsWalletSendChoiceVisible(false);
      if (choice === "wallet") {
        scheduleModalHandoff(() => setShowWalletScan(true));
        return;
      }
    },
    [scheduleModalHandoff],
  );

  const handleWalletScanResult = useCallback((addr: string, amount?: string | null) => {
    if (!isValidEvmAddress(addr)) {
      console.log("[WalletSendFlow] Scanned address invalid");
      return;
    }
    setSendToWalletAddress(addr.trim());
    setSendToWalletAmount(amount ?? null);
    setSendToWalletIsCard(false);
    setShowWalletScan(false);
    setIsSendToWalletVisible(true);
  }, []);

  /**
   * Close every sheet this flow owns. The app-wide reset (biometric lock, a
   * factory reset, a deep link taking over) has to leave nothing open, and
   * cancelling the hand-off timer alone left the sheets themselves on screen —
   * they reappeared after unlock, with the recipient and amount still in them.
   */
  const closeAll = useCallback(() => {
    clearPendingModalHandoff();
    setIsWalletSendChoiceVisible(false);
    setIsSendToWalletVisible(false);
    setSendToWalletAddress(null);
    setSendToWalletAmount(null);
    setSendToWalletIsCard(false);
    setShowWalletScan(false);
  }, [clearPendingModalHandoff]);

  return {
    closeAll,
    isWalletSendChoiceVisible,
    setIsWalletSendChoiceVisible,
    isSendToWalletVisible,
    setIsSendToWalletVisible,
    sendToWalletAddress,
    setSendToWalletAddress,
    sendToWalletAmount,
    setSendToWalletAmount,
    sendToWalletIsCard,
    showWalletScan,
    setShowWalletScan,
    handleSendPress,
    handleWalletSendChoiceSelect,
    handleWalletScanResult,
  };
}
