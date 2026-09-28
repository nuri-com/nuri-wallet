import type { FC, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { Animated, Easing, type StyleProp, type ViewStyle } from "react-native";

type Props = {
  /** When true, plays the pop-in entrance then loops the riffle flick. Resets when false. */
  active: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

// Pop-in on activate (spring scale 0.6→1 + fade) then a repeating "riffle flick"
// (quick left/right tilt + tiny lift, like riffling banknotes) with a pause
// between cycles. Whole-image; a true hand-through-money effect needs a
// layer-grouped SVG. Native-driven so it stays off the JS thread.
const PopRiffleView: FC<Props> = ({ active, children, style }) => {
  const pop = useRef(new Animated.Value(0)).current;
  const riffle = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      pop.setValue(0);
      riffle.setValue(0);
      return;
    }
    const spring = Animated.spring(pop, {
      toValue: 1,
      friction: 5,
      tension: 80,
      useNativeDriver: true,
    });
    spring.start();
    const flick = (to: number) =>
      Animated.timing(riffle, {
        toValue: to,
        duration: 90,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      });
    const loop = Animated.loop(
      Animated.sequence([flick(1), flick(-1), flick(1), flick(-1), flick(0), Animated.delay(1600)]),
    );
    loop.start();
    return () => {
      spring.stop();
      loop.stop();
    };
  }, [active, pop, riffle]);

  // ponytail: cast is types-only; RN rejects the inferred union-typed transform array
  const animatedStyle = {
    opacity: pop,
    transform: [
      { perspective: 600 },
      { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
      { rotateZ: riffle.interpolate({ inputRange: [-1, 1], outputRange: ["-4deg", "4deg"] }) },
      { translateY: riffle.interpolate({ inputRange: [-1, 0, 1], outputRange: [-3, 0, -3] }) },
    ],
  } as Animated.AnimatedProps<{ style: object }>["style"];

  return <Animated.View style={[animatedStyle, style]}>{children}</Animated.View>;
};

export default PopRiffleView;
