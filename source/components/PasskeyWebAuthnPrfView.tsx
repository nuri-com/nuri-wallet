import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Button, ButtonText, NuriScope, Text, useNuriTheme, View } from "@ds";
import { PRF_SALT } from "../config/constants";
import { WALLET_RP_ID } from "../config/passkey";
import { normalizePrfOutput, zeroize } from "../lib/crypto";
import PasskeyWebAuthnPrfWeb from "./PasskeyWebAuthnPrfWeb";

const DEFAULT_PASSKEY_LABEL = "Nuri Wallet";

export type PasskeyWebAuthnPrfCreateResult = {
  kind: "create";
  prf: Uint8Array;
  prfB64u: string;
  credIdB64u: string;
  credPubkeyB64u: string;
};

export type PasskeyWebAuthnPrfAssertionResult = {
  kind: "assertion";
  /** Present only for the PRF (unlock) variant; the signing-assertion variant
   *  requests no PRF, so these are omitted. */
  prf?: Uint8Array;
  prfB64u?: string;
  credIdB64u: string;
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
};

export type PasskeyWebAuthnPrfProps = {
  mode: "create" | "assertion";
  buttonLabel: string;
  challengeB64u?: string;
  credIdB64u?: string;
  rpId?: string;
  /** PRF eval salt (UTF-8). Must match the salt the credential was created with. */
  prfSalt?: string;
  /** Whether to request/require the PRF extension. True for key-derivation
   *  (create / unlock); false for signing assertions, which need no PRF. */
  requestPrf?: boolean;
  /** Passkey display name used on create (shown in the OS passkey manager). */
  label?: string;
  /** Fill the parent (flex:1) with the button anchored to the bottom, instead of
   * a fixed 56px strip. Used for the fullscreen passkey confirm so the WebView
   * reliably lays out (a tiny embedded WebView can render blank). */
  fillScreen?: boolean;
  /** Render as a fully transparent, edge-to-edge tap target meant to be absolutely
   * positioned ON TOP of a real (design-system) button. The visible button shows
   * through; the tap lands in this WebView (giving WKWebView focus + activation). */
  overlay?: boolean;
  disabled?: boolean;
  onAttemptStart?: () => void;
  onCreateResult?: (result: PasskeyWebAuthnPrfCreateResult) => void;
  onAssertionResult?: (result: PasskeyWebAuthnPrfAssertionResult) => void;
  onError: (message: string) => void;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

type ButtonColors = { bg: string; fg: string; pressedBg: string };

function buildHtml(opts: {
  buttonLabel: string;
  fillScreen: boolean;
  overlay: boolean;
  colors: ButtonColors;
}): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" />
    <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no" />
    <style>
      html, body { ${opts.fillScreen || opts.overlay ? "height:100%;" : ""} }
      body { margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif; background:transparent; ${opts.fillScreen ? "display:flex; flex-direction:column; justify-content:flex-end;" : ""} }
      .wrap { ${opts.overlay ? "padding:0; height:100%;" : opts.fillScreen ? "padding:16px 24px 40px;" : "padding:0;"} }
      button { ${opts.overlay ? "position:absolute; inset:0; width:100%; height:100%; border:none; background:transparent; color:transparent; display:flex; align-items:center; justify-content:center; border-radius:100px; font-size:16px; font-weight:600;" : `width:100%; padding:16px 24px; border-radius:100px; border:none; background:${opts.colors.bg}; color:${opts.colors.fg}; font-size:16px; font-weight:600;`} box-sizing:border-box; outline:none; -webkit-tap-highlight-color:transparent; }
      button:disabled { opacity:0.5; }
      /* DS pressed state: the lilac solid surface's pressedBg from the live
         theme. In overlay mode the button is transparent over the native
         button, so on press it paints the pressed pill + reveals the label
         (carried in via buttonLabel). */
      button:active { background:${opts.colors.pressedBg};${opts.overlay ? ` color:${opts.colors.fg};` : ""} }
      button:focus, button:focus-visible { outline:none; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <button id="run" type="button">${escapeHtml(opts.buttonLabel)}</button>
    </div>
    <script>
      (function(){
        // SECURITY: server-controlled inputs (rpId / challenge / credId) are NEVER
        // interpolated into this script — they arrive as a parsed bridge JSON object
        // (injectedJavaScriptObject), so a value containing </scr"+"ipt> cannot break
        // out and run. The native side also validates rpId === nuri.com and strict
        // base64url challenge/credId before mounting, and the CSP above
        // (default-src 'none') blocks any network exfiltration.
        var mode, rpId, challengeB64u, credIdB64u, prfSaltText, label, requestPrf;
        function readInjected(){
          var injected = {};
          try { injected = JSON.parse(window.ReactNativeWebView.injectedObjectJson() || "{}"); } catch(_){}
          mode = injected.mode === "create" ? "create" : "assertion";
          rpId = String(injected.rpId || "");
          challengeB64u = String(injected.challengeB64u || "");
          credIdB64u = String(injected.credIdB64u || "");
          prfSaltText = String(injected.prfSalt || "");
          label = String(injected.label || "Nuri Wallet");
          requestPrf = injected.requestPrf !== false;
        }
        var busy = false;
        function post(m){ try { window.ReactNativeWebView.postMessage(m); } catch(_){} }
        function setBusy(next){
          busy = !!next;
          var btn = document.getElementById("run");
          if (btn) btn.disabled = busy;
        }
        function strToBytes(str){
          try { if (window.TextEncoder) return new TextEncoder().encode(str); } catch(_){}
          var out = new Uint8Array(str.length);
          for (var i=0;i<str.length;i++) out[i] = str.charCodeAt(i) & 0xff;
          return out;
        }
        function b64uToBytes(value){
          var b64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
          while (b64.length % 4) b64 += "=";
          var bin = atob(b64);
          var out = new Uint8Array(bin.length);
          for (var i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
          return out;
        }
        function toB64u(buf){
          var bytes = new Uint8Array(buf);
          var bin = "";
          for (var i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
          return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
        }
        async function createPasskey(){
          var userId = new Uint8Array(16);
          crypto.getRandomValues(userId);
          var createChallenge = new Uint8Array(32);
          crypto.getRandomValues(createChallenge);
          var created = await navigator.credentials.create({
            publicKey: {
              challenge: createChallenge,
              rp: { id: rpId, name: "Nuri Wallet" },
              user: { id: userId, name: label, displayName: label },
              pubKeyCredParams: [{ type: "public-key", alg: -7 }],
              authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
              timeout: 60000,
              extensions: { prf: { enable: true } }
            }
          });
          if (!created) throw new Error("empty_create_credential");
          var rawId = created.rawId || null;
          if (!rawId) throw new Error("missing_create_raw_id");
          var credId = toB64u(rawId);
          var credPubkey = "";
          try {
            var spki = created.response && created.response.getPublicKey ? created.response.getPublicKey() : null;
            if (spki) credPubkey = toB64u(spki);
          } catch(_) {}
          var getChallenge = new Uint8Array(32);
          crypto.getRandomValues(getChallenge);
          var assertion = await navigator.credentials.get({
            publicKey: {
              challenge: getChallenge,
              rpId: rpId,
              userVerification: "required",
              timeout: 60000,
              allowCredentials: [{ id: rawId, type: "public-key" }],
              extensions: { prf: { eval: { first: strToBytes(prfSaltText) } } }
            }
          });
          if (!assertion) throw new Error("empty_create_prf_assertion");
          var ext = assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : null;
          var prf = ext && ext.prf && ext.prf.results ? ext.prf.results.first : null;
          if (!prf) throw new Error("missing_create_prf");
          post(["create", toB64u(prf), credId, credPubkey].join(":"));
        }
        async function assertPasskey(){
          if (!challengeB64u) throw new Error("missing_challenge");
          var allowCredentials = [];
          if (credIdB64u) {
            allowCredentials.push({ id: b64uToBytes(credIdB64u), type: "public-key" });
          }
          var publicKey = {
            challenge: b64uToBytes(challengeB64u),
            rpId: rpId,
            userVerification: "required",
            timeout: 60000
          };
          // PRF is requested ONLY for key-derivation (unlock) ceremonies. The
          // per-spend signing assertion sets requestPrf=false, so the root PRF is
          // never evaluated, transported, or required for signing.
          if (requestPrf) {
            publicKey.extensions = { prf: { eval: { first: strToBytes(prfSaltText) } } };
          }
          if (allowCredentials.length) publicKey.allowCredentials = allowCredentials;
          var assertion = await navigator.credentials.get({ publicKey: publicKey });
          if (!assertion) throw new Error("empty_assertion");
          var prfB64 = "";
          if (requestPrf) {
            var ext = assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : null;
            var prf = ext && ext.prf && ext.prf.results ? ext.prf.results.first : null;
            if (!prf) throw new Error("missing_assertion_prf");
            prfB64 = toB64u(prf);
          }
          var response = assertion.response || {};
          post([
            "assertion",
            prfB64,
            toB64u(assertion.rawId || new Uint8Array()),
            toB64u(response.clientDataJSON || new Uint8Array()),
            toB64u(response.authenticatorData || new Uint8Array()),
            toB64u(response.signature || new Uint8Array())
          ].join(":"));
        }
        async function run(){
          if (busy) return;
          setBusy(true);
          post("info:attempt_start");
          readInjected();
          // WebKit requires the document to be focused for navigator.credentials.
          // A hidden/background WebView isn't focused by default — try to grab it.
          try { window.focus(); } catch(_){}
          try { var b=document.getElementById("run"); if (b && b.focus) b.focus(); } catch(_){}
          try {
            if (!navigator.credentials || !window.PublicKeyCredential) throw new Error("webauthn_not_supported");
            if (mode === "create") await createPasskey();
            else await assertPasskey();
          } catch(e) {
            var name = e && e.name ? e.name : "Error";
            var msg = e && e.message ? e.message : String(e);
            post("error:" + mode + ":" + name + ":" + msg);
            setBusy(false);
          }
        }
        document.getElementById("run").onclick = run;
        (function(){
          // Pressed feedback = the DS lilac solid pressedBg from the live theme.
          // iOS WebKit doesn't apply :active on touch, so drive it explicitly.
          var b = document.getElementById("run");
          if (!b) return;
          function press(on){
            if (b.disabled) return;
            b.style.background = on ? "${opts.colors.pressedBg}" : "";
            ${opts.overlay ? `b.style.color = on ? "${opts.colors.fg}" : "";` : ""}
          }
          b.addEventListener("touchstart", function(){ press(true); }, { passive: true });
          ["touchend","touchcancel"].forEach(function(ev){
            b.addEventListener(ev, function(){ press(false); }, { passive: true });
          });
        })();
      })();
    </script>
  </body>
</html>`;
}

// The ceremony button is always the DS lilac solid surface; the scope pins the
// accent so the theme lookup below is lilac regardless of the ambient accent.
export default function PasskeyWebAuthnPrfView(props: PasskeyWebAuthnPrfProps) {
  return (
    <NuriScope accent="lilac">
      {/* In a browser the ceremony runs in the page itself: the WebView below is
          an about:srcdoc iframe, which inherits the app's CSP and therefore
          cannot execute its own inline scripts under `script-src 'self'`. */}
      {Platform.OS === "web" ? (
        <PasskeyWebAuthnPrfWeb {...props} />
      ) : (
        <PasskeyWebAuthnPrfViewInner {...props} />
      )}
    </NuriScope>
  );
}

function PasskeyWebAuthnPrfViewInner({
  mode,
  buttonLabel,
  challengeB64u = "",
  credIdB64u = "",
  rpId = WALLET_RP_ID,
  prfSalt = PRF_SALT,
  requestPrf = true,
  label = DEFAULT_PASSKEY_LABEL,
  fillScreen = false,
  overlay = false,
  disabled,
  onAttemptStart,
  onCreateResult,
  onAssertionResult,
  onError,
}: PasskeyWebAuthnPrfProps) {
  const prfRef = useRef<Uint8Array | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const theme = useNuriTheme();
  const solid = theme.surface.solid;
  const colors = useMemo<ButtonColors>(
    () => ({
      bg: solid.bg ?? "transparent",
      fg: solid.fg,
      pressedBg: solid.pressedBg ?? solid.fg,
    }),
    [solid],
  );
  const html = useMemo(
    () => buildHtml({ buttonLabel, fillScreen, overlay, colors }),
    [buttonLabel, fillScreen, overlay, colors],
  );

  // Untrusted values reach the WebView as a bridge JSON object, never interpolated
  // into the page script (see buildHtml). The script reads them via
  // window.ReactNativeWebView.injectedObjectJson().
  const injectedObject = useMemo(
    () => ({ mode, rpId, challengeB64u, credIdB64u, prfSalt, label, requestPrf }),
    [mode, rpId, challengeB64u, credIdB64u, prfSalt, label, requestPrf],
  );

  // Defense-in-depth on the server-controlled inputs: only ever drive the WebView
  // for our own rp_id, and reject anything that isn't strict base64url. Fails
  // closed via onError so the ceremony never runs on attacker-shaped input.
  const inputError = useMemo<string | null>(() => {
    if (rpId !== WALLET_RP_ID) return "invalid_rp_id";
    const B64U = /^[A-Za-z0-9_-]+$/;
    if (mode === "assertion" && (!challengeB64u || !B64U.test(challengeB64u))) {
      return "invalid_challenge";
    }
    if (credIdB64u && !B64U.test(credIdB64u)) return "invalid_cred_id";
    return null;
  }, [rpId, mode, challengeB64u, credIdB64u]);

  useEffect(() => {
    if (inputError) onError(`error:${mode}:input_validation:${inputError}`);
  }, [inputError, mode, onError]);

  const replacePrf = useCallback((next: Uint8Array) => {
    if (prfRef.current) zeroize(prfRef.current);
    prfRef.current = next;
  }, []);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const data = event.nativeEvent.data ?? "";
      if (typeof data !== "string") return;

      if (data === "info:attempt_start") {
        onAttemptStart?.();
        return;
      }

      if (data.startsWith("create:")) {
        const [, prfB64u, credId, credPubkey] = data.split(":");
        try {
          const prf = normalizePrfOutput(prfB64u);
          replacePrf(prf);
          onCreateResult?.({
            kind: "create",
            prf,
            prfB64u,
            credIdB64u: credId || "",
            credPubkeyB64u: credPubkey || "",
          });
        } catch (error) {
          onError(error instanceof Error ? error.message : String(error));
        }
        return;
      }

      if (data.startsWith("assertion:")) {
        const [, prfB64u, credId, clientData, authData, sig] = data.split(":");
        try {
          // prfB64u is empty for signing assertions (requestPrf=false) — only the
          // unlock variant carries PRF.
          let prf: Uint8Array | undefined;
          if (prfB64u) {
            prf = normalizePrfOutput(prfB64u);
            replacePrf(prf);
          }
          onAssertionResult?.({
            kind: "assertion",
            prf,
            prfB64u: prfB64u || undefined,
            credIdB64u: credId || "",
            clientDataB64u: clientData || "",
            authDataB64u: authData || "",
            sigB64u: sig || "",
          });
        } catch (error) {
          onError(error instanceof Error ? error.message : String(error));
        }
        return;
      }

      if (data.startsWith("error:")) {
        if (data.includes("webauthn_not_supported")) setUnsupported(true);
        onError(data);
      }
    },
    [onAttemptStart, onCreateResult, onAssertionResult, onError, replacePrf],
  );

  if (unsupported) {
    return (
      <View variant="soft" accent="orange" radius="md" padding="md" direction="column" gap="xs">
        <Text size="sm" emphasis>
          WebAuthn unavailable
        </Text>
        <Text size="sm" muted>
          This debug flow needs WebAuthn PRF in WebView.
        </Text>
      </View>
    );
  }

  // Invalid (attacker-shaped) input → render nothing; onError already fired so the
  // overlay tears the ceremony down.
  if (inputError) {
    return null;
  }

  if (disabled) {
    return (
      <Button size="sm" variant="solid" accent="neutral" disabled onPress={() => {}}>
        <ButtonText>{buttonLabel}</ButtonText>
      </Button>
    );
  }

  return (
    <WebView
      source={{ html, baseUrl: "https://nuri.com" }}
      originWhitelist={["https://nuri.com"]}
      injectedJavaScriptObject={injectedObject}
      javaScriptEnabled
      domStorageEnabled
      onMessage={handleMessage}
      style={overlay ? styles.webviewOverlay : fillScreen ? styles.webviewFill : styles.webview}
      containerStyle={
        overlay ? styles.webviewOverlay : fillScreen ? styles.webviewFill : styles.webviewContainer
      }
    />
  );
}

const styles = StyleSheet.create({
  webview: {
    height: 56,
    backgroundColor: "transparent",
  },
  webviewContainer: {
    height: 56,
    backgroundColor: "transparent",
  },
  webviewFill: {
    flex: 1,
    backgroundColor: "transparent",
  },
  webviewOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "transparent",
  },
});
