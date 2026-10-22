// The amount screens' "From" row: which balance pays this send. With more than
// one balance able to pay the recipient it opens a picker of exactly those;
// picking one may open another amount screen (the host decides).
import { useState } from "react";
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

import ChoiceSheet from "../ChoiceSheet";
import { t } from "../../lib/i18n";
import type { SendBalance } from "../../lib/send/sendRouting";

export type SendBalanceOption = {
  key: SendBalance;
  label: string;
  /** The balance, formatted. */
  sublabel: string;
  image: ImageSourcePropType;
};

type Props = {
  /** Every balance that can pay this recipient; none = the row only states `current`. */
  options?: SendBalanceOption[];
  current: SendBalance;
  /** What the row states when `options` does not list `current`. */
  fallback: { label: string; image: ImageSourcePropType };
  disabled?: boolean;
  onPick?: (key: SendBalance) => void;
};

export default function SendFromRow({ options, current, fallback, disabled, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const selected = options?.find((option) => option.key === current);
  const value = selected ? `${selected.label} (${selected.sublabel})` : fallback.label;
  const image = selected?.image ?? fallback.image;
  const pickable = !!options && options.length > 1 && !!onPick;
  return (
    <>
      <View direction="row" align="center">
        {pickable ? (
          <SelectTrigger
            onPress={() => setOpen(true)}
            disabled={disabled}
            accessibilityLabel={t("screen.MoveSheet.sourceAccountA11yLabel")}
            accessibilityValue={value}
          >
            <SelectTriggerLabel>{t("screen.MoveSheet.from")}</SelectTriggerLabel>
            <SelectTriggerAvatar source={image} />
            <SelectTriggerValue>{value}</SelectTriggerValue>
            <SelectTriggerChevron name="caret-down" />
          </SelectTrigger>
        ) : (
          <View direction="row" align="center" gap="sm">
            <Text size="md" muted>
              {t("screen.MoveSheet.from")}
            </Text>
            <Text size="md">{value}</Text>
          </View>
        )}
      </View>
      <ChoiceSheet
        visible={open && pickable}
        onClose={() => setOpen(false)}
        title={t("screen.MoveSheet.pickerFromTitle")}
        items={options ?? []}
        onSelect={(key) => {
          setOpen(false);
          if (key !== current) onPick?.(key);
        }}
      />
    </>
  );
}
