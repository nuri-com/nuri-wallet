import type React from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { View as RNView, StyleSheet } from "react-native";
import { Text, View } from "@ds";

type Props = {
  count: number;
  visible?: boolean;
  /** When true (default), badge is absolutely positioned over its parent. */
  absolute?: boolean;
  style?: StyleProp<ViewStyle>;
};

// Unread-count badge composed from DS parts: a solid orange pill with the count
// in scope-colored text. The outer RN wrapper is structural only — absolute
// positioning over the parent icon and the fixed 18px geometry.
const NotificationBadge: React.FC<Props> = ({ count, visible = true, absolute = true, style }) => {
  if (!visible || count <= 0) return null;
  return (
    <RNView style={[styles.badge, absolute && styles.absolute, style]} pointerEvents="none">
      <View
        variant="solid"
        accent="orange"
        radius="full"
        direction="column"
        align="center"
        justify="center"
        paddingX="xs"
        fill="grow"
      >
        <Text size="xs" emphasis>
          {String(count)}
        </Text>
      </View>
    </RNView>
  );
};

const styles = StyleSheet.create({
  badge: {
    minWidth: 18,
    height: 18,
  },
  absolute: {
    position: "absolute",
    top: -4,
    right: -4,
  },
});

export default NotificationBadge;
