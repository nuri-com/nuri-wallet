// @screen card.kyc-sumsub
import type React from "react";
import { StyleSheet, View as RNView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { IconButton, Text, View } from "@ds";
import { Layer } from "./LayerHost";
import { t } from "../lib/i18n";

type Props = {
  visible: boolean;
  url: string | null;
  onClose: () => void;
};

const SumsubWebModal: React.FC<Props> = ({ visible, url, onClose }) => {
  // Web renders the same KYC link in our iframe-backed WebView (Sumsub's flow is
  // URL-based, as on Android). The browser-open fallback stays for when no url.
  const showWebView = Boolean(url);
  const insets = useSafeAreaInsets();

  return (
    <Layer visible={visible} onRequestClose={onClose}>
      <View chrome="canvas" direction="column" align="stretch" fill="grow">
        {/* Structural: DS safe-area applies inside sheets; this Layer is a raw
            fullscreen surface, so pad the status bar height directly. */}
        <RNView style={{ paddingTop: insets.top }} />
        <View direction="row" align="center" gap="sm" paddingX="lg" paddingY="md">
          <View fill="grow">
            <Text size="lg" emphasis>
              {t("screen.SumsubWebModal.title")}
            </Text>
          </View>
          <IconButton
            icon="cross"
            variant="soft"
            accessibilityLabel={t("screen.SumsubWebModal.closeAccessibilityLabel")}
            onPress={onClose}
          />
        </View>

        <RNView style={styles.body}>
          {showWebView ? (
            <WebView
              source={{ uri: url ?? "" }}
              startInLoadingState
              // Sumsub face scan renders the camera stream in a <video> tag; without
              // these flags iOS WKWebView forces it into the fullscreen native player
              // and blocks the KYC flow. Required per Sumsub WebSDK-in-WebView docs.
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              mediaCapturePermissionGrantType="grant"
              onError={(e) => {
                console.error("[SumsubWebModal] WebView error", e.nativeEvent);
              }}
            />
          ) : (
            <View direction="column" align="center" justify="center" padding="lg" fill="grow">
              <Text size="md" emphasis align="center">
                {t("screen.SumsubWebModal.openInBrowser")}
              </Text>
              <Text size="md" muted align="center">
                {url ? url : t("screen.SumsubWebModal.verificationLinkUnavailable")}
              </Text>
            </View>
          )}
        </RNView>
      </View>
    </Layer>
  );
};

// Structural flex host for the WebView (native child).
const styles = StyleSheet.create({
  body: { flex: 1 },
});

export default SumsubWebModal;
