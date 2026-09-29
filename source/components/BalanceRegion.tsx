/**
 * The balance block the designer's boards put at the top of the home and of
 * every asset screen: the swap control on the left, the figure large on the
 * right, and — on an asset screen — the same amount converted, muted, at the
 * foot of the region.
 *
 * Shared because the two screens sit on top of each other: the home row is
 * tapped and the asset screen opens over it, so any difference in this block
 * reads as the balance jumping. One element, one position.
 *
 * The height comes from the board's card ratio, but is computed from the window
 * width rather than left to `aspectRatio`: a ratio needs a measured width, and
 * the first frame of a screen that animates in has none — the region collapsed
 * to nothing and the whole screen visibly settled downwards afterwards.
 *
 * The converted line is taken out of flow so it cannot push the figure up. It
 * belongs to the region's foot, and the figure has to stay exactly where the
 * home's figure is, converted line or not.
 */

import type * as React from "react";
import { StyleSheet, View as RNView, useWindowDimensions } from "react-native";
import { IconButton, Text, View } from "@ds";

// The DS `ratio.card` token. The RN DS ships the token but no primitive applies
// it, so the value lives here as a structural constant.
const CARD_ASPECT_RATIO = 1.586;

type Props = {
  /** The balance, already formatted (e.g. "€18.60"). */
  amount: string;
  /** The same balance in the other currency. Omitted on the home total. */
  converted?: string | null;
  onSwap: () => void;
  swapA11yLabel: string;
};

const BalanceRegion: React.FC<Props> = ({ amount, converted, onSwap, swapA11yLabel }) => {
  const { width } = useWindowDimensions();
  return (
    <RNView style={{ height: Math.round(width / CARD_ASPECT_RATIO) }}>
      <View direction="row" justify="between" align="center" paddingX="lg" fill="grow">
        <IconButton
          icon="transfer-vertical"
          variant="soft"
          accessibilityLabel={swapA11yLabel}
          onPress={onSwap}
        />
        <Text size="3xl" align="end">
          {amount}
        </Text>
      </View>
      {converted ? (
        <RNView pointerEvents="none" style={styles.converted}>
          <View direction="column" align="stretch" paddingX="lg">
            <Text size="md" align="end" muted>
              {converted}
            </Text>
          </View>
        </RNView>
      ) : null}
    </RNView>
  );
};

const styles = StyleSheet.create({
  converted: { position: "absolute", left: 0, right: 0, bottom: 0 },
});

export default BalanceRegion;
