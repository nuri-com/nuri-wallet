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
  useNuriTheme,
  View as DsView,
} from "@ds";
import { WALLET_RP_ID } from "../config/passkey";
import { normalizePrfOutput, zeroize } from "../lib/crypto";
import { t } from "../lib/i18n";
import { formatWalletPasskeyLabel } from "../lib/passkeyLabels";
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

const buildHtml = (
  createLabel: string,
  createButtonText: string,
  restoreLinkText: string,
  colors: LoginColors,
): string => `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no" />
    <title>Stateless Bitcoin Passkey</title>
    <style>
      body { margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif; background: transparent; display:flex; flex-direction:column; justify-content:flex-end; height:100vh; }
      .bar { padding:16px 16px calc(32px + env(safe-area-inset-bottom, 0px)) 16px; position:relative; }
      button { width:100%; padding:0 32px; min-height:48px; border-radius:100px; border:none; font-size:16px; margin:0 0 12px 0; font-weight:600; display:flex; align-items:center; justify-content:center; color:${colors.pillFg}; box-sizing:border-box; outline:none; -webkit-tap-highlight-color:transparent; }
      button:focus, button:focus-visible { outline:none; }
      #create { background:${colors.pillBg}; }
      #have { width:100%; padding:16px 0; font-size:16px; margin:8px 0 0 0; font-weight:500; display:flex; align-items:center; justify-content:center; background:transparent; border:none; color:${colors.linkFg}; cursor:pointer; text-decoration:underline; box-sizing:border-box; }
      #create svg { height:20px; width:20px; margin-left:8px; flex-shrink:0; }
      #create span { display:inline-block; }
    </style>
  </head>
  <body>
    <div class="bar">
      <button id="create" type="button" aria-disabled="false">
        <span>${escapeHtml(createButtonText)}</span>
        <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.0001 5C13.0001 5.55216 12.5522 5.9998 12.0001 6L9.00012 6C7.34327 6 6.00012 7.34315 6.00012 9L6.00012 12C6.00012 12.5522 5.55224 12.9998 5.00012 13C4.44784 13 4.00012 12.5523 4.00012 12L4.00012 9C4.00012 6.23858 6.2387 4 9.00012 4L12.0001 4C12.5522 4.0002 13.0001 4.44784 13.0001 5ZM13.0001 27C13.0001 27.5523 12.5524 28 12.0001 28L9.00012 28C6.2387 28 4.00012 25.7614 4.00012 23L4.00012 20C4.00012 19.4477 4.44784 19 5.00012 19C5.55241 19 6.00012 19.4477 6.00012 20L6.00012 23C6.00012 24.6569 7.34327 26 9.00012 26L12.0001 26C12.5524 26 13.0001 26.4477 13.0001 27ZM12.0001 12C12.0001 12.5523 11.5524 13 11.0001 13C10.4478 13 10.0001 12.5523 10.0001 12L10.0001 11C10.0001 10.4477 10.4478 10 11.0001 10C11.5524 10 12.0001 10.4477 12.0001 11L12.0001 12ZM20.4474 20.1055C20.9413 20.3524 21.1414 20.9533 20.8947 21.4473L20.0001 21C20.8341 21.417 20.8901 21.4458 20.8937 21.4482L20.8937 21.4492L20.8917 21.4521L20.8898 21.457L20.8829 21.4707L20.8644 21.5049C20.8498 21.5315 20.8301 21.5655 20.8058 21.6055C20.7572 21.6855 20.6883 21.7911 20.5968 21.9131C20.414 22.1568 20.1383 22.4707 19.7501 22.7813C18.9606 23.4129 17.743 24 16.0001 24C14.2572 24 13.0397 23.4129 12.2501 22.7813C11.8619 22.4707 11.5862 22.1568 11.4034 21.9131C11.312 21.7912 11.2431 21.6855 11.1945 21.6055C11.1702 21.5655 11.1505 21.5314 11.1359 21.5049L11.1173 21.4707L11.1105 21.457L11.1075 21.4521L11.1066 21.4492L11.1066 21.4482C11.1119 21.445 11.1792 21.4105 12.0001 21L11.1056 21.4473C10.8587 20.9533 11.0589 20.3524 11.5529 20.1055C12.0428 19.8606 12.6382 20.0557 12.8888 20.541C12.8906 20.5443 12.8952 20.5538 12.9034 20.5674C12.9212 20.5967 12.954 20.6475 13.0031 20.7129C13.1015 20.8441 13.2636 21.0305 13.5001 21.2197C13.9607 21.588 14.7434 22 16.0001 22C17.2569 22 18.0396 21.588 18.5001 21.2197C18.7367 21.0305 18.8988 20.8441 18.9972 20.7129C19.0462 20.6475 19.079 20.5967 19.0968 20.5674C19.105 20.5538 19.1096 20.5443 19.1115 20.541C19.3621 20.0558 19.9574 19.8605 20.4474 20.1055ZM17.0001 15C17.0001 16.6569 15.657 18 14.0001 18L13.0001 18C12.4478 18 12.0001 17.5523 12.0001 17C12.0001 16.4477 12.4478 16 13.0001 16L14.0001 16C14.5524 16 15.0001 15.5523 15.0001 15L15.0001 11C15.0001 10.4477 15.4478 10 16.0001 10C16.5524 10 17.0001 10.4477 17.0001 11L17.0001 15ZM28.0001 12C28.0001 12.5522 27.5522 12.9998 27.0001 13C26.4478 13 26.0001 12.5523 26.0001 12L26.0001 9C26.0001 7.34327 24.6568 6.0002 23.0001 6L20.0001 6C19.4478 6 19.0001 5.55228 19.0001 5C19.0001 4.44772 19.4478 4 20.0001 4L23.0001 4C25.7614 4.0002 28.0001 6.2387 28.0001 9L28.0001 12ZM28.0001 23C28.0001 25.7614 25.7615 28 23.0001 28L20.0001 28C19.4478 28 19.0001 27.5523 19.0001 27C19.0001 26.4477 19.4478 26 20.0001 26L23.0001 26C24.657 26 26.0001 24.6569 26.0001 23L26.0001 20C26.0001 19.4477 26.4478 19 27.0001 19C27.5524 19 28.0001 19.4477 28.0001 20L28.0001 23ZM22.0001 12C22.0001 12.5523 21.5524 13 21.0001 13C20.4478 13 20.0001 12.5523 20.0001 12L20.0001 11C20.0001 10.4477 20.4478 10 21.0001 10C21.5524 10 22.0001 10.4477 22.0001 11L22.0001 12Z" fill="${colors.pillFg}"/></svg>
      </button>
      <div id="have" role="link" tabindex="0" aria-disabled="false">${escapeHtml(restoreLinkText)}</div>
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
  const html = useMemo(
    () => buildHtml(passkeyLabel, createWalletLabel, restoreWalletLabel, colors),
    [passkeyLabel, createWalletLabel, restoreWalletLabel, colors],
  );

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
