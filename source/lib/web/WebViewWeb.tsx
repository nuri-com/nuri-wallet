/**
 * Web (PWA) implementation of `react-native-webview`, aliased in on the web
 * platform via metro.config.js. The native package ships only a "not supported
 * on this platform" stub for web, so we provide a real one backed by an
 * <iframe>:
 *   - source.uri  -> iframe src
 *   - source.html -> iframe srcDoc, with a window.ReactNativeWebView.postMessage
 *     bridge injected so existing onMessage handlers + injectedJavaScript keep
 *     working unchanged.
 *
 * Limits of a browser iframe (documented, not bugs):
 *   - onShouldStartLoadWithRequest / onNavigationStateChange can't observe
 *     cross-origin navigations -> best-effort no-ops.
 *   - injectJavaScript only reaches same-origin (srcDoc) content.
 * The `allow` attribute opts the iframe into WebAuthn/clipboard/camera/payment
 * so passkey and KYC pages function.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

export type WebViewMessageEvent = { nativeEvent: { data: string } };
export type WebViewNavigation = { url: string };
export type WebViewProps = {
  source?: { uri?: string; html?: string; baseUrl?: string };
  style?: StyleProp<ViewStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  onMessage?: (event: WebViewMessageEvent) => void;
  onLoad?: () => void;
  onLoadEnd?: () => void;
  onError?: (event: { nativeEvent: { description?: string } }) => void;
  injectedJavaScript?: string;
  injectedJavaScriptObject?: unknown;
  [key: string]: unknown;
};

// The inject listener evals whatever it receives, so it MUST only trust the
// embedding parent (this app). Without the `e.source !== window.parent` guard
// any window able to postMessage into this frame — a nested cross-origin
// iframe, an opener — could run arbitrary JS in the srcDoc context, which is
// same-origin with the app and can read the wallet keys from localStorage.
function buildRnwvBridge(injectedJavaScriptObject: unknown): string {
  const objectJson = JSON.stringify(injectedJavaScriptObject ?? {}) || "{}";
  // JSON is embedded in a script string. Escape `<` so attacker-controlled
  // values cannot terminate the script with a `</script>` sequence.
  const objectJsonLiteral = JSON.stringify(objectJson).replace(/</g, "\\u003c");
  return `<script>(function(){var injectedObjectJson=${objectJsonLiteral};window.ReactNativeWebView={postMessage:function(m){try{parent.postMessage(String(m),'*');}catch(e){}},injectedObjectJson:function(){return injectedObjectJson;}};window.addEventListener('message',function(e){try{if(e.source!==window.parent)return;if(e.data&&e.data.__rnwv_inject){(0,eval)(e.data.__rnwv_inject);}}catch(_){}});})();</script>`;
}

export const WebView = forwardRef<unknown, WebViewProps>(function WebViewWeb(
  props: WebViewProps,
  ref,
) {
  const {
    source,
    style,
    containerStyle,
    onMessage,
    onLoad,
    onLoadEnd,
    onError,
    injectedJavaScript,
    injectedJavaScriptObject,
  } = props;
  const iframeRef = useRef<{
    contentWindow?: { postMessage: (m: unknown, o: string) => void; eval?: (s: string) => void };
    src?: string;
  } | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      injectJavaScript: (js: string) => {
        const win = iframeRef.current?.contentWindow;
        try {
          win?.postMessage({ __rnwv_inject: js }, "*");
        } catch {}
        try {
          win?.eval?.(js);
        } catch {}
      },
      postMessage: (message: string) => {
        try {
          iframeRef.current?.contentWindow?.postMessage(String(message), "*");
        } catch {}
      },
      reload: () => {
        const el = iframeRef.current;
        // biome-ignore lint/correctness/noSelfAssign: reassigning src forces the iframe to reload
        if (el && el.src) el.src = el.src;
      },
      stopLoading: () => {},
      goBack: () => {},
      goForward: () => {},
    }),
    [],
  );

  useEffect(() => {
    if (!onMessage) return;
    const g = globalThis as unknown as {
      addEventListener?: (t: string, h: (e: unknown) => void) => void;
      removeEventListener?: (t: string, h: (e: unknown) => void) => void;
    };
    const handler = (ev: unknown) => {
      const e = ev as { source?: unknown; data?: unknown };
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      if (typeof e.data === "string") onMessage({ nativeEvent: { data: e.data } });
    };
    g.addEventListener?.("message", handler);
    return () => g.removeEventListener?.("message", handler);
  }, [onMessage]);

  const handleLoad = useCallback(() => {
    onLoad?.();
    onLoadEnd?.();
  }, [onLoad, onLoadEnd]);
  const handleError = useCallback(() => {
    onError?.({ nativeEvent: { description: "iframe_load_error" } });
  }, [onError]);

  const html = source?.html;
  const srcDoc =
    html != null
      ? buildRnwvBridge(injectedJavaScriptObject) +
        html +
        (injectedJavaScript ? `<script>${injectedJavaScript}<\/script>` : "")
      : undefined;

  return (
    <View style={[styles.fill, containerStyle, style]}>
      {React.createElement("iframe", {
        ref: iframeRef,
        src: source?.uri,
        srcDoc,
        onLoad: handleLoad,
        onError: handleError,
        // WebAuthn is scoped to 'self' (our own origin) — the passkey ceremony
        // runs as same-origin srcDoc, so it never needs a cross-origin grant,
        // and the previous `*` let any embedded provider page request
        // credentials. Camera/microphone/payment stay open for the cross-origin
        // KYC (Sumsub) and 3DS pages that legitimately need them.
        allow:
          "publickey-credentials-get 'self'; publickey-credentials-create 'self'; clipboard-read; clipboard-write; camera; microphone; payment",
        style: { border: "none", width: "100%", height: "100%", background: "transparent" },
      })}
    </View>
  );
});

const styles = { fill: { flex: 1, overflow: "hidden" } as ViewStyle };

export default WebView;
