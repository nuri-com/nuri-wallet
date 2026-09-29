// @component pay-link-summary
// Frontend-only extraction of #1163's Move-style source and fixed recipient.
import type React from "react";
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
  username: string;
  sourceLabel: string;
  image?: number;
  icon?: IconName;
  amount: string | null;
  onPickSource: () => void;
};

const PayLinkSummary: React.FC<Props> = ({
  username,
  sourceLabel,
  image,
  icon,
  amount,
  onPickSource,
}) => (
  <NuriScope mode="dark">
    <View direction="column" align="stretch" gap="xs">
      <View chrome="subtle" radius="lg" paddingX="lg" paddingY="lg" gap="lg">
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
          <Text size="3xl" align="end">
            {amount}
          </Text>
        ) : null}
      </View>
      <Bleed top="xl" bottom="xl">
        <View direction="row" justify="center" align="center" height="lg">
          <IconButton
            icon="arrow-down"
            variant="solid"
            accessibilityLabel={t("screen.PayLink.sourceA11yLabel")}
            onPress={onPickSource}
          />
        </View>
      </Bleed>
      <View chrome="subtle" radius="lg" paddingX="lg" paddingY="md">
        <View direction="row" align="center" gap="sm">
          <Text size="md" muted>
            {t("screen.PayLink.to")}
          </Text>
          <Text size="md">{`@${username}`}</Text>
        </View>
      </View>
    </View>
  </NuriScope>
);

export default PayLinkSummary;
