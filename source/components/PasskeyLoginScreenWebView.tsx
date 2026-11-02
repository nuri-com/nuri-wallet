// @screen auth.login.webview
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import {
  Button,
  ButtonText,
  Footer,
  NuriScope,
  Screen,
  Text,
  typeStyle,
  useNuriSafeAreaInsets,
  useNuriTheme,
  View as DsView,
} from "@ds";
import { WALLET_RP_ID } from "../config/passkey";
import { normalizePrfOutput, zeroize } from "../lib/crypto";
import { t } from "../lib/i18n";
import { formatWalletPasskeyLabel } from "../lib/passkeyLabels";
import { BOTTOM_GAP_WITH_INSET, bottomGapPx } from "../lib/ui/bottomGap";
import type { PasskeyLoginScreenProps } from "./PasskeyLoginScreen";

type Props = Omit<PasskeyLoginScreenProps, "visible">;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

type LoginColors = { pillBg: string; pillFg: string; linkFg: string };

/**
 * The page draws the same landing actions the web and Android screens draw with
 * the DS (a large solid Button, the restore link, the shared AppFooter), so it
 * uses the DS numbers: the large button is 60 tall (DS size xl) with 24 side
 * padding (space xl), stacked 6 apart (space sm) in an 18-wide bar (space lg),
 * and its text is the DS md emphasis type. Only the passkey ceremony needs this
 * page (WKWebView requires the tap inside it); how it looks must not differ.
 */
export const LANDING_BUTTON_HEIGHT = 60;
export const LANDING_BUTTON_PADDING_X = 24;
export const LANDING_STACK_GAP = 6;
export const LANDING_BAR_PADDING_X = 18;

type LoginType = {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontWeight: string;
};

