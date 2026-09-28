// @screen bitcoin.send-source
// Second step of the send flow: after picking a destination in
// BitcoinSendChoiceModal, pick which wallet the sats leave from. The two rails
// hold separate balances, so this is a real choice rather than a display detail.
import type React from "react";
import ChoiceSheet, { type ChoiceSheetItem } from "../../../components/ChoiceSheet";
import { t } from "../../../lib/i18n";
import type { BtcSourceId } from "../../../services/bitcoin/providers/registry";

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect?: (source: BtcSourceId) => void;
  /** Hide the on-chain option until that wallet exists for this identity. */
  showOnchain?: boolean;
};

const BitcoinSendSourceModal: React.FC<Props> = ({
  visible,
  onClose,
  onSelect,
  showOnchain = false,
}) => {
  const items: ChoiceSheetItem<BtcSourceId>[] = [
    {
      key: "arkade",
      icon: "wallet",
      accent: "orange",
      label: t("screen.BitcoinSendSourceModal.arkadeTitle"),
    },
    ...(showOnchain
      ? [
          {
            key: "onchain" as const,
            icon: "transfer-horizontal" as const,
            label: t("screen.BitcoinSendSourceModal.onchainTitle"),
          },
        ]
      : []),
  ];

  return (
    <ChoiceSheet<BtcSourceId>
      visible={visible}
      onClose={onClose}
      title={t("screen.BitcoinSendSourceModal.title")}
      subtitle={t("screen.BitcoinSendSourceModal.subtitle")}
      items={items}
      onSelect={(source) => onSelect?.(source)}
    />
  );
};

export default BitcoinSendSourceModal;
