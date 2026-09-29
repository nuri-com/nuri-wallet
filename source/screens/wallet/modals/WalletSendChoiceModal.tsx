// @screen wallet.send-choice
import React, { useEffect, useState } from "react";
import ChoiceSheet, { type ChoiceSheetItem } from "../../../components/ChoiceSheet";
import { wirexAccountService } from "../../../services/wirex/WirexAccountService";
import { t } from "../../../lib/i18n";

import type { WalletSendChoiceKey } from "../../../types/wallet";
export type { WalletSendChoiceKey } from "../../../types/wallet";

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect?: (choice: WalletSendChoiceKey) => void;
};

const WalletSendChoiceModal: React.FC<Props> = ({ visible, onClose, onSelect }) => {
  // The card row is only shown when the user has a Wirex account. ensureStarted()
  // is idempotent — it kicks the initial account load once so hasAccount() is
  // populated; subscribing keeps the row in sync if the snapshot resolves later.
  const [hasWirexAccount, setHasWirexAccount] = useState(() => wirexAccountService.hasAccount());
  useEffect(() => {
    wirexAccountService.ensureStarted();
    const update = () => setHasWirexAccount(wirexAccountService.hasAccount());
    update();
    return wirexAccountService.subscribe(update);
  }, []);

  const items: ChoiceSheetItem<WalletSendChoiceKey>[] = [
    {
      key: "wallet",
      icon: "wallet",
      accent: "lilac",
      label: t("screen.WalletSendChoiceModal.walletTitle"),
    },
    ...(hasWirexAccount
      ? [
          {
            key: "card" as const,
            icon: "card" as const,
            label: t("screen.WalletSendChoiceModal.cardTitle"),
          },
        ]
      : []),
    {
      key: "bitcoin",
      icon: "transfer-horizontal",
      accent: "orange",
      label: t("screen.WalletSendChoiceModal.bitcoinTitle"),
    },
  ];

  return (
    <ChoiceSheet<WalletSendChoiceKey>
      visible={visible}
      onClose={onClose}
      title={t("screen.WalletSendChoiceModal.title")}
      subtitle={t("screen.WalletSendChoiceModal.subtitle")}
      items={items}
      onSelect={(choice) => onSelect?.(choice)}
    />
  );
};

export default WalletSendChoiceModal;
