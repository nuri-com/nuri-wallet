import React, { useEffect, useRef } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector, ScrollView } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import Spinner from "./Spinner";

const THRESHOLD = 70; // pull distance that triggers a refresh
const MAX_PULL = 110; // visual cap on the drag
const HOLD = 56; // where the content rests while refreshing (spinner visible)
const RESISTANCE = 0.5;

const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

type Props = {
  refreshing: boolean;
  onRefresh: () => void;
  children: React.ReactNode;
  /** Inset from the top where the spinner sits (e.g. a floating header height). */
  spinnerOffset?: number;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  showsVerticalScrollIndicator?: boolean;
};

/**
 * One cross-platform pull-to-refresh — identical on iOS, Android and web.
 *
 * Built on react-native-gesture-handler (Pan, composed simultaneously with the
 * ScrollView's own scroll) + Reanimated (all motion on shared values, so it
 * never re-renders React during the gesture — which is also what keeps it alive
 * on iOS Safari). Renders the DS `Spinner`, so the indicator looks the same
 * everywhere — one component for iOS, Android and web instead of the native
 * `RefreshControl`.
 */
export default function PullToRefresh({
  refreshing,
  onRefresh,
  children,
  spinnerOffset = 0,
  style,
  contentContainerStyle,
  showsVerticalScrollIndicator,
}: Props) {
  const scrollY = useSharedValue(0);
  const pull = useSharedValue(0);
  const refreshingSV = useSharedValue(refreshing);
  // Translation captured when the finger first reaches the top; -1 = unset. Pull
  // distance is measured from here (overscroll only), so a gesture that begins
  // scrolled-down cannot accumulate travel and trigger a premature refresh.
  const pullAnchor = useSharedValue(-1);
  // True once onEnd has handled a successful release, so the onFinalize cleanup
  // (which also runs for CANCELLED/FAILED pans) doesn't override its settle.
  const ended = useSharedValue(false);
  // biome-ignore lint/suspicious/noExplicitAny: RNGH ScrollView ref type varies across versions
  const scrollRef = useRef<any>(null);

  useEffect(() => {
    refreshingSV.value = refreshing;
    // Hold the content down while refreshing, spring it back when done.
    pull.value = withTiming(refreshing ? HOLD : 0, { duration: 220 });
  }, [refreshing, refreshingSV, pull]);

  const scrollHandler = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  const pan = Gesture.Pan()
    // Run alongside the ScrollView's own scroll (don't block it), and ignore
    // small movements so taps and horizontal gestures pass through.
    .simultaneousWithExternalGesture(scrollRef)
    .activeOffsetY([-12, 12])
    .onUpdate((e) => {
      "worklet";
      if (refreshingSV.value) return;
      // Only pull at the top with the finger going down, and measure only the
      // overscroll past the top (from the anchor) — not the whole drag — so a
      // pull that began scrolled-down can't trigger the moment it reaches top.
      if (scrollY.value <= 0 && e.translationY > 0) {
        if (pullAnchor.value < 0) pullAnchor.value = e.translationY;
        pull.value = Math.max(
          0,
          Math.min((e.translationY - pullAnchor.value) * RESISTANCE, MAX_PULL),
        );
      } else {
        // Scrolled down or finger going up: not a top-origin pull — re-arm.
        pullAnchor.value = -1;
        pull.value = 0;
      }
    })
    .onEnd(() => {
      "worklet";
      ended.value = true;
      if (refreshingSV.value) return;
      if (pull.value >= THRESHOLD) {
        runOnJS(onRefresh)();
        // Settle at HOLD. If the parent drives `refreshing` (managed screens),
        // it flips true within this window so the spinner stays, and the effect
        // retracts it on completion. If the parent doesn't (fire-and-forget,
        // e.g. refreshing={false}), retract on our own once we reach HOLD so the
        // spinner can't stick — matching the native RefreshControl.
        pull.value = withTiming(HOLD, { duration: 180 }, (finished) => {
          "worklet";
          if (finished && !refreshingSV.value) {
            pull.value = withTiming(0, { duration: 220 });
          }
        });
      } else {
        pull.value = withTiming(0, { duration: 200 });
      }
    })
    .onFinalize(() => {
      "worklet";
      // Runs on END, CANCEL and FAIL. Always clear the anchor. When onEnd
      // already settled a successful release (`ended`), leave it alone;
      // otherwise (a cancelled/failed pan, where onEnd never fired) spring
      // back unless a refresh is held, so content and spinner can't stick.
      pullAnchor.value = -1;
      if (!ended.value && !refreshingSV.value) {
        pull.value = withTiming(0, { duration: 200 });
      }
      ended.value = false;
    });

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: pull.value }],
  }));

  const spinnerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pull.value, [0, THRESHOLD * 0.6, THRESHOLD], [0, 0.4, 1]),
    transform: [{ scale: interpolate(pull.value, [0, THRESHOLD], [0.7, 1]) }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.fill, style]}>
        <Animated.View
          pointerEvents="none"
          style={[styles.spinner, { top: spinnerOffset }, spinnerStyle]}
        >
          <Spinner />
        </Animated.View>
        <AnimatedScrollView
          ref={scrollRef}
          style={[styles.fill, contentStyle]}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          contentContainerStyle={contentContainerStyle}
          showsVerticalScrollIndicator={showsVerticalScrollIndicator}
        >
          {children}
        </AnimatedScrollView>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  spinner: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 5,
  },
});
