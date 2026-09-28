// @screen wirex.send-choice
// Where the card's balance can go: out over SEPA, or back to the euro wallet.
// Both are chosen here and stated elsewhere — the withdrawal on the Move card,
// which prices and confirms every move between the user's own rails, and the
// SEPA transfer on its recipient screen, which has more to collect than an
// amount.
import type React from "react";
import ChoiceSheet, { type ChoiceSheetItem } from "../../../components/ChoiceSheet";
import { t } from "../../../lib/i18n";

export type WirexSendChoiceKey = "withdraw" | "sepa";

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (key: WirexSendChoiceKey) => void;
};

const WirexSendChoiceModal: React.FC<Props> = ({ visible, onClose, onSelect }) => {
  const items: ChoiceSheetItem<WirexSendChoiceKey>[] = [
    {
      key: "sepa",
      icon: "bank",
      accent: "lilac",
      label: t("screen.WirexSendChoice.sepaTitle"),
      sublabel: t("screen.WirexSendChoice.sepaSubtitle"),
    },
    {
      key: "withdraw",
      icon: "arrow-up",
      accent: "lilac",
      label: t("screen.WirexSendChoice.withdrawTitle"),
      sublabel: t("screen.WirexSendChoice.withdrawSubtitle"),
    },
  ];

  return (
    <ChoiceSheet<WirexSendChoiceKey>
      visible={visible}
      onClose={onClose}
      title={t("screen.WirexSendChoice.title")}
      subtitle={t("screen.WirexSendChoice.subtitle")}
      items={items}
      onSelect={onSelect}
    />
  );
};

export default WirexSendChoiceModal;
