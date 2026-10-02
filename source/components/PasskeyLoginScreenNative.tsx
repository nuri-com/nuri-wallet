// @screen auth.login.native
// biome-ignore lint/correctness/noUnusedImports: React needed for JSX fragments
import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WALLET_RP_ID } from "../config/passkey";
import { normalizePrfOutput, zeroize } from "../lib/crypto";
import { t } from "../lib/i18n";
import { formatWalletPasskeyLabel } from "../lib/passkeyLabels";
import { resolveActionsBottom } from "../lib/passkeyActionsLayout";
import { getBitcoinAddress } from "../lib/secureKeyStorage";
import {
  arkadeBootstrapClaimAuth,
  arkadeCredentialHintOrNull,
} from "../services/arkade/ArkadeApiService";
import { getArkadeLnurlStatusPersisted } from "../services/arkade/ArkadeLnurlService";
import { authStateManager } from "../services/auth/AuthStateService";
import {
  createWalletPasskey,
  createWalletPasskeyCredential,
  getWalletPasskeyPrfAssertion,
  useExistingWalletPasskey,
} from "../services/auth/PasskeyNativeModuleService";
import { Button, ButtonText, Pressable, Text } from "@ds";
import PasskeyContinueOrSwitchModal from "./PasskeyContinueOrSwitchModal";
import type { PasskeyLoginScreenProps } from "./PasskeyLoginScreen";

type Props = Omit<PasskeyLoginScreenProps, "visible">;

const PRF_SALT = "nuri-prf-salt-v1";

type TargetedAction =
  | { kind: "checking" }
  | { kind: "sign-in"; credentialId: string }
  | { kind: "claim" }
  | { kind: "error" };

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown");
};

