import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View as RNView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, ButtonText, View } from "@ds";
import BrandDisplayTitle from "./BrandDisplayTitle";
import { EventBus } from "../services/events/AppEventBusService";
import {
  type WebAuthnPrfRequestPayload,
  rejectPrfRequest,
  resolvePrfRequest,
} from "../services/auth/WebAuthnPrfService";
import WalletLockIllustration from "../assets/illustrations/wallet-lock.svg";
import { Layer } from "./LayerHost";
import PasskeyWebAuthnPrfView, {
  type PasskeyWebAuthnPrfAssertionResult,
  type PasskeyWebAuthnPrfCreateResult,
} from "./PasskeyWebAuthnPrfView";

const BUSY_MESSAGE = "webauthn_prf_overlay_busy";

/**
 * Global, always-mounted host for `WebAuthnPrfService`. Listens for
 * "webauthn:prfRequest" and presents a fullscreen confirm screen (same scaffold
 * as the payment-received / unlock screen) whose action button lives INSIDE the
 * WebView. The in-page tap is what gives WKWebView both the document focus and
 * the user activation `navigator.credentials` requires — a hidden/auto WebView
 * can't (it fails with "document is not focused").
 */
export default function WebAuthnPrfOverlay() {
  const [active, setActive] = useState<WebAuthnPrfRequestPayload | null>(null);
  // Mirror state in a ref so the EventBus listener (subscribed once) reads the
  // latest active request without re-subscribing on every change.
  const activeRef = useRef<WebAuthnPrfRequestPayload | null>(null);

  const insets = useSafeAreaInsets();

  const setActiveRequest = useCallback((next: WebAuthnPrfRequestPayload | null) => {
    activeRef.current = next;
    setActive(next);
  }, []);

  useEffect(() => {
    const unsubscribe = EventBus.on<WebAuthnPrfRequestPayload>("webauthn:prfRequest", (payload) => {
      if (!payload) return;
      // Only one WebAuthn ceremony can run at a time. Reject extras explicitly
      // so their promises never hang.
      if (activeRef.current) {
        rejectPrfRequest(payload.id, BUSY_MESSAGE);
        return;
      }
      setActiveRequest(payload);
    });
    // Bridge timeout (WebAuthnPrfService) rejected a stuck ceremony — tear down the
    // overlay if it's still showing that request.
    const unsubscribeCancel = EventBus.on<{ id: string }>("webauthn:prfCancel", (payload) => {
      if (payload && activeRef.current?.id === payload.id) {
        setActiveRequest(null);
      }
    });
    return () => {
      unsubscribe();
      unsubscribeCancel();
    };
  }, [setActiveRequest]);

  const handleCreateResult = useCallback(
    (result: PasskeyWebAuthnPrfCreateResult) => {
      const request = activeRef.current;
      if (!request) return;
      resolvePrfRequest(request.id, result);
      setActiveRequest(null);
    },
    [setActiveRequest],
  );

  const handleAssertionResult = useCallback(
    (result: PasskeyWebAuthnPrfAssertionResult) => {
      const request = activeRef.current;
      if (!request) return;
      resolvePrfRequest(request.id, result);
      setActiveRequest(null);
    },
    [setActiveRequest],
  );

  const handleError = useCallback(
    (message: string) => {
      const request = activeRef.current;
      if (!request) return;
      rejectPrfRequest(request.id, message);
      setActiveRequest(null);
    },
    [setActiveRequest],
  );

  // Rendered as a layer in the shared app-root overlay. Because it registers
  // after any open layer or DS sheet (the send/unlock/swap screens), it stacks
  // above them — the WebView reports cancel/errors via onError, which dismisses
  // the layer.
  return (
    <Layer visible={!!active} onRequestClose={() => handleError("webauthn_prf_overlay_cancelled")}>
      {active ? (
        <View chrome="canvas" direction="column" align="stretch" fill="grow">
          <RNView style={[styles.title, { paddingTop: insets.top + 48 }]}>
            <BrandDisplayTitle>{active.title}</BrandDisplayTitle>
          </RNView>
          {/* Centered behind the transparent overlay WebView; pointerEvents none
              so taps reach the in-WebView button. */}
          <RNView style={styles.illustration} pointerEvents="none">
            <WalletLockIllustration width={240} height={240} />
          </RNView>
          <RNView style={styles.spacer} />
          {/* The DS Button is always visible, so the screen never renders
              without its button while the WebView loads. The transparent overlay
              WebView sits on top to take the tap — WKWebView needs the in-page
              user-activation for navigator.credentials. */}
          <RNView style={[styles.footer, { paddingBottom: insets.bottom + 24 }]}>
            <RNView>
              <Button size="lg" variant="solid" accent="lilac" onPress={() => {}}>
                <ButtonText>{active.buttonLabel}</ButtonText>
              </Button>
              <RNView style={StyleSheet.absoluteFill}>
                <PasskeyWebAuthnPrfView
                  key={active.id}
                  overlay
                  mode={active.mode}
                  buttonLabel={active.buttonLabel}
                  challengeB64u={active.challengeB64u}
                  credIdB64u={active.credIdB64u}
                  rpId={active.rpId}
                  prfSalt={active.prfSalt}
                  requestPrf={active.requestPrf}
                  label={active.label}
                  onCreateResult={handleCreateResult}
                  onAssertionResult={handleAssertionResult}
                  onError={handleError}
                />
              </RNView>
            </RNView>
          </RNView>
        </View>
      ) : null}
    </Layer>
  );
}

const styles = StyleSheet.create({
  title: {
    paddingHorizontal: 24,
    alignItems: "center",
  },
  illustration: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  spacer: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 16,
  },
});
