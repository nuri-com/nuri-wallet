import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import { Button, ButtonText } from "@ds";
import { PRF_SALT } from "../config/constants";
import { WALLET_RP_ID } from "../config/passkey";
import { normalizePrfOutput, zeroize } from "../lib/crypto";
// The `.web` module explicitly: this component only ever renders in a browser,
// and the combined PRF+signature assertion it needs exists only there.
import {
  createWalletPasskey,
  getWalletPasskeyAssertion,
  getWalletPasskeyPrfAssertion,
} from "../services/auth/PasskeyNativeModuleService.web";
import type { PasskeyWebAuthnPrfProps } from "./PasskeyWebAuthnPrfView";

/**
 * Browser variant of PasskeyWebAuthnPrfView. The native component runs the
 * ceremony inside a WebView because that is the only place a native app can
 * reach WebAuthn; in a browser the app IS the page, so it calls
 * navigator.credentials directly (PasskeyNativeModuleService.web) — the same
 * path the web login already uses, so both produce the same wallet.
 *
 * This is not just a simplification: the WebView renders as an `about:srcdoc`
 * iframe on web, and a srcdoc document INHERITS the parent's CSP. Its inline
 * bridge/ceremony scripts are therefore refused under `script-src 'self'`
 * ("Refused to execute a script because its hash, its nonce, or 'unsafe-inline'
 * does not appear..."), which is what broke the username claim in the PWA.
 *
 * The button is the user activation WebAuthn requires, so the ceremony always
 * starts from a real click — never from an effect.
 */
export default function PasskeyWebAuthnPrfWeb({
  mode,
  buttonLabel,
  challengeB64u,
  credIdB64u,
  rpId,
  prfSalt,
  requestPrf = true,
  label,
  overlay,
  disabled,
  onAttemptStart,
  onCreateResult,
  onAssertionResult,
  onError,
}: PasskeyWebAuthnPrfProps) {
  const [busy, setBusy] = useState(false);
  // Owns the PRF bytes handed to the caller: the previous buffer is wiped when a
  // ceremony is repeated, and the last one when the view goes away.
  const prfRef = useRef<Uint8Array | null>(null);
  useEffect(
    () => () => {
      if (prfRef.current) zeroize(prfRef.current);
      prfRef.current = null;
    },
    [],
  );

  const run = useCallback(async () => {
    if (busy || disabled) return;
    setBusy(true);
    onAttemptStart?.();
    const effectiveRpId = rpId || WALLET_RP_ID;
    const salt = prfSalt || PRF_SALT;
    const keepPrf = (bytes: Uint8Array) => {
      if (prfRef.current) zeroize(prfRef.current);
      prfRef.current = bytes;
    };
    try {
      if (mode === "create") {
        const created = await createWalletPasskey(effectiveRpId, salt, label);
        const prf = normalizePrfOutput(created.prfB64);
        keepPrf(prf);
        onCreateResult?.({
          kind: "create",
          prf,
          prfB64u: toBase64Url(created.prfB64),
          credIdB64u: created.credIdB64u || "",
          credPubkeyB64u: created.credPubkeyB64u || "",
        });
        return;
      }

      if (requestPrf) {
        // One ceremony carries both halves, exactly like the WebView page: the
        // PRF derives the key, the signature over the SERVER challenge proves
        // it (the username claim is rejected as "missing assertion fields"
        // without them).
        const unlocked = await getWalletPasskeyPrfAssertion({
          rpId: effectiveRpId,
          challengeB64u: challengeB64u || "",
          credIdB64u,
          prfSalt: salt,
        });
        const prf = normalizePrfOutput(unlocked.prfB64);
        keepPrf(prf);
        onAssertionResult?.({
          kind: "assertion",
          prf,
          prfB64u: toBase64Url(unlocked.prfB64),
          credIdB64u: unlocked.credIdB64u,
          clientDataB64u: unlocked.clientDataB64u,
          authDataB64u: unlocked.authDataB64u,
          sigB64u: unlocked.sigB64u,
        });
        return;
      }

      const signed = await getWalletPasskeyAssertion({
        rpId: effectiveRpId,
        challengeB64u: challengeB64u || "",
        credIdB64u,
      });
      onAssertionResult?.({
        kind: "assertion",
        credIdB64u: signed.credIdB64u,
        clientDataB64u: signed.clientDataB64u,
        authDataB64u: signed.authDataB64u,
        sigB64u: signed.sigB64u,
      });
    } catch (error) {
      // Same `error:<mode>:<detail>` shape the WebView page posts, so callers
      // that match on it keep working.
      const name = error instanceof Error ? error.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      onError(`error:${mode}:${name}:${message}`);
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    challengeB64u,
    credIdB64u,
    disabled,
    label,
    mode,
    onAssertionResult,
    onAttemptStart,
    onCreateResult,
    onError,
    prfSalt,
    requestPrf,
    rpId,
  ]);

  // Overlay mode sits on top of a real DS button (native needs the WebView to
  // own the tap); here it stays an invisible tap target over that same button.
  if (overlay) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={buttonLabel}
        disabled={disabled || busy}
        onPress={run}
        style={StyleSheet.absoluteFill}
      />
    );
  }

  return (
    <Button
      size="sm"
      variant="solid"
      accent="neutral"
      disabled={disabled || busy}
      onPress={run}
      fill="even"
    >
      <ButtonText>{buttonLabel}</ButtonText>
    </Button>
  );
}

function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
