// @screen bitcoin.receive
// Bitcoin receive for ONE named rail. The rail is a prop rather than "whatever
// the host has selected", so a screen that lists both bitcoin balances can open
// the address belonging to the row the user tapped.
//
// "instant" is the Arkade boarding address, "onchain" the MuSig2 address. The
// instant rail generates its address on demand: a user who never received
// before has none until something asks for one.
//
// Everything received on the instant rail lands in Arkade, and an offboard can
// exit to any bitcoin address, so the two rails are separate destinations and
// never a fallback for each other.
import React, { useCallback, useEffect, useSyncExternalStore } from "react";
import ReceiveModal from "../../../components/ReceiveModal";
import { t } from "../../../lib/i18n";
import { walletService } from "../../../services/bitcoin/WalletService";

export type BitcoinReceiveRail = "instant" | "onchain";

type Props = {
  visible: boolean;
  /** Which bitcoin balance the shown address pays into. */
  rail: BitcoinReceiveRail;
  onClose: () => void;
};

const subscribeAddress = (listener: () => void) => walletService.subscribeAddress(() => listener());
const getAddressSnapshot = () => walletService.getAddressSnapshot();

const BitcoinReceiveModal: React.FC<Props> = ({ visible, rail, onClose }) => {
  const addressState = useSyncExternalStore(subscribeAddress, getAddressSnapshot);
  const isInstant = rail === "instant";
  const address = isInstant ? addressState.currentAddress : addressState.musig2Address;
  // Only the instant rail is derived here, so only it can fail here.
  const addressError = isInstant ? addressState.addressError : "";

  useEffect(() => {
    // Only the instant rail is generated on demand; the MuSig2 address exists
    // once its wallet does and cannot be minted from here. A failed attempt is
    // not retried automatically — the user's tap is the retry, otherwise the
    // effect would spin against a wallet that cannot be built.
    if (!visible || !isInstant || address || addressError) return;
    void walletService.generateNewAddress();
  }, [visible, isInstant, address, addressError]);

  const retryAddress = useCallback(() => {
    void walletService.generateNewAddress();
  }, []);

  return (
    <ReceiveModal
      visible={visible}
      onClose={onClose}
      title={t("screen.BitcoinReceiveModal.title")}
      primary={{
        // The instant rail keeps the plain "Bitcoin address" wording it is
        // shown with everywhere; the on-chain rail names itself, because it
        // only appears where both rails are on offer.
        label: isInstant
          ? t("screen.BitcoinReceiveModal.bitcoinAddressLabel")
          : t("screen.BitcoinReceiveModal.onchainAddressLabel"),
        value: address,
      }}
      isGenerating={addressState.isGeneratingAddress}
      emptyText={t("screen.BitcoinReceiveModal.walletGettingReady")}
      errorText={addressError ? t("screen.BitcoinReceiveModal.walletGettingReady") : undefined}
      onRetry={isInstant ? retryAddress : undefined}
    />
  );
};

export default BitcoinReceiveModal;