const buildHtml = (
  createLabel: string,
  createButtonText: string,
  restoreLinkText: string,
  colors: LoginColors,
  type: LoginType,
  bottomGap: number,
): string => `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no" />
    <title>Stateless Bitcoin Passkey</title>
    <style>
      body { margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif; background: transparent; display:flex; flex-direction:column; justify-content:flex-end; height:100vh; }
      .bar { padding:0 ${LANDING_BAR_PADDING_X}px ${bottomGap}px ${LANDING_BAR_PADDING_X}px; display:flex; flex-direction:column; gap:${LANDING_STACK_GAP}px; }
      .label { font-size:${type.fontSize}px; line-height:${type.lineHeight}px; letter-spacing:${type.letterSpacing}px; font-weight:${type.fontWeight}; }
      button { width:100%; padding:0 ${LANDING_BUTTON_PADDING_X}px; min-height:${LANDING_BUTTON_HEIGHT}px; border-radius:9999px; border:none; margin:0; display:flex; align-items:center; justify-content:center; color:${colors.pillFg}; box-sizing:border-box; outline:none; -webkit-tap-highlight-color:transparent; font-family:inherit; }
      button:focus, button:focus-visible { outline:none; }
      #create { background:${colors.pillBg}; }
      #have { width:100%; padding:${LANDING_STACK_GAP}px 0; margin:0; display:flex; align-items:center; justify-content:center; background:transparent; border:none; color:${colors.linkFg}; cursor:pointer; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
    </style>
  </head>
  <body>
    <div class="bar">
      <button id="create" class="label" type="button" aria-disabled="false"><span>${escapeHtml(createButtonText)}</span></button>
      <div id="have" class="label" role="link" tabindex="0" aria-disabled="false">${escapeHtml(restoreLinkText)}</div>
    </div>
    <script>
      (function(){
        var busy = false;
        function setBusy(state){
          busy = !!state;
          var createEl = document.getElementById("create");
          if (createEl) {
            createEl.disabled = busy;
            createEl.style.opacity = busy ? "0.5" : "1";
            createEl.setAttribute("aria-disabled", busy ? "true" : "false");
          }
          var haveEl = document.getElementById("have");
          if (haveEl) {
            haveEl.style.opacity = busy ? "0.5" : "1";
            haveEl.style.pointerEvents = busy ? "none" : "auto";
            haveEl.setAttribute("aria-disabled", busy ? "true" : "false");
          }
        }
        window.__nuri_resetBusy = function(){ setBusy(false); };
        function post(m){ try { window.ReactNativeWebView.postMessage(m); } catch(_){} }
        function strToBytes(str){ try { if (window.TextEncoder) return new TextEncoder().encode(str); } catch(_){} var out=new Uint8Array(str.length); for(var i=0;i<str.length;i++) out[i]=str.charCodeAt(i)&0xff; return out; }
        function toB64(buf){ try{ var bytes=new Uint8Array(buf); var bin=""; for(var i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]); return btoa(bin);}catch(e){ post("error:toB64:"+(e&&e.message?e.message:e)); return ""; } }
        function b64u(buf){ return toB64(buf).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,""); }
        var salt = strToBytes("nuri-prf-salt-v1");
        var rpId = "${WALLET_RP_ID || "nuri.com"}";
        var createLabel = ${JSON.stringify(createLabel)};
        try { var host=(location.hostname||"").toLowerCase(); if (host && host.endsWith("${WALLET_RP_ID || "nuri.com"}")) rpId="${WALLET_RP_ID || "nuri.com"}"; } catch(_){ rpId="${WALLET_RP_ID || "nuri.com"}"; }
        function buildLabel(){
          return createLabel || "Nuri";
        }
        async function runCreateAndPrf(){
          var success = false;
          try{
            if (!navigator.credentials || !window.PublicKeyCredential) {
              post("error:webauthn:not_supported");
              return;
            }
            var userId = new Uint8Array(16);
            crypto.getRandomValues(userId);
            var challengeCreate = new Uint8Array(32);
            crypto.getRandomValues(challengeCreate);
            var label = buildLabel();
            var createOpts = {
              publicKey: {
                challenge: challengeCreate,
                rp: { id: rpId, name: "Nuri Wallet" },
                user: { id: userId, name: label, displayName: label },
                pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
                timeout: 60000,
                extensions: { prf: { enable: true } }
              }
            };
            var cred = await navigator.credentials.create(createOpts);
            if (!cred) { post("error:create:empty_credential"); return; }
            var rawIdCreate = null;
            var credIdB64u = "";
            try {
              rawIdCreate = cred.rawId || null;
              if (rawIdCreate) {
                credIdB64u = b64u(new Uint8Array(rawIdCreate));
              }
            } catch(_) {}
            var credPubB64u = "";
            try {
              var spki = cred.response && cred.response.getPublicKey ? cred.response.getPublicKey() : null;
              if (spki) credPubB64u = b64u(new Uint8Array(spki));
            } catch(_) {}
            var challengeGet = new Uint8Array(32);
            crypto.getRandomValues(challengeGet);
            var allowCredentials = [];
            if (rawIdCreate) {
              allowCredentials.push({
                id: rawIdCreate,
                type: "public-key"
              });
            }
            var getOpts = {
              publicKey: {
                challenge: challengeGet,
                rpId: rpId,
                userVerification: "required",
                timeout: 60000,
                extensions: { prf: { eval: { first: salt } } }
              }
            };
            if (allowCredentials.length) {
              getOpts.publicKey.allowCredentials = allowCredentials;
            }
            var assertion = await navigator.credentials.get(getOpts);
            if (!assertion) { post("error:get:empty_assertion"); return; }
            var ext = assertion && assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : null;
            if (!ext || !ext.prf || !ext.prf.results || !ext.prf.results.first) { post("error:get:no_prf"); return; }
            var prfBuf = ext.prf.results.first;
            var b64 = toB64(prfBuf);
            if (!b64) { post("error:get:empty_prf_b64"); return; }
            post("wallet_prf_create:" + b64 + ":" + (credIdB64u||"") + ":" + (credPubB64u||""));
            success = true;
          } catch(e){ var name=e&&e.name?e.name:"Error"; var msg=e&&e.message?e.message:String(e); post("error:create_prf:"+name+":"+msg); }
          finally { if (!success) setBusy(false); }
        }
        async function runAuthOnlyPrf(){
          var success = false;
          try{
            if (!navigator.credentials || !window.PublicKeyCredential) {
              post("error:webauthn:not_supported_auth_only");
              return;
            }
            var challengeGet = new Uint8Array(32);
            crypto.getRandomValues(challengeGet);
            var getOpts = {
              publicKey: {
                challenge: challengeGet,
                rpId: rpId,
                userVerification: "required",
                timeout: 60000,
                extensions: { prf: { eval: { first: salt } } }
              }
            };
            var assertion = await navigator.credentials.get(getOpts);
            if (!assertion) { post("error:get_auth_only:empty_assertion"); return; }
            var ext = assertion && assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : null;
            if (!ext || !ext.prf || !ext.prf.results || !ext.prf.results.first) { post("error:get_auth_only:no_prf"); return; }
            var prfBuf = ext.prf.results.first;
            var b64 = toB64(prfBuf);
            if (!b64) { post("error:get_auth_only:empty_prf_b64"); return; }
            var credIdB64u = "";
            try {
              var rawIdGet = assertion.rawId || null;
              if (rawIdGet) {
                credIdB64u = b64u(new Uint8Array(rawIdGet));
              }
            } catch(_) {}
            post("wallet_prf_import:" + b64 + ":" + (credIdB64u||""));
            success = true;
          } catch(e){ var name=e&&e.name?e.name:"Error"; var msg=e&&e.message?e.message:String(e); post("error_auth_only:"+name+":"+msg); }
          finally { if (!success) setBusy(false); }
        }
        function triggerHave(){
          if (busy) return;
          if (!window.__statelessAuthOnly) return;
          setBusy(true);
          post("info:passkey_existing_tapped");
          window.__statelessAuthOnly();
        }
        var haveEl = document.getElementById("have");
        if (haveEl) {
          haveEl.onclick = triggerHave;
          haveEl.onkeydown = function(e){
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              triggerHave();
            }
          };
        }
        document.getElementById("create").onclick = function(){ if (busy) return; setBusy(true); post("info:passkey_create_tapped"); runCreateAndPrf(); };
        window.__statelessAuthOnly = function(){ runAuthOnlyPrf(); };
      })();
    </script>
  </body>
</html>`;

