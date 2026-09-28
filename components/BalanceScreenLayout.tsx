import type { ReactNode } from "react";
import { View, StyleSheet, type ViewStyle, type StyleProp } from "react-native";
import PullToRefresh from "./PullToRefresh";

const noop = () => {};

type Props = {
  /** Content rendered above balance+buttons (e.g. CardCarousel). Positioned absolutely so it doesn't affect balance placement. */
  topOverlay?: ReactNode;
  /** The balance display (digits, symbol, hidden mask). */
  balanceContent?: ReactNode;
  /** Indicator beside balance (e.g. pending spinner, lock icon). */
  balanceTrailing?: ReactNode;
  /** Action buttons row content (e.g. Send/Receive TouchableOpacities). */
  buttons?: ReactNode;
  /** Content rendered below buttons but above the scroll area (e.g. currency list). */
  belowButtons?: ReactNode;
  /** Scrollable content below the fixed balance+buttons area. */
  children?: ReactNode;
  /** RefreshControl element — its `refreshing`/`onRefresh` drive the cross-platform PullToRefresh. */
  // biome-ignore lint/suspicious/noExplicitAny: RefreshControl type varies across RN versions
  refreshControl?: React.ReactElement<any>;
  /** Override balanceContainer style. */
  balanceContainerStyle?: StyleProp<ViewStyle>;
  /** Override scrollView contentContainerStyle. */
  scrollContentContainerStyle?: StyleProp<ViewStyle>;
};

const BalanceScreenLayout: React.FC<Props> = ({
  topOverlay,
  balanceContent,
  balanceTrailing,
  buttons,
  belowButtons,
  children,
  refreshControl,
  balanceContainerStyle,
  scrollContentContainerStyle,
}) => {
  // One cross-platform pull-to-refresh (native + web look identical). Callers
  // still pass a RefreshControl element; we read its refreshing/onRefresh and
  // hand them to PullToRefresh instead of rendering the native control.
  const refreshing = !!refreshControl?.props?.refreshing;
  const onRefresh = refreshControl?.props?.onRefresh ?? noop;
  return (
    <View style={styles.wrapper}>
      {topOverlay ? (
        // `box-none` so this absolute, full-width wrapper doesn't intercept
        // touches outside its visible children (carousel, header CTAs).
        // Android hit-tests `position:absolute` Views across their full
        // layout bounds even when zIndex stacks them below other content,
        // which froze taps in the bottom half of the Card screen (#517).
        <View pointerEvents="box-none" style={styles.topOverlayAbsolute}>
          {topOverlay}
        </View>
      ) : null}

      <View style={styles.centeredContent}>
        {balanceContent ? (
          <View style={[styles.balanceContainer, balanceContainerStyle]}>
            <View style={styles.balanceRow}>
              {balanceContent}
              {balanceTrailing}
            </View>
          </View>
        ) : null}

        {buttons ? <View style={styles.quickActions}>{buttons}</View> : null}
      </View>

      <PullToRefresh
        refreshing={refreshing}
        onRefresh={onRefresh}
        style={styles.scrollContent}
        contentContainerStyle={scrollContentContainerStyle}
        showsVerticalScrollIndicator={false}
      >
        {belowButtons}
        {children}
      </PullToRefresh>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },
  topOverlayAbsolute: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
  },
  centeredContent: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: "50%",
  },
  balanceContainer: {
    alignItems: "center",
    paddingVertical: 8,
  },
  balanceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  quickActions: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 16,
    marginTop: 4,
    // Match the DS ScreenHeader's horizontal inset (space.xl = 24) so the top
    // row and the button row line up. Raw px because this layout is not yet a
    // DS surface — a DS-owned padding token belongs here once it converts.
    paddingHorizontal: 24,
    paddingVertical: 4,
    alignSelf: "stretch",
  },
  scrollContent: {
    flex: 1,
  },
});

export default BalanceScreenLayout;
