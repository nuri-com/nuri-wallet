// @screen wallet.receive
// The EVM wallet's receive sheet: the user's ENS name over the EOA address that
// backs it, with the flip accessory to show either. Both are public, so nothing
// here prompts for biometrics — the address is the cached one and the name comes
// from the persisted LNURL status.
//
// The name is read persisted-only: refreshing it against the server is the
// bitcoin receive flow's job, and doing it here too would race it.
import React, { useEffect, useState } from "react";
import ReceiveModal from "../../../components/ReceiveModal";
import { ENS_PARENT_DOMAIN } from "../../../config/constants";
import { t } from "../../../lib/i18n";
import { getEthereumAddress } from "../../../lib/secureKeyStorage";
import { getArkadeLnurlStatusPersisted } from "../../../services/arkade/ArkadeLnurlService";

type Props = {
  visible: boolean;
  onClose: () => void;
  /**
   * The EOA to show. Omit it and the sheet reads the cached address itself —
   * pass one only where the host already holds the session's address, so the
   * sheet can never show a different account than the screen around it.
   */
  address?: string | null;
};

const WalletReceiveModal: React.FC<Props> = ({ visible, onClose, address }) => {
  const resolvesOwnAddress = address === undefined;
  const [ensName, setEnsName] = useState<string | null>(null);
  const [ownAddress, setOwnAddress] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await getArkadeLnurlStatusPersisted();
        const username = status?.registered ? status.username : null;
        if (!cancelled) setEnsName(username ? `${username}.${ENS_PARENT_DOMAIN}` : null);
      } catch (e) {
        console.warn("[WalletReceiveModal] persisted LNURL status load failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !resolvesOwnAddress) return;
    let cancelled = false;
    (async () => {
      try {
        const value = await getEthereumAddress();
        if (!cancelled) setOwnAddress(value);
      } catch (e) {
        console.warn("[WalletReceiveModal] address load failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, resolvesOwnAddress]);

  return (
    <ReceiveModal
      visible={visible}
      onClose={onClose}
      title={t("screen.WalletScreen.receiveLabel")}
      primary={{ label: t("screen.WalletScreen.ensNameLabel"), value: ensName }}
      secondary={{
        label: t("screen.WalletScreen.evmAddressLabel"),
        value: resolvesOwnAddress ? ownAddress : address,
      }}
      emptyText={t("screen.WalletScreen.receiveNotReady")}
      // Request is phase 2 — the button stays greyed out until it exists.
    />
  );
};

export default WalletReceiveModal;
