// @screen bitcoin.receive-unlock
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View as RNView } from "react-native";

import { Button, ButtonText, Text, View } from "@ds";
import BrandDisplayTitle from "../../../components/BrandDisplayTitle";
import GotPaidIllustration from "../../../assets/illustrations/gotpaid.svg";
import FullscreenLayer from "../../../components/FullscreenLayer";
import PasskeyWebAuthnPrfView, {
  type PasskeyWebAuthnPrfAssertionResult,
} from "../../../components/PasskeyWebAuthnPrfView";
import PopRiffleView from "../../../components/PopRiffleView";
import { t } from "../../../lib/i18n";
import {
  armReceiveClaimPasskeyResult,
  clearArmedReceiveClaimPasskey,
} from "../../../services/arkade/ArkadeRemoteIdentity";
import { reportUnlockFailureToSupport } from "../../../services/arkade/ArkadeUnlockSupportService";
import { getOrCreateArkadeIdentity } from "../../../services/arkade/internal/identity";
import type {
  ArkadeReceiveUnlockProgressPayload,
  ArkadeReceiveUnlockResult,
  ArkadeReceiveUnlockState,
} from "../../../services/arkade/ArkadeReceiveUnlockService";
import { ARKADE_RECEIVE_UNLOCK_PROGRESS_EVENT } from "../../../services/arkade/ArkadeReceiveUnlockService";
import { EventBus } from "../../../services/events/AppEventBusService";
import { noteV2TransferPhase } from "../../../services/swapkit/SwapKitV2MoveStatus";

type Props = {
  visible: boolean;
  state: ArkadeReceiveUnlockState;
  onUnlock: () => Promise<ArkadeReceiveUnlockResult>;
  onClose: () => void;
};

// Only pull in support once the user has genuinely failed to claim a few times
// (passkey cancels included), not on the first stumble.
const SUPPORT_AFTER_FAILURES = 3;

function formatSats(sats: number): string {
  return String(Math.max(0, Math.trunc(Number(sats || 0))));
}

export default function PaymentReceivedModal({ visible, state, onUnlock, onClose }: Props) {
  const [running, setRunning] = useState(false);
  const failureCountRef = useRef(0);
  // The prefetch overlay is an iframe that holds document focus, so it may only
  // arm when the sole pending item is a Lightning claim. Anything else (a
  // boarding sweep) runs its ceremony in the parent document and needs the focus.
  const usesReceiveClaimPasskey =
    state.actionableItems.length === 1 && state.actionableItems[0]?.kind === "ln_receive_claim";
  // Pre-fetched auth so the "Passkey Unlock" button itself can run the WebView
  // passkey ceremony on one tap (no second confirm screen). Null → fall back to
  // the plain button (which prompts via the overlay).
  const [passkeyPrefetch, setPasskeyPrefetch] = useState<{
    rpId: string;
    challengeB64u: string;
    credIdB64u: string;
  } | null>(null);

  // Pre-fetch the combined-assertion auth only for a Lightning receive claim.
  // Boarding sweeps must keep focus in the parent document for WebAuthn.
  useEffect(() => {
    if (!visible || !usesReceiveClaimPasskey) {
      clearArmedReceiveClaimPasskey();
      setPasskeyPrefetch(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const identity = await getOrCreateArkadeIdentity();
        const prep = await identity.prepareReceiveClaimPasskey();
        if (active) setPasskeyPrefetch(prep);
      } catch {
        if (active) setPasskeyPrefetch(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [usesReceiveClaimPasskey, visible]);

  // The modal stays mounted and only toggles visibility, so reset the failure
  // count for each fresh claim session rather than carrying it across.
  useEffect(() => {
    if (visible) {
      failureCountRef.current = 0;
    }
  }, [visible]);

  const registerFailure = useCallback((failure: unknown) => {
    failureCountRef.current += 1;
    if (failureCountRef.current >= SUPPORT_AFTER_FAILURES) {
      // After repeated failures, report to support and open the chat.
      reportUnlockFailureToSupport(failure);
      failureCountRef.current = 0;
    }
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
        const claimDone =
          usesReceiveClaimPasskey &&
          (payload?.phase === "claim_signed" || payload?.phase === "claim_waiting");
        if (!claimDone && payload?.phase !== "sweep_approved") return;
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
      const offProgress = EventBus.on<ArkadeReceiveUnlockProgressPayload>(
        ARKADE_RECEIVE_UNLOCK_PROGRESS_EVENT,
        () => {
          if (pillShown) return;
          pillShown = true;
          noteV2TransferPhase(pillId, "processing");
        },
      );
      try {
        const result = await onUnlock();
        if (pillShown) noteV2TransferPhase(pillId, result.ok ? "completed" : "failed");
        if (result.shouldCloseModal) {
          failureCountRef.current = 0;
          onClose();
        } else if (result.ok) {
          failureCountRef.current = 0;
        } else {
          registerFailure(result);
        }
      } catch (error) {
        if (pillShown) noteV2TransferPhase(pillId, "failed");
        registerFailure(error);
      } finally {
        offProgress();
        setRunning(false);
      }
    })();
  }, [onClose, onUnlock, registerFailure]);

  // The "Passkey Unlock" button is a transparent WebView overlay: its tap runs
  // the ceremony directly. Arm the result so the claim's signing uses it instead
  // of prompting again, then run the unlock.
  const handlePasskeyResult = useCallback(
    (result: PasskeyWebAuthnPrfAssertionResult) => {
      armReceiveClaimPasskeyResult({
        prfB64: result.prfB64u,
        credIdB64u: result.credIdB64u,
        clientDataB64u: result.clientDataB64u,
        authDataB64u: result.authDataB64u,
        sigB64u: result.sigB64u,
      });
      handleUnlock();
    },
    [handleUnlock],
  );

  const handlePasskeyError = useCallback(
    (message: string) => {
      clearArmedReceiveClaimPasskey();
      registerFailure(message);
    },
    [registerFailure],
  );

  return (
    <FullscreenLayer visible={visible} onRequestClose={onClose}>
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

      <View direction="column" align="stretch" gap="sm">
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
          {usesReceiveClaimPasskey && passkeyPrefetch && !running && state.actionableCount > 0 ? (
            <RNView style={StyleSheet.absoluteFill}>
              <PasskeyWebAuthnPrfView
                mode="assertion"
                overlay
                buttonLabel={t("screen.PaymentReceivedModal.unlockButton")}
                rpId={passkeyPrefetch.rpId}
                challengeB64u={passkeyPrefetch.challengeB64u}
                credIdB64u={passkeyPrefetch.credIdB64u}
                onAssertionResult={handlePasskeyResult}
                onError={handlePasskeyError}
              />
            </RNView>
          ) : null}
        </RNView>
        {/* The boarding-claim screen must never be the only reachable surface:
            a claim that keeps failing (unclaimable boarding topic, server
            refusal, passkey errors) otherwise locks the user out of the app,
            because the auto-open keeps re-presenting this full-screen layer.
            Dismissing is just onClose — App already suppresses the auto-open
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
