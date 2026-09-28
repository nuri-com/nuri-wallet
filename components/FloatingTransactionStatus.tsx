import type React from "react";
import { StyleSheet, View as RNView } from "react-native";
import { IconButton } from "@ds";

type Props = {
  visible?: boolean;
  onOpenTransactions: () => void;
  transactionsAccessibilityLabel: string;
};

// Pending info intentionally lives in the transaction lists only (#788):
// each pending row shows a spinner next to its amount. This component is
// just the floating button that opens the list.
const FloatingTransactionStatus: React.FC<Props> = ({
  visible = true,
  onOpenTransactions,
  transactionsAccessibilityLabel,
}) => {
  if (!visible) return null;

  // `box-none` so the absolute, full-width container doesn't intercept
  // touches outside its visible child (the button). On Android this view
  // was eating taps on the bottom strip of the Card screen, freezing the
  // tab bar (#517).
  return (
    <RNView pointerEvents="box-none" style={styles.container}>
      <IconButton
        icon="list-bullets"
        variant="soft"
        accessibilityLabel={transactionsAccessibilityLabel}
        onPress={onOpenTransactions}
      />
    </RNView>
  );
};

// Structural positioning only: floats the button over the tab body.
const styles = StyleSheet.create({
  container: {
    position: "absolute",
    zIndex: 2,
    bottom: 28,
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
});

export default FloatingTransactionStatus;
