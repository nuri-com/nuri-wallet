// @screen bitcoin.receive-unlock
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View as RNView } from "react-native";

import { Button, ButtonText, Text, View } from "@ds";
import BiometricLockModal from "../../../components/BiometricLockModal";
import BrandDisplayTitle from "../../../components/BrandDisplayTitle";
import GotPaidIllustration from "../../../assets/illustrations/gotpaid.svg";
import FullscreenLayer from "../../../components/FullscreenLayer";
import PasskeyWebAuthnPrfView, {
  type PasskeyWebAuthnPrfAssertionResult,
} from "../../../components/PasskeyWebAuthnPrfView";
import PopRiffleView from "../../../components/PopRiffleView";
import { t } from "../../../lib/i18n";
import {
  closesUnlockScreen,
  nextUnlockFailureStep,
  unlockRunOutcome,
} from "../../../lib/support/unlockFailureReport";
import {
  acceptsUnlockPasskeyResult,
  armUnlockPasskey,
  clearArmedUnlockPasskey,
  oneTapUnlockPasskeyKind,
  type PreparedUnlockPasskey,
  type UnlockPasskeyAttempt,
  UNLOCK_PASSKEY_REFRESH_MS,
  UNLOCK_PASSKEY_RETRY_MS,
} from "../../../services/arkade/internal/armedUnlockPasskey";
import { reportUnlockFailureToSupport } from "../../../services/arkade/ArkadeUnlockSupportService";
import { getOrCreateArkadeIdentity } from "../../../services/arkade/internal/identity";
import type {
  ArkadeReceiveUnlockProgressPayload,
  ArkadeReceiveUnlockResult,
  ArkadeReceiveUnlockState,
} from "../../../services/arkade/ArkadeReceiveUnlockService";
import { ARKADE_RECEIVE_UNLOCK_PROGRESS_EVENT } from "../../../services/arkade/ArkadeReceiveUnlockService";
import { EventBus } from "../../../services/events/AppEventBusService";
import {
  noteV2TransferFailed,
  noteV2TransferPhase,
} from "../../../services/swapkit/SwapKitV2MoveStatus";

type Props = {
  visible: boolean;
  state: ArkadeReceiveUnlockState;
  onUnlock: () => Promise<ArkadeReceiveUnlockResult>;
  onClose: () => void;
};

function formatSats(sats: number): string {
  return String(Math.max(0, Math.trunc(Number(sats || 0))));
}

