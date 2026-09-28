// @component quick-amounts
// The row of quick-amount chips that sits above every amount keypad.
//
// One component, because there is one control: the four anchors and the glyph
// on them are the same wherever an amount is typed. Each screen used to draw its
// own row from the shared numbers, which is how one of them drifted to printing
// the currency code and another to following the token being sent.
//
// The chips are round numbers to TAP. They never state what is being sent — the
// figure above the keypad does that — so they always wear the euro glyph, on a
// dollar send as much as a euro one.
import type React from "react";
import { Button, ButtonText, View } from "@ds";

import { QUICK_AMOUNTS } from "../lib/quickAmounts";

type Props = {
  /** Called with the tapped amount. Ignored while the amount is not editable. */
  onPick: (amount: number) => void;
  /** Mid-send, mid-quote: the row stays visible but nothing may change. */
  disabled?: boolean;
};

const QuickAmounts: React.FC<Props> = ({ onPick, disabled }) => (
  <View direction="row" distribute="even" gap="sm">
    {QUICK_AMOUNTS.map((value) => (
      <Button
        key={value}
        size="sm"
        variant="solid"
        accessibilityLabel={`€ ${value}`}
        onPress={() => {
          if (disabled) return;
          onPick(value);
        }}
      >
        <ButtonText>{`€ ${value}`}</ButtonText>
      </Button>
    ))}
  </View>
);

export default QuickAmounts;
