// @screen auth.login
import { Image, Linking, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton, NuriScope, useNuriTheme } from "@ds";
import BrandDisplayTitle from "./BrandDisplayTitle";
import { t } from "../lib/i18n";
import PasskeyLoginScreenNative from "./PasskeyLoginScreenNative";
import PasskeyLoginScreenWebView from "./PasskeyLoginScreenWebView";
import { isNativePasskeyLoginAvailable } from "../services/auth/PasskeyNativeModuleService";

export type PasskeyLoginScreenProps = {
  visible: boolean;
  footerMessage?: string | null;
  resetSignal?: number;
  /** Bumped by parent to auto-open the Continue modal on mount IF the active
   * credId hint is meaningful (exists AND not a known-stale legacy credId).
   * Never auto-triggers the iOS picker (= instant Face ID prompt, too
   * aggressive for an on-mount action). */
  autoOpenRestoreSignal?: number;
  /** Public @username link whose server-owned credential must be selected. */
  targetedUsername?: string | null;
  onPayloadReady: (payload: {
    prf: Uint8Array;
    isNew: boolean;
    credIdB64u?: string;
    credPubkeyB64u?: string;
    /** Present only when an available username flow created this passkey. */
    claimUsername?: string;
    /** Server challenge assertion produced by the same ceremony as the PRF. */
    claimAuth?: {
      token: string;
      clientDataB64u: string;
      authDataB64u: string;
      sigB64u: string;
    };
  }) => void;
  onError: (error: string) => void;
  onAttemptStart?: () => void;
  onDismiss?: () => void;
};

// The brand landing scopes lilac so the image-load fallback color is the DS
// lilac solid token (the image itself is the brand background).
export default function PasskeyLoginScreen(props: PasskeyLoginScreenProps) {
  return (
    <NuriScope accent="lilac">
      <PasskeyLoginScreenContent {...props} />
    </NuriScope>
  );
}

function PasskeyLoginScreenContent({
  visible,
  footerMessage,
  resetSignal,
  autoOpenRestoreSignal,
  targetedUsername,
  onPayloadReady,
  onError,
  onAttemptStart,
  onDismiss,
}: PasskeyLoginScreenProps) {
  const insets = useSafeAreaInsets();
  const theme = useNuriTheme();

  if (!visible) {
    return null;
  }

  // Web runs WebAuthn directly in the top-level page
  // (PasskeyNativeModuleService.web.ts). Android routes through the compiled-in
  // native PasskeyModule: the shipped binaries lack the WebView WebAuthn opt-in
  // (#868), so the in-WebView path reports "not supported" there — the native
  // path is the proven v0.86 production ceremony and ships OTA. iOS keeps the
  // in-WebView screen.
  const Content =
    Platform.OS === "web" || isNativePasskeyLoginAvailable()
      ? PasskeyLoginScreenNative
      : PasskeyLoginScreenWebView;

  return (
    <View style={[styles.container, { backgroundColor: theme.surface.solid.bg }]}>
      <Image
        source={require("../assets/nuri-background-v9.webp")}
        style={styles.backgroundImage}
        resizeMode="cover"
      />
      <View style={[styles.headlineContainer, { top: insets.top }]}>
        <BrandDisplayTitle>{t("screen.PasskeyLoginScreen.headline")}</BrandDisplayTitle>
      </View>

      {/* ponytail: pre-auth support = WhatsApp deep link; swap for in-app
       * nostr chat (ephemeral keypair) if we want to keep support in-app */}
      {!targetedUsername ? (
        <View style={[styles.supportButton, { top: insets.top }]}>
          <IconButton
            icon="headphones"
            variant="soft"
            accessibilityLabel={t("screen.ScreenHeader.supportAccessibilityLabel")}
            onPress={() => Linking.openURL("https://wa.me/37253687271")}
          />
        </View>
      ) : null}

      <Content
        footerMessage={footerMessage}
        resetSignal={resetSignal}
        autoOpenRestoreSignal={autoOpenRestoreSignal}
        targetedUsername={targetedUsername}
        onPayloadReady={onPayloadReady}
        onError={onError}
        onAttemptStart={onAttemptStart}
        onDismiss={onDismiss}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
  },
  backgroundImage: {
    ...StyleSheet.absoluteFillObject,
    width: "100%",
    height: "100%",
  },
  headlineContainer: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 2,
    paddingTop: 48,
    alignItems: "center",
    pointerEvents: "none",
  },
  // Structural: an absolute top-right overlay pinned below the safe-area inset
  // (top: insets.top) with a stacking order — DS boxes model none of position/
  // right/zIndex, so this stays raw RN. right: 24 mirrors ScreenHeader's
  // paddingX="xl" and no extra top padding, so the icon sits exactly where the
  // support button sits on the home screens.
  supportButton: {
    position: "absolute",
    right: 24,
    zIndex: 3,
  },
});
