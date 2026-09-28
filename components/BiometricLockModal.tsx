// @screen lock.biometric
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ButtonText, Text, View } from "@ds";
import BrandDisplayTitle from "./BrandDisplayTitle";
import FullscreenLayer from "./FullscreenLayer";
import WalletLockIllustration from "../assets/illustrations/wallet-lock.svg";
import { t } from "../lib/i18n";
import {
  walletAccessController,
  type WalletAccessResult,
  type WalletAccessSource,
} from "../services/auth/WalletAccessController";

// This screen unlocks — and when the unlock cannot succeed, gets the user past
// it without destroying anything. It used to carry a Delete wallet button with a
// 21-second countdown that ran a factory reset: a destructive action one tap away
// from a user who is already locked out and pressing things. Deleting a wallet is
// not a lock-screen concern, so the dead ends are handled by rebuilding the
// unlock entry from the passkey, and by support when even that is impossible.
type Props = {
  visible: boolean;
};

/**
 * Every outcome that leaves the user here says what happened and leaves the
 * button tappable. Nothing here is a dead end: the entry is untouched in all of
 * them, so another attempt is always the right offer.
 */
function hintFor(result: WalletAccessResult): string | null {
  switch (result.status) {
    case "cancelled":
      return t("screen.BiometricLockModal.retryAfterCancel");
    case "timeout":
      return t("screen.BiometricLockModal.retryAfterTimeout");
    case "recovery_required":
      return t("screen.BiometricLockModal.passkeyRecoveryHint");
    case "wrong_wallet":
      return t("screen.BiometricLockModal.wrongWalletHint");
    case "failed":
      return t("screen.BiometricLockModal.retryAfterFailure");
    default:
      return null;
  }
}

export default function BiometricLockModal({ visible }: Props) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const autoAccessAttemptedRef = useRef(false);
  const attemptRef = useRef(0);

  const handleWalletAccess = useCallback(async (source: WalletAccessSource) => {
    // The controller is the single-ceremony guard. Mirror it rather than
    // dropping the tap: a return that changes nothing is a button that visibly
    // does nothing, which is exactly how a running ceremony used to look.
    if (walletAccessController.isBusy()) {
      setBusy(true);
      return;
    }
    const attempt = ++attemptRef.current;
    setBusy(true);
    setHint(null);
    const result = await walletAccessController.requestAccess(source);
    // A newer attempt already owns the screen — a late result from this one
    // must not overwrite what that attempt showed, least of all a success.
    if (attempt !== attemptRef.current) return;
    setBusy(false);
    // "unlocked" dismisses this layer from App via the wallet-unlocked signal.
    setHint(hintFor(result));
  }, []);

  useEffect(() => {
    if (!visible) {
      setBusy(false);
      setHint(null);
      autoAccessAttemptedRef.current = false;
      return;
    }

    if (autoAccessAttemptedRef.current) return;
    autoAccessAttemptedRef.current = true;
    void handleWalletAccess("auto");
  }, [handleWalletAccess, visible]);

  return (
    <FullscreenLayer visible={visible}>
      <View direction="column" align="center" gap="xl" paddingTop="lg">
        <BrandDisplayTitle>{t("screen.BiometricLockModal.headline")}</BrandDisplayTitle>
      </View>

      <View direction="column" align="center" justify="center" fill="grow">
        <WalletLockIllustration width={240} height={240} />
      </View>

      {hint ? (
        <Text size="md" muted align="center">
          {hint}
        </Text>
      ) : null}

      <Button
        size="lg"
        variant="solid"
        accent="lilac"
        disabled={busy}
        onPress={() => void handleWalletAccess("button")}
        accessibilityLabel={t("screen.SecureKeyStorage.accessWalletTitle")}
      >
        <ButtonText>{t("screen.SecureKeyStorage.accessWalletTitle")}</ButtonText>
      </Button>
    </FullscreenLayer>
  );
}
