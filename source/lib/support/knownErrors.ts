// Plain-English explanations for the failures the app knows (#2008).
//
// A failure report in the support chat says what happened in words a person
// reads, never the raw exception: the exception goes into the silent
// diagnostic report under the same report id. Each entry pairs a stable code
// (what support searches for) with the sentence the chat shows. A failure no
// entry matches is said to be unknown, never guessed.
//
// Pure: matched on the error's name, message, code and flags only, so it runs
// in tests and imports no service.

export type ExplainedError = {
  /** Stable id of the known failure; null when the cause is unknown. */
  code: string | null;
  /** One plain sentence for the support chat. */
  explanation: string;
};

type Entry = {
  code: string;
  explanation: string;
  matches: (text: string, error: unknown) => boolean;
};

export const UNKNOWN_ERROR_EXPLANATION = "The app could not tell what went wrong.";

const has = (pattern: RegExp) => (text: string) => pattern.test(text);

// Most specific first: an unconfirmed withdrawal can also carry a timeout in
// its text, and it must still read as unconfirmed.
const KNOWN_ERRORS: readonly Entry[] = [
  {
    code: "wirex_withdraw_unconfirmed",
    explanation:
      "The card withdrawal was sent, but the app could not confirm it yet. It may still arrive, so it should not be sent again.",
    matches: has(/WirexWithdrawUnconfirmedError|wirex_withdraw_unconfirmed/),
  },
  {
    code: "uk_transfer_unconfirmed",
    explanation:
      "The bank transfer was sent, but the app could not confirm it yet. It may still arrive, so it should not be sent again.",
    matches: has(/WirexUkTransferUnconfirmedError|uk_transfer_unconfirmed/),
  },
  {
    code: "unconfirmed_outcome",
    explanation:
      "The app could not confirm whether this went through. It may still complete, so it should not be sent again.",
    // The flag every surface that could pay twice asks (isUnresolvedCommitOutcome).
    matches: (_text, error) => (error as { unresolved?: unknown } | null)?.unresolved === true,
  },
  {
    code: "wirex_withdraw_busy",
    explanation:
      "Another card withdrawal or exchange was still running, so this one was not started.",
    matches: has(/WirexWithdrawBusyError|wirex_withdraw_busy/),
  },
  {
    code: "wirex_withdraw_route_down",
    explanation: "The card service could not be reached, so nothing was started.",
    matches: has(/WirexWithdrawRouteDownError|wirex_withdraw_route_down/),
  },
  {
    code: "lightning_payment_already_started",
    explanation: "This invoice was already being paid by an earlier tap, so nothing new was sent.",
    matches: has(
      /LightningPaymentAlreadyStartedError|lightning_payment_already_started|lightning_invoice_already_paid/,
    ),
  },
  {
    code: "onchain_fee_shortfall",
    explanation: "There was not enough bitcoin left to pay the network fee, so nothing was sent.",
    matches: has(/OnchainFeeShortfallError|onchain_fee_shortfall/),
  },
  {
    code: "arkade_max_send_amount",
    explanation: "The amount was more than this balance can send after fees, so nothing was sent.",
    matches: has(/ArkadeMaxSendAmountError|arkade_max_send_amount_required/),
  },
  {
    code: "arkade_vtxo_too_fresh",
    explanation: "Bitcoin received recently cannot be moved onchain yet, so nothing was sent.",
    matches: has(/ArkadeVtxoTooFreshError|arkade_vtxo_too_fresh_for_settlement/),
  },
  {
    code: "bitcoin_send_still_checking",
    explanation: "An earlier bitcoin payment is still being checked, so this one was not started.",
    matches: has(
      /DirectArkadeSendReconciliationRequiredError|direct_arkade_send_reconciliation_required/,
    ),
  },
  {
    code: "rate_limited",
    explanation: "The server was busy and asked the app to wait, so the request did not finish.",
    matches: has(/\b429\b|too many requests|rate[ -]?limit|cloudflare_1015/i),
  },
  {
    code: "offline",
    explanation: "The app lost its connection to the server.",
    matches: has(
      /network request failed|failed to fetch|networkerror|fetch failed|load failed|internet_disconnected|ECONNRESET|ENOTFOUND|ECONNREFUSED|\boffline\b/i,
    ),
  },
  {
    code: "timeout",
    explanation: "The server took too long to answer.",
    matches: has(/timed? ?out|timeout|ETIMEDOUT|AbortError/i),
  },
];

function errorText(error: unknown, depth = 0): string {
  if (error === null || error === undefined) return "";
  if (typeof error !== "object") return String(error);
  const e = error as { name?: unknown; message?: unknown; code?: unknown };
  const parts = [e.name, e.message, e.code].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && depth < 2) parts.push(errorText(cause, depth + 1));
  return parts.join(" ");
}

/** The known failure this error is, or an honest "unknown". */
export function explainError(error: unknown): ExplainedError {
  const text = errorText(error);
  const known = KNOWN_ERRORS.find((entry) => entry.matches(text, error));
  return known
    ? { code: known.code, explanation: known.explanation }
    : { code: null, explanation: UNKNOWN_ERROR_EXPLANATION };
}