export default function PasskeyLoginScreenNative({
  footerMessage,
  resetSignal,
  autoOpenRestoreSignal,
  targetedUsername,
  onPayloadReady,
  onError,
  onAttemptStart,
}: Props) {
  const prfRef = useRef<Uint8Array | null>(null);
  // The actions block is absolutely positioned, so it paints under the system
  // navigation bar unless we add its inset. On a 3-button nav bar that is 126px
  // (42dp @ 420dpi), which swallowed the whole "Use existing Passkey" row.
  // Same Math.max(inset, MIN) shape UsernameOnboardingScreen already uses, so
  // gesture-nav devices (small inset) keep the original 32px breathing room.
  const insets = useSafeAreaInsets();
  const actionsBottom = resolveActionsBottom(insets.bottom);
  const targetedAutoStartRef = useRef<string | null>(null);
  const [targetedAction, setTargetedAction] = useState<TargetedAction>({ kind: "checking" });
  const [busy, setBusy] = useState(false);
  // Which ceremony is running. The value fed the removed legacy loading
  // spinner; the setters stay so the busy bookkeeping is unchanged.
  const [, setActiveAction] = useState<"create" | "existing" | null>(null);
  const [displayName, setDisplayName] = useState<string>(() =>
    t("screen.PasskeyContinueOrSwitchModal.fallbackName"),
  );
  const [showContinueModal, setShowContinueModal] = useState(false);

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
    setBusy(false);
    setActiveAction(null);
    setShowContinueModal(false);
  }, [resetSignal, cleanup]);

  useEffect(() => {
    let cancelled = false;
    const resolveDisplayName = async () => {
      try {
        // Prefer in-memory snapshot (sync) but fall back to the persisted
        // AsyncStorage cache. After signOut + relogin the in-memory singleton
        // is empty even when the user has a long-lived @username on disk —
        // without the disk read we'd silently degrade to "wallet …<suffix>".
        const persisted = await getArkadeLnurlStatusPersisted();
        const username = persisted?.username?.trim();
        if (username) {
          if (!cancelled) setDisplayName(`@${username}`);
          return;
        }
        const address = (await getBitcoinAddress())?.trim();
        if (address) {
          if (!cancelled) setDisplayName(`wallet …${address.slice(-6)}`);
          return;
        }
      } catch {}
    };
    void resolveDisplayName();
    return () => {
      cancelled = true;
    };
  }, []);

  const storePrf = useCallback((nextPrf: Uint8Array) => {
    if (prfRef.current) {
      zeroize(prfRef.current);
    }
    prfRef.current = nextPrf;
  }, []);

  const handleNativeResult = useCallback(
    (
      result: {
        prfB64: string;
        credIdB64u?: string;
        credPubkeyB64u?: string;
        isNew: boolean;
      },
      expectedCredId?: string,
      claimUsername?: string,
      claimAuth?: {
        token: string;
        clientDataB64u: string;
        authDataB64u: string;
        sigB64u: string;
      },
    ): boolean => {
      if (expectedCredId && result.credIdB64u !== expectedCredId) {
        onError("error:passkey_native:credential_mismatch");
        return false;
      }
      let prfBytes: Uint8Array;
      try {
        prfBytes = normalizePrfOutput(result.prfB64 || "");
      } catch {
        onError("error:passkey_native:empty_prf");
        return false;
      }

      if (!prfBytes.length) {
        onError("error:passkey_native:empty_prf");
        return false;
      }

      storePrf(prfBytes);
      onPayloadReady({
        prf: prfBytes,
        isNew: result.isNew,
        credIdB64u: result.credIdB64u,
        credPubkeyB64u: result.credPubkeyB64u,
        claimUsername,
        claimAuth,
      });
      return true;
    },
    [onError, onPayloadReady, storePrf],
  );

  const handleNativeError = useCallback(
    (error: unknown) => {
      const message = getErrorMessage(error);
      setActiveAction(null);
      onError(`error:passkey_native:${message}`);
    },
    [onError],
  );

  const runNativeCreate = useCallback(async () => {
    if (busy) return;
    onAttemptStart?.();
    setBusy(true);
    setActiveAction("create");
    let success = false;
    try {
      const result = await createWalletPasskey(WALLET_RP_ID, PRF_SALT, formatWalletPasskeyLabel());
      success = handleNativeResult(result);
    } catch (error: unknown) {
      handleNativeError(error);
    } finally {
      if (!success) setBusy(false);
    }
  }, [busy, handleNativeError, handleNativeResult, onAttemptStart]);

  const runRestoreCeremony = useCallback(
    async (opts: { credIdHint?: string }) => {
      onAttemptStart?.();
      setBusy(true);
      setActiveAction("existing");
      let success = false;
      try {
        const result = await useExistingWalletPasskey(WALLET_RP_ID, PRF_SALT, opts.credIdHint);
        success = handleNativeResult(result);
      } catch (error: unknown) {
        handleNativeError(error);
      } finally {
        if (!success) setBusy(false);
      }
    },
    [handleNativeError, handleNativeResult, onAttemptStart],
  );

  useEffect(() => {
    targetedAutoStartRef.current = null;
    if (!targetedUsername) return;
    let cancelled = false;
    setTargetedAction({ kind: "checking" });
    void (async () => {
      try {
        const hint = await arkadeCredentialHintOrNull(targetedUsername);
        if (cancelled) return;
        if (hint) {
          if (!hint.credential_id_b64u || hint.username !== targetedUsername) {
            throw new Error("credential_hint_invalid");
          }
          setTargetedAction({ kind: "sign-in", credentialId: hint.credential_id_b64u });
          return;
        }
        if (!cancelled) setTargetedAction({ kind: "claim" });
      } catch {
        if (!cancelled) setTargetedAction({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetedUsername]);

  const runTargetedRestore = useCallback(async () => {
    if (busy || targetedAction.kind !== "sign-in") return;
    onAttemptStart?.();
    setBusy(true);
    setActiveAction("existing");
    let success = false;
    try {
      const result = await useExistingWalletPasskey(
        WALLET_RP_ID,
        PRF_SALT,
        targetedAction.credentialId,
      );
      success = handleNativeResult(result, targetedAction.credentialId);
    } catch (error: unknown) {
      handleNativeError(error);
    } finally {
      if (!success) setBusy(false);
    }
  }, [busy, handleNativeError, handleNativeResult, onAttemptStart, targetedAction]);

  const runTargetedClaim = useCallback(async () => {
    if (busy || !targetedUsername || targetedAction.kind !== "claim") return;
    onAttemptStart?.();
    setBusy(true);
    setActiveAction("create");
    let success = false;
    try {
      // Recheck immediately before credential creation. A network error blocks;
      // a username claimed since the first check switches to exact sign-in.
      const hint = await arkadeCredentialHintOrNull(targetedUsername);
      if (hint) {
        if (!hint.credential_id_b64u || hint.username !== targetedUsername) {
          throw new Error("credential_hint_invalid");
        }
        setTargetedAction({ kind: "sign-in", credentialId: hint.credential_id_b64u });
        return;
      }
      const created = await createWalletPasskeyCredential(
        WALLET_RP_ID,
        PRF_SALT,
        `@${targetedUsername}`,
      );
      const credentialId = created.credIdB64u?.trim() || "";
      const credentialPublicKey = created.credPubkeyB64u?.trim() || "";
      if (!credentialId || !credentialPublicKey) {
        throw new Error("created_credential_metadata_missing");
      }
      const auth = await arkadeBootstrapClaimAuth({
        username: targetedUsername,
        cred_id_b64u: credentialId,
        cred_pubkey_b64u: credentialPublicKey,
      });
      if (auth.username !== targetedUsername) {
        throw new Error("bootstrap_claim_username_mismatch");
      }
      // One exact-credential assertion both proves the server challenge and
      // returns PRF. Providers without PRF stop here; registration is never sent.
      const assertion = await getWalletPasskeyPrfAssertion({
        rpId: auth.rp_id,
        challengeB64u: auth.challenge,
        credIdB64u: credentialId,
        prfSalt: PRF_SALT,
      });
      if (assertion.credIdB64u !== credentialId) {
        throw new Error("bootstrap_claim_credential_mismatch");
      }
      success = handleNativeResult(
        { ...created, ...assertion, isNew: true },
        credentialId,
        targetedUsername,
        {
          token: auth.token,
          clientDataB64u: assertion.clientDataB64u,
          authDataB64u: assertion.authDataB64u,
          sigB64u: assertion.sigB64u,
        },
      );
    } catch (error: unknown) {
      handleNativeError(error);
    } finally {
      if (!success) setBusy(false);
    }
  }, [
    busy,
    handleNativeError,
    handleNativeResult,
    onAttemptStart,
    targetedAction,
    targetedUsername,
  ]);

  useEffect(() => {
    if (
      !targetedUsername ||
      targetedAction.kind !== "sign-in" ||
      targetedAutoStartRef.current === targetedUsername
    ) {
      return;
    }
    targetedAutoStartRef.current = targetedUsername;
    void runTargetedRestore();
  }, [targetedUsername, runTargetedRestore, targetedAction.kind]);

  const runNativeAuthOnly = useCallback(async () => {
    if (busy) return;
    const hint =
      authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u?.trim() || "";
    if (hint.length === 0) {
      await runRestoreCeremony({});
      return;
    }
    setShowContinueModal(true);
  }, [busy, runRestoreCeremony]);

  // When the parent bumps `autoOpenRestoreSignal` (after `auth:relogin`), open
  // the Continue modal IF and only IF there's a meaningful credId hint
  // (exists and not stale-legacy). Never auto-trigger the iOS picker —
  // picker = instant Face ID prompt, which is too aggressive for an
  // automatic-on-mount action.
  useEffect(() => {
    if (autoOpenRestoreSignal === undefined || autoOpenRestoreSignal === 0) return;
    void (async () => {
      const hint =
        authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u?.trim() || "";
      if (!hint) return;
      setShowContinueModal(true);
    })();
  }, [autoOpenRestoreSignal]);

  const handleContinueWithHint = useCallback(() => {
    setShowContinueModal(false);
    const hint =
      authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u?.trim() || "";
    void runRestoreCeremony(hint.length > 0 ? { credIdHint: hint } : {});
  }, [runRestoreCeremony]);

  const handleUseOtherPasskey = useCallback(() => {
    setShowContinueModal(false);
    void runRestoreCeremony({});
  }, [runRestoreCeremony]);

  const handleContinueModalClose = useCallback(() => {
    setShowContinueModal(false);
  }, []);

  if (targetedUsername) {
    const username = `@${targetedUsername}`;
    const buttonLabel =
      targetedAction.kind === "sign-in"
        ? t("screen.PasskeyLoginScreen.targetedSignIn", { username })
        : targetedAction.kind === "checking"
          ? t("screen.PasskeyLoginScreen.targetedChecking", { username })
          : t("screen.PasskeyLoginScreen.targetedClaim", { username });
    const statusMessage =
      targetedAction.kind === "error"
        ? t("screen.PasskeyLoginScreen.targetedCheckFailed")
        : footerMessage;
    const disabled = busy || !["sign-in", "claim"].includes(targetedAction.kind);

    return (
      <View style={[styles.actions, { bottom: actionsBottom }]}>
        <Button
          size="lg"
          variant="solid"
          accent="neutral"
          disabled={disabled}
          onPress={() =>
            void (targetedAction.kind === "claim" ? runTargetedClaim() : runTargetedRestore())
          }
          accessibilityLabel={buttonLabel}
        >
          <ButtonText>{buttonLabel}</ButtonText>
        </Button>
        {statusMessage ? (
          <Text size="sm" align="center">
            {statusMessage}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <>
      <View style={[styles.actions, { bottom: actionsBottom }]}>
        <Button
          size="lg"
          variant="solid"
          accent="neutral"
          disabled={busy}
          onPress={runNativeCreate}
          accessibilityLabel={t("screen.PasskeyLoginScreen.passkeyButton")}
        >
          <ButtonText>{t("screen.PasskeyLoginScreen.passkeyButton")}</ButtonText>
        </Button>
        <Pressable
          onPress={runNativeAuthOnly}
          disabled={busy}
          disabledOpacity
          paddingY="sm"
          direction="row"
          justify="center"
          accessibilityLabel={t("screen.PasskeyLoginScreen.restoreWallet")}
        >
          <Text size="md" emphasis align="center">
            {t("screen.PasskeyLoginScreen.restoreWallet")}
          </Text>
        </Pressable>
        {footerMessage ? (
          <Text size="sm" align="center">
            {footerMessage}
          </Text>
        ) : null}
      </View>
      <PasskeyContinueOrSwitchModal
        visible={showContinueModal}
        displayName={displayName}
        onContinue={handleContinueWithHint}
        onUseOther={handleUseOtherPasskey}
        onClose={handleContinueModalClose}
      />
    </>
  );
}

const styles = StyleSheet.create({
  actions: {
    position: "absolute",
    left: 16,
    right: 16,
    gap: 16,
    zIndex: 3,
  },
});
