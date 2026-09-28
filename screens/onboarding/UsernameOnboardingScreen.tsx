// @screen onboarding.username
// Full-screen blocking onboarding step that gates the transition to a
// signed-in state on a Lightning-username claim. Rendered by App.tsx after
// bootstrap completes when `getArkadeLnurlStatusSnapshot()?.registered` is not
// true; the actual picker UI lives in `components/UsernamePicker`.
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View as RNView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, ButtonText, View } from "@ds";
import BrandDisplayTitle from "../../components/BrandDisplayTitle";
import PasskeyWebAuthnPrfView, {
  type PasskeyWebAuthnPrfAssertionResult,
} from "../../components/PasskeyWebAuthnPrfView";
import ScreenHeader from "../../components/ScreenHeader";
import UsernamePicker, { type UsernamePickerSubmitControl } from "../../components/UsernamePicker";
import {
  getWalletPasskeyAssertion,
  isNativePasskeyLoginAvailable,
} from "../../services/auth/PasskeyNativeModuleService";
import { t } from "../../lib/i18n";
import { useKeyboardHeight } from "../../lib/useKeyboardHeight";
import {
  acquireUsernameAssertionLock,
  completeUsernamePasskeyAssertion,
} from "../../lib/auth/usernamePasskeyAssertion";
import { sanitizePasskeyError } from "../../lib/auth/passkeyError";
import { getOrCreateArkadeIdentity } from "../../services/arkade/internal/identity";

type Props = {
  onSubmit: (name: string) => void;
  busy?: boolean;
  externalError?: string | null;
};

const FOOTER_KEYBOARD_GAP = 24;
const FOOTER_BOTTOM_MIN = 48;
const PREFETCH_RETRY_MS = 2500;
const CLAIM_BUSY_TRANSITION_TIMEOUT_MS = 5000;

