// @screen auth.login
import { Image, Linking, Platform, StyleSheet, View } from "react-native";
import { Header, IconButton, NuriScope, Screen, useNuriTheme, View as DsView } from "@ds";
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
      {/* The landing is a normal DS page: the support button sits in the
          header row where every screen has it, the headline below it, and the
          actions in the shared AppFooter (rendered by the content below). */}
      <Screen>
        <Header safeAreaTop>
          <DsView direction="row" align="center" justify="end" paddingX="xl" paddingBottom="lg">
            {/* ponytail: pre-auth support = WhatsApp deep link; swap for in-app
             * nostr chat (ephemeral keypair) if we want to keep support in-app */}
            {!targetedUsername ? (
              <IconButton
                icon="headphones"
                variant="soft"
                accessibilityLabel={t("screen.ScreenHeader.supportAccessibilityLabel")}
                onPress={() => Linking.openURL("https://wa.me/37253687271")}
              />
            ) : null}
          </DsView>
        </Header>
        <DsView direction="column" align="center" paddingX="lg">
          <BrandDisplayTitle>{t("screen.PasskeyLoginScreen.headline")}</BrandDisplayTitle>
        </DsView>

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
      </Screen>
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
});
