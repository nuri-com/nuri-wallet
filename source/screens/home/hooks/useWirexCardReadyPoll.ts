// screens/home/hooks/useWirexCardReadyPoll.ts
// Wirex issues the card asynchronously after KYC approval, and the review itself
// runs minutes to hours. Neither transition reaches the app through any channel,
// so polling is the only way the home flips from "open an account" to a usable
// VISA/IBAN rail without the user relaunching.
//
// One loop, two cadences: a fast burst while the card data is expected to be
// filling in, then — only while the review is still merely submitted — a slow
// re-check that keeps going, because a bounded burst cannot outlast a review.
// An approved account whose card never arrives stops instead: that is a support
// case, not something more requests fix.
//
// Reads only. `silentRefetch` never flips the account into a loading state, so
// this can run under whatever the user has open.
import { useCallback, useEffect, useRef, useState } from "react";
import { isWirexCardReady } from "../../../lib/wirex/cardState";
import { LOG_EMOJI, logWithId, warnWithId } from "../../../lib/OperationLogUtils";
import type { WirexCardSnapshot } from "../../../services/wirex/WirexAccountService";
import type { WirexCardState } from "../../wirex/hooks/useWirexCard";

const CARD_READY_POLL_INTERVAL_MS = 3000;
const CARD_READY_POLL_MAX_ATTEMPTS = 40;
const VERIFICATION_POLL_INTERVAL_MS = 20000;

const SOURCE = "screens/home/hooks/useWirexCardReadyPoll.ts";

/** True while Wirex has the application but has not decided on it yet. */
function isVerificationPending(snapshot: WirexCardSnapshot | null): boolean {
  if (!snapshot || snapshot.isApproved) return false;
  return (snapshot.verificationStatus || "").trim().toLowerCase() === "applied";
}

export function useWirexCardReadyPoll(snapshot: WirexCardState): {
  /** Call when the KYC sheet closes — starts the burst even before approval lands. */
  onKycFinished: () => void;
} {
  const cardReady = isWirexCardReady(snapshot);
  const approved = snapshot.isApproved;
  const verificationPending = !cardReady && isVerificationPending(snapshot);

  // A fresh KYC completion restarts the loop even when nothing else changed.
  const [kycToken, setKycToken] = useState(0);
  const onKycFinished = useCallback(() => setKycToken((n) => n + 1), []);

  // The refetch identity changes every render; the loop must not restart for it.
  const silentRefetchRef = useRef(snapshot.silentRefetch);
  useEffect(() => {
    silentRefetchRef.current = snapshot.silentRefetch;
  }, [snapshot.silentRefetch]);

  useEffect(() => {
    if (cardReady) return;
    if (!approved && !verificationPending && kycToken === 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    logWithId(`${LOG_EMOJI.card} Home.cardReadyPoll`, "card ready poll started", {
      approved,
      verification_pending: verificationPending,
    });

    const run = async () => {
      attempt += 1;
      const next = await silentRefetchRef.current().catch((): WirexCardSnapshot | null => null);
      if (cancelled) return;
      // Readiness flips the effect's own inputs, which tears this down.
      if (isWirexCardReady(next)) return;
      const stillPending = isVerificationPending(next);
      if (attempt >= CARD_READY_POLL_MAX_ATTEMPTS && !stillPending) {
        warnWithId(
          `${LOG_EMOJI.card} Home.cardReadyPoll`,
          "card ready poll stopped",
          { attempt, status: "max_attempts" },
          { context: "poll", event: "TIMEOUT", source: `${SOURCE}#run` },
        );
        return;
      }
      timer = setTimeout(
        () => void run(),
        attempt < CARD_READY_POLL_MAX_ATTEMPTS
          ? CARD_READY_POLL_INTERVAL_MS
          : VERIFICATION_POLL_INTERVAL_MS,
      );
    };

    timer = setTimeout(() => void run(), CARD_READY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [cardReady, approved, verificationPending, kycToken]);

  return { onKycFinished };
}
