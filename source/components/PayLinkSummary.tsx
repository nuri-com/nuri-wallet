// @component pay-link-summary
// Frontend-only extraction of #1163's Move-style source and fixed recipient.
import type React from "react";
import type { ImageSourcePropType } from "react-native";
import {
  Bleed,
  IconButton,
  NuriScope,
  SelectTrigger,
  SelectTriggerAvatar,
  SelectTriggerChevron,
  SelectTriggerLabel,
  SelectTriggerValue,
  Text,
  View,
} from "@ds";
import type { IconName } from "@ds";
import { t } from "../lib/i18n";

type Props = {
  /** Takes the height the keypad leaves, like the Move sheet's focused half. */
  grow?: boolean;
  /** Who or what receives: "@username", or the balance being filled. */
  to: string;
  /** What arrives, once priced: stated beside the To line, as the Move sheet does. */
  toAmount?: string | null;
  sourceLabel: string;
  image?: ImageSourcePropType;
  icon?: IconName;
  amount: string | null;
  onPickSource: () => void;
  /** The arrow between the cards; picks the source when not given. */
  onArrowPress?: () => void;
};

const PayLinkSummary: React.FC<Props> = ({
  grow = false,
  to,
  toAmount = null,
  sourceLabel,
  image,
  icon,
  amount,
  onPickSource,
  onArrowPress,
}) => (
  <NuriScope mode="dark">
    <View direction="column" align="stretch" gap="xs" {...(grow ? { fill: "grow" as const } : {})}>
      <View
        chrome="subtle"
        radius="lg"
        paddingX="lg"
        paddingY="md"
        direction="column"
        align="stretch"
        gap="lg"
        {...(grow ? { fill: "grow" as const } : {})}
      >
        <SelectTrigger
          onPress={onPickSource}
          accessibilityLabel={t("screen.PayLink.sourceA11yLabel")}
        >
          <SelectTriggerLabel>{t("screen.PayLink.from")}</SelectTriggerLabel>
          {image !== undefined ? (
            <SelectTriggerAvatar source={image} />
          ) : (
            <SelectTriggerAvatar name={icon ?? "wallet"} accent="lilac" />
          )}
          <SelectTriggerValue>{sourceLabel}</SelectTriggerValue>
          <SelectTriggerChevron name="caret-down" />
        </SelectTrigger>
        {amount !== null ? (
          <View fill="grow" justify="end" align="end">
            <Text size="3xl" align="end">
              {amount}
            </Text>
          </View>
        ) : null}
      </View>
      <Bleed top="xl" bottom="xl">
        <View direction="row" justify="center" align="center" height="lg">
          <IconButton
            icon="arrow-down"
            variant="solid"
            accessibilityLabel={t("screen.PayLink.sourceA11yLabel")}
            onPress={onArrowPress ?? onPickSource}
          />
        </View>
      </Bleed>
      <View chrome="subtle" radius="lg" paddingX="lg" paddingY="md">
        <View direction="row" justify="between" align="center" gap="sm">
          <View direction="row" align="center" gap="sm">
            <Text size="md" muted>
              {t("screen.PayLink.to")}
            </Text>
            <Text size="md">{to}</Text>
          </View>
          {toAmount ? (
            <Text size="md" emphasis>
              {toAmount}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  </NuriScope>
);

export default PayLinkSummary;
