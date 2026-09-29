// @screen v1-wallet-migration-screen
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { IconButton, useNuriTheme, View } from "@ds";
import ScreenHeader from "../../components/ScreenHeader";
import { Layer } from "../../components/LayerHost";

const V1_WALLET_URL = "https://v1.nuri.com";

type Props = {
  visible: boolean;
  onClose: () => void;
  bitcoinBoardingAddress: string;
  eoaAddress: string;
  nostrNpub: string;
  username: string;
  oldCredentialId?: string;
};

export default function V1WalletMigrationScreen({
  visible,
  onClose,
  bitcoinBoardingAddress,
  eoaAddress,
  nostrNpub,
  username,
  oldCredentialId,
}: Props) {
  const canvas = useNuriTheme().chrome.canvas.bg;
  const searchParams = new URLSearchParams({
    bitcoin: bitcoinBoardingAddress,
    eoa: eoaAddress,
    nostr: nostrNpub,
    username,
  });
  if (oldCredentialId) searchParams.set("oldCredentialId", oldCredentialId);
  // Tell v1 which scheme to redirect back to. From a Custom Tab the WebView
  // postMessage close path is unavailable, so v1 deep-links back into the app —
  // but dev/preview builds register nuri-dev:// / nuri-preview://, not nuri://.
  // Linking.createURL uses THIS build's registered scheme.
  const returnScheme = Linking.createURL("").replace(/:.*$/, "");
  if (returnScheme) searchParams.set("returnScheme", returnScheme);
  const sourceUrl = `${V1_WALLET_URL}?${searchParams.toString()}`;
  // Android WebView has no WebAuthn (native opt-in was reverted for OTA), so the
  // in-page passkey ceremony on v1.nuri.com dies silently — open a Custom Tab
  // (real Chrome) instead. iOS WebView supports WebAuthn and stays in-app.
  const isAndroid = Platform.OS === "android";
  const browserOpenedRef = useRef(false);
  useEffect(() => {
    if (!visible || !isAndroid) {
      browserOpenedRef.current = false;
      return;
    }
    if (browserOpenedRef.current) return;
    browserOpenedRef.current = true;
    void WebBrowser.openBrowserAsync(sourceUrl)
      .catch(() => console.warn("[V1WalletMigrationScreen] Failed to open migration browser"))
      .finally(onClose);
  }, [visible, isAndroid, sourceUrl, onClose]);

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as { type?: unknown };
      if (message.type === "nuri:legacy-migration:close") onClose();
    } catch {}
  };

  if (isAndroid) return null;

  return (
    <Layer visible={visible} onRequestClose={onClose}>
      <View chrome="canvas" direction="column" align="stretch" fill="grow">
        <ScreenHeader
          rightExtra={
            <IconButton icon="cross" variant="soft" accessibilityLabel="Close" onPress={onClose} />
          }
        />
        <View fill="grow">
          <WebView
            source={{ uri: sourceUrl }}
            backgroundColor={canvas}
            style={{ backgroundColor: canvas }}
            onMessage={handleMessage}
          />
        </View>
      </View>
    </Layer>
  );
}
