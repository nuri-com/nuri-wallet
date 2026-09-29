// screens/wirex/hooks/useWirexOnboarding.ts
// Wirex account opening + KYC, from the email screen to the public permalink.
// Kept out of any one screen so any surface can offer signup without a
// second copy of the flow: the entered email IS the account key, the Nuri
// handle belonging to the authenticated wallet is sent as `username`, and its
// stable public permalink resumes an unfinished verification without redeploying.
//
// The caller owns what happens after the external KYC browser opens — Home
// starts its card-ready poll there, other screens just let account state refresh.
// `onBeforeStart` fires before either entry point does any work, so a caller
// with a running poll can cancel it first.
import { useCallback, useState } from "react";
import { Linking, Platform } from "react-native";
import { LOG_EMOJI, logWithId, warnWithId } from "../../../lib/OperationLogUtils";
import { getEthereumAddress } from "../../../lib/secureKeyStorage";
import { wirexKycPermalink } from "../../../lib/wirex/kycPermalink";
import { wirexService } from "../../../services/wirex/WirexService";

const SOURCE = "screens/wirex/hooks/useWirexOnboarding.ts";

async function openKycPermalink(url: string): Promise<void> {
  // RN Web defaults to window.open(_blank), which browsers block after the
  // asynchronous account deployment loses its user gesture. Same-tab navigation
  // is never a popup; native still hands the permalink to the system browser.
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.location.assign(url);
    return;
  }
  await Linking.openURL(url);
}

export type WirexOnboardingOptions = {
  /** External KYC browser opened; start watching for approval/provisioning. */
  onKycFinished?: () => void;
  /** Runs before an entry point starts — cancel any caller-owned polling here. */
  onBeforeStart?: () => void;
  /** Verified username belonging to the authenticated wallet. */
  username?: string | null;
};

export type WirexOnboardingState = {
  /** The email screen is open (first-time account opening). */
  emailEntryVisible: boolean;
  busy: boolean;
  failed: boolean;
  /** Open the email screen — the first-time "Open Free Account" entry point. */
  start: () => void;
  /** Close the email screen without onboarding. */
  cancel: () => void;
  /** Email submitted: pin it as the account key, then onboard and launch KYC. */
  submitEmail: (email: string) => Promise<void>;
  /** Re-enter a stalled verification on an account that already exists. */
  continueVerification: () => Promise<void>;
};

export function useWirexOnboarding(options?: WirexOnboardingOptions): WirexOnboardingState {
  const { onKycFinished, onBeforeStart, username: authenticatedUsername } = options ?? {};
  const [emailEntryVisible, setEmailEntryVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const resolveKycIdentity = useCallback(() => {
    const username = String(authenticatedUsername || "")
      .trim()
      .toLowerCase();
    const permalink = wirexKycPermalink(username);
    if (!permalink) throw new Error("no_username");
    return { username, permalink };
  }, [authenticatedUsername]);

  // Shared onboarding tail: given a pinned account email, run onboarding
  // (Kernel deploy + passkey co-signer + partner registration, ~13s), then open
  // the stable username permalink in the system browser. The waiting sheet stays
  // visible until deployment has completed and the browser accepted the KYC url.
  const onboardAndLaunchKyc = useCallback(
    async (email: string, beforeKyc?: () => void) => {
      const address = await getEthereumAddress();
      if (!address) {
        throw new Error("no_wallet");
      }
      const { username, permalink } = resolveKycIdentity();
      await wirexService.onboard({ username, email });
      logWithId(
        `${LOG_EMOJI.card} WirexOnboarding`,
        "identity verification ready",
        { status: "kyc_permalink_ready" },
        {
          context: "user",
          event: "FLOW",
          scope: "WirexOnboarding",
          action: "openFreeAccount",
          source: `${SOURCE}#onboardAndLaunchKyc`,
        },
      );
      await openKycPermalink(permalink);
      beforeKyc?.();
      onKycFinished?.();
    },
    [onKycFinished, resolveKycIdentity],
  );

  const start = useCallback(() => {
    setFailed(false);
    setEmailEntryVisible(true);
  }, []);
  const cancel = useCallback(() => {
    setFailed(false);
    setEmailEntryVisible(false);
  }, []);

  // First-time account opening: the entered email IS the account key. Nothing
  // is created before this — pin the email, then onboard.
  const submitEmail = useCallback(
    async (email: string) => {
      if (busy) return;
      onBeforeStart?.();
      setFailed(false);
      setBusy(true);
      try {
        logWithId(
          `${LOG_EMOJI.card} WirexOnboarding`,
          "open free account submitted",
          { status: "start" },
          {
            context: "user",
            event: "FLOW",
            scope: "WirexOnboarding",
            action: "openFreeAccount",
            source: `${SOURCE}#submitEmail`,
          },
        );
        const pinnedEmail = await wirexService.pinAccountEmail(email);
        await onboardAndLaunchKyc(pinnedEmail, () => setEmailEntryVisible(false));
      } catch (e) {
        setFailed(true);
        warnWithId(
          `${LOG_EMOJI.card} WirexOnboarding`,
          // Reason goes in the message (not just extra): the clean console
          // renderer keeps only the story sentence and drops the `data=` tail,
          // so a bare "failed" hides the server error. Surface it inline.
          `open free account failed: ${e instanceof Error ? e.message : "unknown"}`,
          { message: e instanceof Error ? e.message : "unknown" },
          {
            context: "user",
            event: "API_ERR",
            scope: "WirexOnboarding",
            action: "openFreeAccount",
            source: `${SOURCE}#submitEmail`,
          },
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, onBeforeStart, onboardAndLaunchKyc],
  );

  // Re-enter a stalled verification through the stable public permalink. It is
  // keyed by the authenticated wallet username, so it survives dynamic Sumsub
  // session expiry and never repeats account deployment.
  const continueVerification = useCallback(async () => {
    if (busy) return;
    onBeforeStart?.();
    setBusy(true);
    try {
      logWithId(
        `${LOG_EMOJI.card} WirexOnboarding`,
        "continue verification pressed",
        { status: "start" },
        {
          context: "user",
          event: "FLOW",
          scope: "WirexOnboarding",
          action: "continueVerification",
          source: `${SOURCE}#continueVerification`,
        },
      );
      const { permalink } = resolveKycIdentity();
      await openKycPermalink(permalink);
      onKycFinished?.();
    } catch (e) {
      warnWithId(
        `${LOG_EMOJI.card} WirexOnboarding`,
        `continue verification failed: ${e instanceof Error ? e.message : "unknown"}`,
        { message: e instanceof Error ? e.message : "unknown" },
        {
          context: "user",
          event: "API_ERR",
          scope: "WirexOnboarding",
          action: "continueVerification",
          source: `${SOURCE}#continueVerification`,
        },
      );
    } finally {
      setBusy(false);
    }
  }, [busy, onBeforeStart, onKycFinished, resolveKycIdentity]);

  return {
    emailEntryVisible,
    busy,
    failed,
    start,
    cancel,
    submitEmail,
    continueVerification,
  };
}
