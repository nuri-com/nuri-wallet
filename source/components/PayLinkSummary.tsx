// @component pay-link-summary
// The public pay page's summary, drawn the way the app's own "send to @name"
// screen is: the recipient as a person (avatar and name) and the send screens'
// one amount card (components/send/SendAmountCard) with how the payer pays on
// top and the figure bottom right. Without a person (adding money to one of
// the user's own balances) the card states where it goes in a To row instead.
import type React from "react";
import type { ImageSourcePropType } from "react-native";
import {
  SelectTrigger,
  SelectTriggerAvatar,
  SelectTriggerChevron,
  SelectTriggerLabel,
  SelectTriggerValue,
  Text,
  View,
} from "@ds";
import type { IconName } from "@ds";
import SendAmountCard from "./send/SendAmountCard";
import SendRecipientContact from "./SendRecipientContact";
import { t } from "../lib/i18n";

/** One picker row of the card: what it is called, what is chosen, what a tap opens. */
export type PaySummaryChoice = {
  label: string;
  value: string;
  image?: ImageSourcePropType;
  icon?: IconName;
  onPress: () => void;
  accessibilityLabel: string;
};

type Props = {
  /** The person paid, shown above the card like the send screens show a contact. */
  recipient?: { name: string; nuriUsername?: string };
  /** The card's rows: how the payer pays, then (paying from a wallet) which token. */
  choices: PaySummaryChoice[];
  /** The figure the payer pays; null states none. */
  amount: string | null;
  /** Where the money goes, when no person names it; with a person, only beside what arrives. */
  to?: string;
  /** What arrives, once known. */
  toAmount?: string | null;
  /** Takes the height the keypad leaves. */
  grow?: boolean;
};

function ChoiceRow({ choice }: { choice: PaySummaryChoice }) {
  return (
    <View direction="row" align="center">
      <SelectTrigger onPress={choice.onPress} accessibilityLabel={choice.accessibilityLabel}>
        <SelectTriggerLabel>{choice.label}</SelectTriggerLabel>
        {choice.image !== undefined ? (
          <SelectTriggerAvatar source={choice.image} />
        ) : (
          <SelectTriggerAvatar name={choice.icon ?? "wallet"} accent="lilac" />
        )}
        <SelectTriggerValue>{choice.value}</SelectTriggerValue>
        <SelectTriggerChevron name="caret-down" />
      </SelectTrigger>
    </View>
  );
}

const PayLinkSummary: React.FC<Props> = ({
  recipient,
  choices,
  amount,
  to,
  toAmount = null,
  grow = false,
}) => {
  const toRow = to && (!recipient || toAmount) ? to : null;
  return (
    <View direction="column" align="stretch" gap="lg" {...(grow ? { fill: "grow" as const } : {})}>
      {recipient ? (
        <SendRecipientContact name={recipient.name} nuriUsername={recipient.nuriUsername} />
      ) : null}
      <SendAmountCard grow={grow}>
        {choices.map((choice) => (
          <ChoiceRow key={choice.label} choice={choice} />
        ))}
        {amount !== null ? (
          <View fill="grow" justify="end" align="end">
            <Text size="3xl" align="end">
              {amount}
            </Text>
          </View>
        ) : null}
        {toRow ? (
          <View direction="row" justify="between" align="center" gap="sm">
            <View direction="row" align="center" gap="sm">
              <Text size="md" muted>
                {t("screen.PayLink.to")}
              </Text>
              <Text size="md">{toRow}</Text>
            </View>
            {toAmount ? (
              <Text size="md" emphasis>
                {toAmount}
              </Text>
            ) : null}
          </View>
        ) : null}
      </SendAmountCard>
    </View>
  );
};

export default PayLinkSummary;
