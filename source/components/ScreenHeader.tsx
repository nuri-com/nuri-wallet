import { useCallback, useRef, type ReactNode } from "react";
import { StyleSheet, View as RNView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton, Pressable, View } from "@ds";
import NuriLogo from "./NuriLogo";
import NotificationBadge from "./NotificationBadge";
import { t } from "../lib/i18n";
import { EventBus } from "../services/events/AppEventBusService";
import { useSupportUnreadCount } from "../lib/nostr/useSupportUnreadCount";

type Props = {
  /** Content rendered in the center slot (e.g. a button). */
  centerContent?: ReactNode;
  /** Extra content rendered next to the logo (e.g. partner co-branding). */
  logoBranding?: ReactNode;
  /** Extra content rendered before the support button (e.g. key icon). */
  rightExtra?: ReactNode;
  /** Whether to show the support button. Defaults to true; pass false pre-auth (onboarding). */
  showSupport?: boolean;
};

declare const __DEV__: boolean | undefined;

const DEBUG_UI_ENABLED = typeof __DEV__ !== "undefined" && __DEV__ === true;
const LOGO_TAP_THRESHOLD = 8;
const LOGO_TAP_TIMEOUT_MS = 800;

// The header is self-contained: the support button, its unread badge, and the
// logo→debug-hub gesture are wired here once, not per-screen. Everything is
// dispatched over EventBus so the single owners (App renders the one support
// modal + the debug hub) react — the header is mounted on every tab at once, so
// it must not render the modal itself.
const ScreenHeader: React.FC<Props> = ({
  centerContent,
  logoBranding,
  rightExtra,
  showSupport = true,
}) => {
  // Read the top inset from context (synchronous, seeded by initialWindowMetrics)
  // rather than a self-measuring <SafeAreaView>. Tabs are toggled via
  // display:none, so a SafeAreaView re-measures on show and paints one frame at
  // inset 0 before snapping down — the jump when switching to Card/Wallet.
  const insets = useSafeAreaInsets();
  const logoTapCountRef = useRef(0);
  const logoTapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supportUnreadCount = useSupportUnreadCount();

  const handleSupportPress = useCallback(() => {
    try {
      EventBus.emit("support:openNostrChat");
    } catch {}
  }, []);

  const handleLogoPress = useCallback(() => {
    if (!DEBUG_UI_ENABLED) return;
    logoTapCountRef.current += 1;

    if (logoTapTimeoutRef.current) {
      clearTimeout(logoTapTimeoutRef.current);
    }

    logoTapTimeoutRef.current = setTimeout(() => {
      logoTapCountRef.current = 0;
      logoTapTimeoutRef.current = null;
    }, LOGO_TAP_TIMEOUT_MS);

    if (logoTapCountRef.current >= LOGO_TAP_THRESHOLD) {
      logoTapCountRef.current = 0;
      if (logoTapTimeoutRef.current) {
        clearTimeout(logoTapTimeoutRef.current);
        logoTapTimeoutRef.current = null;
      }
      try {
        EventBus.emit("debug:openHub");
      } catch {}
    }
  }, []);

  return (
    <RNView style={{ paddingTop: insets.top }}>
      <View direction="row" align="center" justify="between" paddingX="xl" paddingBottom="lg">
        <View direction="row" align="center" gap="sm">
          <Pressable
            onPress={handleLogoPress}
            accessibilityLabel={DEBUG_UI_ENABLED ? "nuri" : undefined}
          >
            <View direction="row" align="center">
              <NuriLogo />
              {logoBranding}
            </View>
          </Pressable>
        </View>
        <View direction="row" align="center" justify="center" fill="grow">
          {centerContent}
        </View>
        <View direction="row" align="center" gap="sm">
          {rightExtra}
          {showSupport ? (
            <RNView style={styles.supportButtonWrap}>
              <IconButton
                icon="headphones"
                variant="soft"
                accessibilityLabel={t("screen.ScreenHeader.supportAccessibilityLabel")}
                onPress={handleSupportPress}
              />
              <NotificationBadge count={supportUnreadCount} />
            </RNView>
          ) : null}
        </View>
      </View>
    </RNView>
  );
};

// Structural: anchor for the absolutely-positioned unread badge.
const styles = StyleSheet.create({
  supportButtonWrap: {
    position: "relative",
  },
});

export default ScreenHeader;
