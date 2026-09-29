// @screen app.home.add-money
// The home's single CTA branches here, into the four ways money reaches this
// app: the two addresses the user already owns (the EVM wallet for euro, the
// onchain bitcoin wallet), the bank account it can be transferred to, and a
// purchase. Each one is a different rail, which is why this is one sheet rather
// than a row of buttons.
import type React from "react";
import ChoiceSheet, { type ChoiceSheetItem } from "../../components/ChoiceSheet";
import { t } from "../../lib/i18n";

// The same marks the home board uses for these rails — the sheet is the board's
// own list of ways in, so it identifies them the same way.
const EUR_FLAG = require("../../assets/flags/eur.png");
const BTC_LOGO = require("../../assets/rails/btc.png");
const SEPA_LOGO = require("../../assets/rails/sepa.png");

export type AddMoneyChoiceKey = "euro" | "bitcoin" | "iban" | "pay";

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (choice: AddMoneyChoiceKey) => void;
};

const AddMoneyChoiceModal: React.FC<Props> = ({ visible, onClose, onSelect }) => {
  const items: ChoiceSheetItem<AddMoneyChoiceKey>[] = [
    {
      key: "euro",
      image: EUR_FLAG,
      label: t("screen.HomeScreen.addMoneyEuro"),
    },
    {
      key: "bitcoin",
      image: BTC_LOGO,
      label: t("screen.HomeScreen.addMoneyBitcoin"),
    },
    {
      key: "iban",
      image: SEPA_LOGO,
      label: t("screen.HomeScreen.addMoneyIban"),
    },
    {
      // Apple/Google Pay is a payment method, not a rail of ours, so it keeps
      // the icon: there is no mark of its own on the board to match.
      key: "pay",
      icon: "apple",
      accent: "neutral",
      label: t("screen.HomeScreen.addMoneyPay"),
    },
  ];

  return (
    <ChoiceSheet<AddMoneyChoiceKey>
      visible={visible}
      onClose={onClose}
      title={t("screen.HomeScreen.addMoneyTitle")}
      subtitle={t("screen.HomeScreen.addMoneySubtitle")}
      items={items}
      onSelect={onSelect}
    />
  );
};

export default AddMoneyChoiceModal;