const UsernameOnboardingScreen: React.FC<Props> = ({ onSubmit, busy, externalError }) => {
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const [submitControl, setSubmitControl] = useState<UsernamePickerSubmitControl | null>(null);
  const [nativeBusy, setNativeBusy] = useState(false);
  const nativeBusyRef = useRef(false);
  const claimSubmittedRef = useRef(false);
  const claimBecameBusyRef = useRef(false);
  const claimBusyTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [prefetchRetry, setPrefetchRetry] = useState(0);
  const prefetchInFlightRef = useRef<Promise<{
    rpId: string;
    challengeB64u: string;
    credIdB64u: string;
  } | null> | null>(null);
  // Android routes the Continue ceremony through the compiled-in native
  // PasskeyModule — the shipped binaries lack WebView WebAuthn, so the
  // transparent WebView overlay would swallow the tap and do nothing. Web takes
  // the same direct path (PasskeyNativeModuleService.web calls
  // navigator.credentials in the page), like the passkey login screen: the
  // overlay's WebView is an about:srcdoc iframe there, which inherits the app
  // CSP and cannot run its own scripts.
  const nativePasskey = Platform.OS === "web" || isNativePasskeyLoginAvailable();
  // Pre-fetched auth so the Continue button itself runs the passkey ceremony
  // (one tap, no second confirm screen). Null → plain button → prompt path.
  const [passkeyPrefetch, setPasskeyPrefetch] = useState<{
    rpId: string;
    challengeB64u: string;
    credIdB64u: string;
  } | null>(null);

  // Right after wallet creation the arkade identity/auth is often not ready on
  // the first attempt, which used to permanently drop the one-tap Continue
  // ceremony (fullscreen confirm fallback). Retry until the prefetch lands or
  // the screen unmounts — this only re-runs the background challenge fetch,
  // never a ceremony.
  // `prefetchRetry` is a generation token: prepare/cache failures consume the
  // pending auth and increment it to start a fresh background preparation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the generation token intentionally restarts this effect
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = async () => {
      try {
        // `prepareLnurlRegisterPasskey` also installs module-global pending
        // auth. Share one in-flight call across effect generations so a stale
        // request can never finish later and overwrite a newer pending token.
        if (!prefetchInFlightRef.current) {
          const request = (async () => {
            const identity = await getOrCreateArkadeIdentity();
            return identity.prepareLnurlRegisterPasskey();
          })();
          prefetchInFlightRef.current = request;
          void request
            .finally(() => {
              if (prefetchInFlightRef.current === request) prefetchInFlightRef.current = null;
            })
            .catch(() => {});
        }
        const prep = await prefetchInFlightRef.current;
        if (!active) return;
        if (prep) {
          setPasskeyPrefetch(prep);
          return;
        }
      } catch {}
      if (!active) return;
      setPasskeyPrefetch(null);
      timer = setTimeout(() => void attempt(), PREFETCH_RETRY_MS);
    };
    void attempt();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [prefetchRetry]);

  const retryPrefetch = useCallback(() => {
    setPasskeyPrefetch(null);
    setPrefetchRetry((current) => current + 1);
  }, []);

  const releaseClaimLock = useCallback(() => {
    claimSubmittedRef.current = false;
    claimBecameBusyRef.current = false;
    nativeBusyRef.current = false;
    setNativeBusy(false);
  }, []);

  const markClaimSubmitted = useCallback(() => {
    claimSubmittedRef.current = true;
    if (claimBusyTransitionTimerRef.current) clearTimeout(claimBusyTransitionTimerRef.current);
    // `onSubmit` currently flips the parent `busy` prop synchronously. Keep a
    // fallback so a future host that fails to make that transition cannot leave
    // Continue locked forever.
    claimBusyTransitionTimerRef.current = setTimeout(() => {
      claimBusyTransitionTimerRef.current = null;
      if (!claimBecameBusyRef.current) releaseClaimLock();
    }, CLAIM_BUSY_TRANSITION_TIMEOUT_MS);
  }, [releaseClaimLock]);

  useEffect(
    () => () => {
      if (claimBusyTransitionTimerRef.current) clearTimeout(claimBusyTransitionTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (busy && claimSubmittedRef.current) {
      claimBecameBusyRef.current = true;
      if (claimBusyTransitionTimerRef.current) {
        clearTimeout(claimBusyTransitionTimerRef.current);
        claimBusyTransitionTimerRef.current = null;
      }
      return;
    }
    if (!busy && claimSubmittedRef.current && claimBecameBusyRef.current) {
      releaseClaimLock();
      retryPrefetch();
    }
  }, [busy, releaseClaimLock, retryPrefetch]);

  const handleSubmitControlChange = useCallback((control: UsernamePickerSubmitControl) => {
    setSubmitControl(control);
  }, []);

  // The Continue button is a transparent WebView overlay: its tap runs the
  // ceremony, caches the assertion, then submits — the claim reads the cache.
  const handlePasskeyResult = useCallback(
    (result: PasskeyWebAuthnPrfAssertionResult) => {
      setPasskeyError(null);
      void (async () => {
        try {
          const identity = await getOrCreateArkadeIdentity();
          const cached = identity.cacheLnurlRegisterAssertion({
            clientDataB64u: result.clientDataB64u,
            authDataB64u: result.authDataB64u,
            sigB64u: result.sigB64u,
          });
          if (!cached || !submitControl?.submit()) {
            setPasskeyError(t("screen.UsernameOnboarding.passkeyError"));
            retryPrefetch();
          } else {
            // The cached preparation is consumed. Refresh only after the
            // submitted claim has completed, so a server-side rejection can
            // retry without first presenting the stale WebView challenge.
            markClaimSubmitted();
          }
        } catch (error) {
          const sanitized = sanitizePasskeyError(error);
          console.warn(
            `[UsernameOnboarding] passkey failed phase=cache code=${sanitized.code} class=${sanitized.errorName}`,
          );
          setPasskeyError(t("screen.UsernameOnboarding.passkeyError"));
          retryPrefetch();
        }
      })();
    },
    [markClaimSubmitted, retryPrefetch, submitControl],
  );

  const handlePasskeyError = useCallback(() => {
    setPasskeyError(t("screen.UsernameOnboarding.passkeyError"));
  }, []);

  const handleValueChange = useCallback(() => {
    setPasskeyError(null);
  }, []);

  // Native Continue: run the assertion ceremony on the button press itself,
  // cache it, then submit — same contract as the WebView overlay path.
  const handleNativeContinue = useCallback(() => {
    if (!acquireUsernameAssertionLock(nativeBusyRef)) return;
    setNativeBusy(true);
    setPasskeyError(null);
    const prefetch = passkeyPrefetch;
    void (async () => {
      try {
        const result = await completeUsernamePasskeyAssertion({
          prepared: prefetch,
          getAssertion: getWalletPasskeyAssertion,
          cacheAssertion: async (assertion) => {
            const identity = await getOrCreateArkadeIdentity();
            return identity.cacheLnurlRegisterAssertion(assertion);
          },
          submit: () => submitControl?.submit() ?? false,
        });
        if (result.ok === false) {
          console.warn(
            `[UsernameOnboarding] passkey failed phase=${result.failure.phase} code=${result.failure.code} class=${result.failure.errorName}`,
          );
          setPasskeyError(
            t(
              result.failure.code === "malformed_assertion"
                ? "screen.UsernameOnboarding.passkeyMismatchError"
                : "screen.UsernameOnboarding.passkeyError",
            ),
          );
          // Assertion cancellation leaves the prepared auth untouched and can
          // retry immediately. Prepare/cache failures require a fresh auth.
          if (result.failure.phase !== "assertion") {
            retryPrefetch();
          }
        } else {
          // Hold the synchronous tap lock through the parent claim. A failed
          // claim releases it only after busy returns to false; success unmounts.
          markClaimSubmitted();
        }
      } catch (error) {
        const sanitized = sanitizePasskeyError(error);
        console.warn(
          `[UsernameOnboarding] passkey failed phase=submit code=${sanitized.code} class=${sanitized.errorName}`,
        );
        setPasskeyError(t("screen.UsernameOnboarding.passkeyError"));
        retryPrefetch();
      } finally {
        if (!claimSubmittedRef.current) {
          nativeBusyRef.current = false;
          setNativeBusy(false);
        }
      }
    })();
  }, [markClaimSubmitted, passkeyPrefetch, retryPrefetch, submitControl]);

  const footerBottomPadding =
    keyboardHeight > 0
      ? keyboardHeight + FOOTER_KEYBOARD_GAP
      : Math.max(insets.bottom, FOOTER_BOTTOM_MIN);
  const submitLabel = submitControl?.label ?? t("screen.UsernamePicker.continue");
  // Keep Continue actionable while native preparation is unavailable. The
  // native handler reports the missing preparation and joins/restarts the
  // serialized background fetch; hard-disabling here can strand the user on a
  // grey button forever when preparation repeatedly fails.
  const submitDisabled = !(submitControl?.canSubmit ?? false);

  return (
    // Structural: fullscreen overlay above the app shell.
    <RNView style={styles.container}>
      <View chrome="canvas" direction="column" align="stretch" fill="grow">
        {/* Standard header: logo left, support right — the heading lives in the
          body (centerContent squeezed between logo and empty right slot). */}
        <ScreenHeader />

        {/* paddingX="xl" (24) lines the input up with the header and the
          footer buttons (both 24). Heading uses the brand display type
          (Harriet), like the other fullscreen titles. */}
        {/* grow-SHRINK: the footer grows by the whole keyboard, and a body that
            can only grow made the column taller than the screen — the overflow
            came off the top, taking the logo and the support button under the
            status bar. Shrinking here keeps the column exactly one screen tall,
            so the header never moves. */}
        <View
          direction="column"
          align="stretch"
          justify="center"
          paddingX="xl"
          fill="grow-shrink"
          gap="lg"
        >
          <BrandDisplayTitle>{t("screen.UsernameOnboarding.heading")}</BrandDisplayTitle>
          <UsernamePicker
            onContinue={onSubmit}
            busy={busy}
            externalError={passkeyError ?? externalError}
            onValueChange={handleValueChange}
            onSubmitControlChange={handleSubmitControlChange}
            autoFocus
            placeholder={t("screen.UsernamePicker.onboardingPlaceholder")}
            showHeader={false}
            statusMode="errors"
            showStatus
            showPreview={false}
            showSubmitButton={false}
          />
        </View>

        {/* Structural: keyboard-aware footer padding + positioning context for
          the transparent passkey WebView overlaid on Continue. */}
        <RNView style={[styles.footer, { paddingBottom: footerBottomPadding }]}>
          <RNView style={styles.submitButton}>
            <Button
              size="lg"
              variant="solid"
              accent="lilac"
              disabled={submitDisabled || nativeBusy}
              onPress={nativePasskey ? handleNativeContinue : (submitControl?.submit ?? (() => {}))}
              accessibilityLabel={submitControl?.accessibilityLabel ?? submitLabel}
            >
              <ButtonText>{submitLabel}</ButtonText>
            </Button>
            {!nativePasskey &&
            passkeyPrefetch &&
            !submitDisabled &&
            !(submitControl?.loading ?? busy) ? (
              <RNView style={StyleSheet.absoluteFill}>
                <PasskeyWebAuthnPrfView
                  mode="assertion"
                  overlay
                  buttonLabel={submitLabel}
                  rpId={passkeyPrefetch.rpId}
                  challengeB64u={passkeyPrefetch.challengeB64u}
                  credIdB64u={passkeyPrefetch.credIdB64u}
                  onAssertionResult={handlePasskeyResult}
                  onError={handlePasskeyError}
                />
              </RNView>
            ) : null}
          </RNView>
        </RNView>
      </View>
    </RNView>
  );
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
  },
  footer: {
    alignItems: "stretch",
    paddingHorizontal: 24,
    paddingTop: 16,
    // The keyboard lift lives in this box's own padding, so it must keep every
    // point of it — a footer that shrank would put the button back under the
    // keyboard it just cleared.
    flexShrink: 0,
  },
  // Positioning context for the transparent passkey WebView overlaid on Continue.
  submitButton: {
    position: "relative",
  },
});

export default UsernameOnboardingScreen;