// The create pill is the DS neutral solid surface (dark), pinned via scope so
// the in-page colors track the theme regardless of the ambient accent.
export default function PasskeyLoginScreenWebView(props: Props) {
  return (
    <NuriScope accent="neutral">
      <PasskeyLoginScreenWebViewInner {...props} />
    </NuriScope>
  );
}

function PasskeyLoginScreenWebViewInner({
  footerMessage,
  resetSignal,
  onPayloadReady,
  onError,
  onAttemptStart,
  onDismiss,
}: Props) {
  const prfRef = useRef<Uint8Array | null>(null);
  const webViewRef = useRef<WebView>(null);
  const [webauthnUnsupported, setWebauthnUnsupported] = useState(false);
  const passkeyLabel = useMemo(() => formatWalletPasskeyLabel(), []);
  const createWalletLabel = t("screen.PasskeyLoginScreen.passkeyButton");
  const restoreWalletLabel = t("screen.PasskeyLoginScreen.restoreWallet");
  const theme = useNuriTheme();
  const colors = useMemo<LoginColors>(
    () => ({
      pillBg: theme.surface.solid.bg ?? theme.text.primary,
      pillFg: theme.surface.solid.fg,
      linkFg: theme.text.primary,
    }),
    [theme],
  );
  const labelType = useMemo<LoginType>(() => {
    const style = typeStyle("md", true);
    return {
      fontSize: style.fontSize ?? 17,
      lineHeight: style.lineHeight ?? 22,
      letterSpacing: style.letterSpacing ?? 0,
      fontWeight: String(style.fontWeight ?? "600"),
    };
  }, []);
  // The bottom gap every screen uses (lib/ui/bottomGap). With a message below
  // the page, the Screen adds the inset under that message instead.
  const insets = useNuriSafeAreaInsets();
  const bottomGap = footerMessage ? BOTTOM_GAP_WITH_INSET : bottomGapPx(insets.bottom);
  // Built with the gap at first render only: rebuilding the HTML reloads the
  // page mid-ceremony. Later changes are applied in place below.
  const initialBottomGapRef = useRef(bottomGap);
  const html = useMemo(
    () =>
      buildHtml(
        passkeyLabel,
        createWalletLabel,
        restoreWalletLabel,
        colors,
        labelType,
        initialBottomGapRef.current,
      ),
    [passkeyLabel, createWalletLabel, restoreWalletLabel, colors, labelType],
  );
  useEffect(() => {
    webViewRef.current?.injectJavaScript(
      `(function(){var b=document.querySelector(".bar");if(b)b.style.paddingBottom="${bottomGap}px";})();true;`,
    );
  }, [bottomGap]);

  const cleanup = useCallback(() => {
    if (prfRef.current) {
      zeroize(prfRef.current);
      prfRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  useEffect(() => {
    if (resetSignal === undefined) return;
    cleanup();
    webViewRef.current?.injectJavaScript(
      "window.__nuri_resetBusy && window.__nuri_resetBusy(); true;",
    );
  }, [resetSignal, cleanup]);

  const storePrf = useCallback((nextPrf: Uint8Array) => {
    if (prfRef.current) {
      zeroize(prfRef.current);
    }
    prfRef.current = nextPrf;
  }, []);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const data = event.nativeEvent.data ?? "";
      if (typeof data !== "string") return;

      if (data.startsWith("wallet_prf_create:") || data.startsWith("wallet_prf_import:")) {
        const isNew = data.startsWith("wallet_prf_create:");
        const parts = data.split(":");
        const prfBase64 = parts[1] || "";
        const credIdB64u = parts[2] || undefined;
        const credPubkeyB64u = parts[3] || undefined;

        let prfBytes: Uint8Array;
        try {
          prfBytes = normalizePrfOutput(prfBase64);
        } catch {
          onError("Empty PRF payload");
          return;
        }

        if (!prfBytes.length) {
          onError("Empty PRF payload");
          return;
        }

        storePrf(prfBytes);
        onPayloadReady({ prf: prfBytes, isNew, credIdB64u, credPubkeyB64u });
        return;
      }

      if (data.startsWith("info:passkey_")) {
        onAttemptStart?.();
        return;
      }

      if (data.startsWith("error:") || data.startsWith("error_auth_only:")) {
        if (data.includes("webauthn:not_supported") || data.includes("webauthn_not_supported")) {
          setWebauthnUnsupported(true);
        }
        onError(data);
      }
    },
    [onAttemptStart, onPayloadReady, onError, storePrf],
  );

  if (webauthnUnsupported) {
    return (
      <View style={styles.unsupportedContainer}>
        <DsView variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
          <Text size="md" emphasis>
            {t("screen.PasskeyLoginScreen.webauthnUnavailableTitle")}
          </Text>
          <Text size="md" muted>
            {t("screen.PasskeyLoginScreen.webauthnUnavailableBody")}
          </Text>
          {onDismiss ? (
            <Button size="sm" variant="solid" accent="neutral" onPress={onDismiss}>
              <ButtonText>{t("common.close")}</ButtonText>
            </Button>
          ) : null}
        </DsView>
      </View>
    );
  }

  return (
    <Screen safeAreaBottom={Boolean(footerMessage)}>
      <WebView
        ref={webViewRef}
        source={{ html, baseUrl: "https://nuri.com" }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        onMessage={handleMessage}
        style={styles.webview}
        containerStyle={styles.webviewContainer}
      />
      {footerMessage ? (
        <Footer paddingX="md" paddingBottom="xs" align="center">
          <Text size="sm" align="center">
            {footerMessage}
          </Text>
        </Footer>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: "transparent",
    zIndex: 1,
  },
  webviewContainer: {
    backgroundColor: "transparent",
  },

  unsupportedContainer: {
    marginHorizontal: 20,
    marginTop: 24,
  },
});
