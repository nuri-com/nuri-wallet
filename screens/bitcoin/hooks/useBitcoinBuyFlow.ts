// screens/bitcoin/hooks/useBitcoinBuyFlow.ts
// Buying bitcoin through Mercuryo: when the checkout sheet is up, and which
// address the purchase settles to. Self-contained, so an "Add money" button on
// any screen can start it.
//
// The destination address is read from WalletService here rather than taken as
// a parameter: the host then needs no bitcoin wallet state of its own, and the
// sheet can never be handed an address that belongs to a different rail.
//
// It owns no purchase: once checkout opens, the order belongs to
// MercuryoPendingTracker and survives this sheet, the app being backgrounded,
// or the process dying in the browser.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { walletService } from "../../../services/bitcoin/WalletService";
import { EventBus } from "../../../services/events/AppEventBusService";

const subscribeAddress = (listener: () => void) => walletService.subscribeAddress(() => listener());
const getAddressSnapshot = () => walletService.getAddressSnapshot();

type Params = {
  /** False while the host screen is hidden — the sheet closes with it. */
  isActive?: boolean;
};

export function useBitcoinBuyFlow(p?: Params) {
  const isActive = p?.isActive ?? true;
  const [visible, setVisible] = useState(false);
  const addressState = useSyncExternalStore(subscribeAddress, getAddressSnapshot);

  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);

  // Reporting an error hands the user to the support chat, which App opens
  // app-side; a checkout sheet left in front of it would hide the conversation.
  useEffect(() => EventBus.on("support:report", close), [close]);

  useEffect(() => EventBus.on("ui:resetMainScreens", close), [close]);

  useEffect(() => {
    if (!isActive) close();
  }, [isActive, close]);

  return {
    visible,
    setVisible,
    open,
    close,
    /**
     * The Arkade-cosigned (v4) MuSig2 on-chain address — where a completed
     * purchase lands. Bought bitcoin goes to the on-chain wallet, not to the
     * arkade boarding address.
     */
    bitcoinAddress: addressState.musig2Address,
  };
}
