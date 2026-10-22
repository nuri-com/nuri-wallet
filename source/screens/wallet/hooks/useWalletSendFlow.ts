// screens/wallet/hooks/useWalletSendFlow.ts
// The Euro/Dollar transfer sheet's opening: who it pays (an address, or a
// payout abroad), an amount the code asked for, and which balance pays. The
// send flow decides those and opens the sheet at once, on top of the screen
// it came from, so nothing in between shows through.
//
// It owns no data: the amounts, balances and the actual transfer stay in the
// modal and the services it calls.
import { useCallback, useState } from "react";

import type { ZapRemitDestination } from "../../../lib/remit/zapremitForm";
import { isValidEvmAddress } from "../../../lib/validation";

export type WalletSendOpening = {
  rail: "wallet" | "dollar";
  address?: string;
  amount?: string | null;
  payout?: ZapRemitDestination;
};

export function useWalletSendFlow() {
  const [isSendToWalletVisible, setIsSendToWalletVisible] = useState(false);
  const [sendToWalletAddress, setSendToWalletAddress] = useState<string | null>(null);
  const [sendToWalletAmount, setSendToWalletAmount] = useState<string | null>(null);
  const [sendToWalletIsCard, setSendToWalletIsCard] = useState(false);
  // Which balance pays. Part of the same opening as the address and amount:
  // set only when the sheet opens, cleared with it.
  const [sendToWalletRail, setSendToWalletRail] = useState<"wallet" | "dollar" | null>(null);
  // A payout destination (a TanQR merchant, a bank abroad). Part of the same
  // opening as the address: set only when the sheet opens, cleared with it.
  const [sendToWalletPayout, setSendToWalletPayout] = useState<ZapRemitDestination | null>(null);

  /** Open the sheet on this recipient. False (nothing opens) for an invalid address. */
  const open = useCallback((opening: WalletSendOpening): boolean => {
    const address = opening.address?.trim() ?? null;
    if (!opening.payout && !(address && isValidEvmAddress(address))) return false;
    setSendToWalletAddress(opening.payout ? null : address);
    setSendToWalletAmount(opening.payout ? null : (opening.amount ?? null));
    setSendToWalletRail(opening.rail);
    setSendToWalletPayout(opening.payout ?? null);
    setSendToWalletIsCard(false);
    setIsSendToWalletVisible(true);
    return true;
  }, []);

  /**
   * Close every sheet this flow owns. The app-wide reset (biometric lock, a
   * factory reset, a deep link taking over) has to leave nothing open, with
   * no recipient or amount left in it.
   */
  const closeAll = useCallback(() => {
    setIsSendToWalletVisible(false);
    setSendToWalletAddress(null);
    setSendToWalletAmount(null);
    setSendToWalletRail(null);
    setSendToWalletPayout(null);
    setSendToWalletIsCard(false);
  }, []);

  return {
    open,
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
  };
}
