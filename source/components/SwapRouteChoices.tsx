/**
 * The app's way of offering a priced swap's alternatives: the best one stands
 * alone, and "Show more" opens the rest.
 *
 * The Move sheet's price list: a list that is open by default is a different
 * screen, not a variation of this one.
 *
 * Stateless about the selection (the caller owns that); the expanded/collapsed
 * state belongs to the control itself.
 */

import { useState, type FC } from "react";
import { Text as RNText, StyleSheet } from "react-native";
import { NuriIcon, Pressable, Text, View } from "@ds";
import { t } from "../lib/i18n";

export type SwapRouteChoice = {
  id: string;
  label: string;
  sublabel?: string | null;
  /** Visible but not selectable (route exists, not yet executable). */
  disabled?: boolean;
};

type Props = {
  options: SwapRouteChoice[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Provider limits text — only shown inside the expanded list. */
  limitsText?: string | null;
};

const SwapRouteChoices: FC<Props> = ({ options, selectedId, onSelect, limitsText }) => {
  const [showAll, setShowAll] = useState(false);
  if (options.length < 2) return null;
  if (!showAll) {
    return (
      <Pressable onPress={() => setShowAll(true)} paddingY="xs" align="center">
        <RNText style={styles.showMoreLink}>{t("swap.route.showMore")}</RNText>
      </Pressable>
    );
  }
  return (
    <View direction="column" align="stretch" gap="sm">
      {limitsText ? (
        <Text size="sm" muted align="center">
          {limitsText}
        </Text>
      ) : null}
      {options.map((route) => {
        const selected = route.id === selectedId;
        return (
          <Pressable
            key={route.id}
            selected={selected}
            accessibilityLabel={route.label}
            disabled={route.disabled}
            onPress={() => onSelect?.(route.id)}
            variant={selected ? "outline" : "soft"}
            radius="lg"
            paddingY="lg"
            paddingX="lg"
            direction="row"
            align="center"
            justify="between"
            gap="md"
            pressColor
            disabledOpacity
          >
            {/* fill="grow" so a wrapping sublabel shrinks INSIDE the row instead
                of pushing the check icon out of the card. */}
            <View direction="column" align="start" gap="xs" fill="grow">
              <Text size="md" emphasis>
                {route.label}
              </Text>
              {route.sublabel ? (
                <Text size="md" muted>
                  {route.sublabel}
                </Text>
              ) : null}
            </View>
            {selected ? <NuriIcon name="check-circle" /> : null}
          </Pressable>
        );
      })}
      <Pressable onPress={() => setShowAll(false)} paddingY="xs" align="center">
        <RNText style={styles.showMoreLink}>{t("swap.route.showLess")}</RNText>
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  showMoreLink: {
    fontSize: 17,
    color: "#8E8E93",
    textDecorationLine: "underline",
  },
});

export default SwapRouteChoices;