export default function PaymentReceivedModal({ visible, state, onUnlock, onClose }: Props) {
  const [running, setRunning] = useState(false);
  const failureCountRef = useRef(0);
  // The button runs the passkey ceremony itself on the tap, for a lone
  // Lightning claim or a lone boarding sweep (#1938). Mixed work keeps the plain
  // button: one ceremony approves one approval, and the second would need the
  // focus the button's page took.
  const oneTapKind = oneTapUnlockPasskeyKind(state.actionableItems);
  const usesReceiveClaimPasskey = oneTapKind === "ln_receive_claim";
  // A renewal is not a payment: it shows the real wallet lock screen users
  // already know ("Access wallet"), not a screen of its own.
  const renewal =
    state.actionableItems.length === 1 && state.actionableItems[0]?.kind === "vtxo_renewal";
  // Pre-fetched auth so the "Passkey Unlock" button itself can run the WebView
  // passkey ceremony on one tap (no second confirm screen). Null → fall back to
  // the plain button (which prompts via the overlay).
  const [passkeyPrefetch, setPasskeyPrefetch] = useState<PreparedUnlockPasskey | null>(null);
  const [prefetchRound, setPrefetchRound] = useState(0);
  // A ceremony in progress on the button (tap seen, no result yet). It pins its
  // challenge, so no refresh may replace (and remount) the view meanwhile.
  const attemptRef = useRef<UnlockPasskeyAttempt | null>(null);
  const [attemptActive, setAttemptActive] = useState(false);
  // One screen session: hiding, dismissing or a change of the work it shows
  // starts a new one, and a result from an older session runs nothing.
  const generationRef = useRef(0);
  const liveRef = useRef({ visible, kind: oneTapKind, prepared: passkeyPrefetch });
  liveRef.current = { visible, kind: oneTapKind, prepared: passkeyPrefetch };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `visible` and `oneTapKind` are the session boundary, not values read
  useEffect(
    () => () => {
      generationRef.current += 1;
      attemptRef.current = null;
      setAttemptActive(false);
    },
    [oneTapKind, visible],
  );

  // Fetch the challenge while the screen is open and idle, and again after
  // every run (a used or cancelled challenge cannot serve the next tap), on a
  // timer well inside the server token's life, and shortly after a failure.
  // Paused while a ceremony is open on the button.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `prefetchRound` is the re-fetch trigger, not a value read
  useEffect(() => {
    if (!visible || !oneTapKind) {
      clearArmedUnlockPasskey();
      setPasskeyPrefetch(null);
      return;
    }
    if (running || attemptActive) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      let prep: PreparedUnlockPasskey | null = null;
      try {
        const identity = await getOrCreateArkadeIdentity();
        prep = await identity.prepareUnlockPasskey();
      } catch {
        prep = null;
      }
      if (!active) return;
      setPasskeyPrefetch(prep);
      timer = setTimeout(
        () => setPrefetchRound((round) => round + 1),
        prep ? UNLOCK_PASSKEY_REFRESH_MS : UNLOCK_PASSKEY_RETRY_MS,
      );
    })();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [attemptActive, oneTapKind, prefetchRound, running, visible]);

  // The modal stays mounted and only toggles visibility, so reset the failure
  // count for each fresh claim session rather than carrying it across.
  useEffect(() => {
    if (visible) {
      failureCountRef.current = 0;
    }
  }, [visible]);

  // Support hears about a few failures on the open screen, or at once about a
  // failure after the screen already closed; a cancelled prompt is never
  // reported (lib/support/unlockFailureReport).
  const registerFailure = useCallback((failure: unknown, closedEarly = false) => {
    const step = nextUnlockFailureStep({
      failure,
      failuresSoFar: failureCountRef.current,
      closedEarly,
    });
    failureCountRef.current = step.failures;
    if (step.report) reportUnlockFailureToSupport(failure);
  }, []);

  // A signed Lightning claim closes the modal early — but only when that claim
  // is the whole job. With a boarding sweep still queued behind it, closing here
  // ends the session before the sweep runs, and the sweep has no other path:
  // there is no background auto-sweep, so those sats wait for the next modal.
  // A boarding sweep closes the modal the moment its passkey approval is done:
  // the settlement round runs on without the user (it is the same session, so
  // closing the screen does not stop it) and the pill shows its progress.
  useEffect(() => {
    if (!visible || !running) return;
    return EventBus.on<ArkadeReceiveUnlockProgressPayload>(
      ARKADE_RECEIVE_UNLOCK_PROGRESS_EVENT,
      (payload) => {
        if (!closesUnlockScreen(payload?.phase, usesReceiveClaimPasskey)) return;
        failureCountRef.current = 0;
        onClose();
      },
    );
  }, [onClose, running, usesReceiveClaimPasskey, visible]);

  const handleUnlock = useCallback(() => {
    void (async () => {
      setRunning(true);
      // The receive shows as a pill once the screen closes early (claim signed,
      // sweep approved): Processing… while the round finishes, then its outcome.
      const pillId = `receive:${Date.now()}`;
      let pillShown = false;
      // Set once the screen closed for this run: a failure after that has no
      // screen to retry on, so it goes to support straight away.
      let closedEarly = false;
      const offProgress = EventBus.on<ArkadeReceiveUnlockProgressPayload>(
        ARKADE_RECEIVE_UNLOCK_PROGRESS_EVENT,
        (payload) => {
          if (closesUnlockScreen(payload?.phase, usesReceiveClaimPasskey)) closedEarly = true;
          if (pillShown) return;
          pillShown = true;
          noteV2TransferPhase(pillId, "processing");
        },
      );
      try {
        const result = await onUnlock();
        if (pillShown) {
          if (result.ok) noteV2TransferPhase(pillId, "completed");
          else noteV2TransferFailed(pillId, result);
        }
        // Reporting and closing are decided separately: a failed run that
        // also closes the screen still goes to support (#1823 review).
        const outcome = unlockRunOutcome(result, closedEarly);
        if (outcome.failed) registerFailure(result, outcome.closedEarly);
        else failureCountRef.current = 0;
        if (outcome.close) {
          failureCountRef.current = 0;
          onClose();
        }
      } catch (error) {
        if (pillShown) noteV2TransferFailed(pillId, error);
        registerFailure(error, closedEarly);
      } finally {
        // An armed result the run never took must not serve a later approval.
        clearArmedUnlockPasskey();
        setPasskeyPrefetch(null);
        offProgress();
        setRunning(false);
      }
    })();
  }, [onClose, onUnlock, registerFailure, usesReceiveClaimPasskey]);

  // The "Passkey Unlock" button is a transparent WebView overlay: its tap runs
  // the ceremony directly. The tap pins the attempt (challenge, session, work).
  const handlePasskeyAttemptStart = useCallback((prepared: PreparedUnlockPasskey) => {
    const kind = liveRef.current.kind;
    if (!kind) return;
    attemptRef.current = { prepared, generation: generationRef.current, kind };
    setAttemptActive(true);
  }, []);

  // Ends the pinned attempt and hands it back, so each result is used once.
  const endPasskeyAttempt = useCallback((): UnlockPasskeyAttempt | null => {
    const attempt = attemptRef.current;
    attemptRef.current = null;
    setAttemptActive(false);
    return attempt;
  }, []);

  // The result arms the claim's or sweep's approval (that work only) and runs
  // the unlock, but only for the attempt that is still current; anything else
  // runs nothing and a fresh challenge is fetched.
  const handlePasskeyResult = useCallback(
    (prepared: PreparedUnlockPasskey, result: PasskeyWebAuthnPrfAssertionResult) => {
      const attempt = endPasskeyAttempt();
      const live = liveRef.current;
      if (
        !live.prepared ||
        prepared !== live.prepared ||
        !acceptsUnlockPasskeyResult(attempt, {
          prepared,
          generation: generationRef.current,
          visible: live.visible,
          kind: live.kind,
        })
      ) {
        clearArmedUnlockPasskey();
        setPasskeyPrefetch(null);
        setPrefetchRound((round) => round + 1);
        return;
      }
      armUnlockPasskey(attempt, {
        prfB64: result.prfB64u,
        credIdB64u: result.credIdB64u,
        clientDataB64u: result.clientDataB64u,
        authDataB64u: result.authDataB64u,
        sigB64u: result.sigB64u,
      });
      handleUnlock();
    },
    [endPasskeyAttempt, handleUnlock],
  );

  const handlePasskeyError = useCallback(
    (message: string) => {
      const attempt = endPasskeyAttempt();
      clearArmedUnlockPasskey();
      // A late error from an older session is not a failure of this one.
      if (!attempt || attempt.generation === generationRef.current) registerFailure(message);
      // The challenge was spent on the cancelled ceremony: fetch a new one.
      setPasskeyPrefetch(null);
      setPrefetchRound((round) => round + 1);
    },
    [endPasskeyAttempt, registerFailure],
  );

  // Renewal: one try, then the screen goes away whatever happened. The lock
  // screen has no "later" button, so closing on every outcome is what keeps a
  // failing or cancelled renewal from locking the user out; App re-offers it
  // when the due coins change, and a failure still reaches support.
  const handleRenewal = useCallback(async () => {
    try {
      const result = await onUnlock();
      if (!result.ok) registerFailure(result, true);
    } catch (error) {
      registerFailure(error, true);
    } finally {
      failureCountRef.current = 0;
      onClose();
    }
  }, [onClose, onUnlock, registerFailure]);

  if (renewal) return <BiometricLockModal visible={visible} onAccess={handleRenewal} />;

  return (
    <FullscreenLayer
      visible={visible}
      onRequestClose={onClose}
      footer={
        <>
          <RNView style={styles.unlockButton}>
            <Button
              size="lg"
              variant="solid"
              accent="lilac"
              disabled={running || state.actionableCount <= 0}
              onPress={handleUnlock}
              accessibilityLabel={t("screen.PaymentReceivedModal.unlockButton")}
            >
              <ButtonText>{t("screen.PaymentReceivedModal.unlockButton")}</ButtonText>
            </Button>
            {oneTapKind && passkeyPrefetch && !running && state.actionableCount > 0 ? (
              <RNView style={StyleSheet.absoluteFill}>
                <PasskeyWebAuthnPrfView
                  key={passkeyPrefetch.challengeB64u}
                  mode="assertion"
                  overlay
                  buttonLabel={t("screen.PaymentReceivedModal.unlockButton")}
                  rpId={passkeyPrefetch.rpId}
                  challengeB64u={passkeyPrefetch.challengeB64u}
                  credIdB64u={passkeyPrefetch.credIdB64u}
                  onAttemptStart={() => handlePasskeyAttemptStart(passkeyPrefetch)}
                  onFocusRetry={endPasskeyAttempt}
                  onAssertionResult={(result) => handlePasskeyResult(passkeyPrefetch, result)}
                  onError={handlePasskeyError}
                />
              </RNView>
            ) : null}
          </RNView>
          {/* The boarding-claim screen must never be the only reachable surface:
              a claim that keeps failing (unclaimable boarding topic, server
              refusal, passkey errors) otherwise locks the user out of the app,
              because the auto-open keeps re-presenting this full-screen layer.
              Dismissing is just onClose: App already suppresses the auto-open
              until the actionable work changes, and the home pending-sweep row
              remains the explicit way back in. */}
          <Button
            size="lg"
            variant="soft"
            disabled={running}
            onPress={onClose}
            accessibilityLabel={t("screen.PaymentReceivedModal.laterButton")}
          >
            <ButtonText>{t("screen.PaymentReceivedModal.laterButton")}</ButtonText>
          </Button>
        </>
      }
    >
      <View direction="column" align="center" gap="md" paddingTop="lg">
        <BrandDisplayTitle>{t("screen.PaymentReceivedModal.title")}</BrandDisplayTitle>
        <Text size="xl" emphasis align="center">
          {`BTC ${formatSats(state.actionableSats)} sats`}
        </Text>
      </View>

      <View direction="column" align="center" justify="center" fill="grow">
        <PopRiffleView active={visible}>
          <GotPaidIllustration width={241} height={213} />
        </PopRiffleView>
      </View>
    </FullscreenLayer>
  );
}

const styles = StyleSheet.create({
  // Positioning context for the transparent passkey WebView overlaid on the
  // unlock button only — never the dismiss button next to it.
  unlockButton: {
    position: "relative",
  },
});
