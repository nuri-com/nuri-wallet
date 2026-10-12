// lib/wirex/cardActionMessage.ts
// The EXACT string the MCP verifies for signed card mutations — it rebuilds this
// from the request args and recovers the signer from the signature, so it must
// match the server's cardActionMessage (nuri-wirex-mcp src/tools.mjs) byte-for-byte.
export type WirexCardAction = "freeze" | "unfreeze" | "activate" | "set-limit" | "close";

export function buildWirexCardActionMessage(params: {
  action: WirexCardAction;
  cardId: string;
  ts: number; // unix seconds; the server accepts ±5 minutes
  limit?: number; // set-limit only; -1 = no limit
  last4?: string; // close only; the digits the user was shown
}): string {
  const { action, cardId, ts, limit, last4 } = params;
  // `close` is deliberately NOT "close card <id>": the server signs (and the user
  // approves) the word PERMANENTLY plus the last4 they were shown, so the signed
  // string names the exact card and states the irreversibility. The server
  // re-checks last4 against Wirex (card_last4_mismatch / card_last4_unresolved).
  // Dropping the special case silently breaks every close.
  if (action === "close") {
    return `Nuri Wirex: PERMANENTLY close card ${cardId} ending ${last4 ?? ""} at ${ts}`;
  }
  const suffix = action === "set-limit" ? ` to ${limit}` : "";
  return `Nuri Wirex: ${action} card ${cardId}${suffix} at ${ts}`;
}

// The EXACT string the MCP verifies for a signed outbound SEPA transfer (money-out).
// Same contract as the card mutations: the server rebuilds this from the request
// args and recovers the signer, so it MUST match nuri-wirex-mcp src/tools.mjs
// byte-for-byte. Binds what the user approves — how much, to whom. `account_id`
// (the debit source/currency) is fixed server-side, so it isn't signed.
// ponytail: `amount` is a JS number stringified as-is; SEPA is 2dp so the form is
// stable. If a float-format mismatch ever appears, canonicalise to fixed-2dp on
// both sides — don't add that until a real drift shows up.
export function buildWirexSepaTransferMessage(params: {
  amount: number; // the same numeric value sent in the request body
  iban: string; // normalised (uppercase, no spaces) and sent verbatim
  ts: number; // unix seconds; the server accepts ±5 minutes
}): string {
  const { amount, iban, ts } = params;
  return `Nuri Wirex: sepa transfer ${amount} to ${iban} at ${ts}`;
}

// The EXACT string the MCP verifies for a push to card (money-out). Every value
// comes from the server's quote (wirex_card_transfer_estimate): the server
// rebuilds this from its stored quote, so it MUST match nuri-wirex-mcp
// src/card-payouts.mjs cardTransferMessage byte-for-byte. `amount` is the
// quote's number, stringified as JavaScript does on both sides.
export function buildWirexCardTransferMessage(params: {
  amount: number;
  currency: string;
  last4: string;
  estimationId: string;
  ts: number; // unix seconds; the server accepts ±5 minutes
}): string {
  const { amount, currency, last4, estimationId, ts } = params;
  return `Nuri Wirex: card transfer ${amount} ${currency} to card ending ${last4} quote ${estimationId} at ${ts}`;
}

// The EXACT string the MCP verifies when issuing an ADDITIONAL virtual card.
// Same contract as the other builders (byte-for-byte match with nuri-wirex-mcp).
// Both name fields are always present in the message: an omitted name signs as
// the empty string, so the server rebuilds the identical string from a body that
// left the field out. The signature is single-use server-side (replay →
// `signature_replayed`), which is what stops a lost response from turning into a
// second card.
export function buildWirexIssueVirtualCardMessage(params: {
  cardName?: string; // optional; omitted → ""
  nameOnCard?: string; // optional; omitted → ""
  ts: number; // unix seconds; the server accepts ±5 minutes
}): string {
  const { cardName = "", nameOnCard = "", ts } = params;
  return `Nuri Wirex: issue virtual card; card_name=${cardName}; name_on_card=${nameOnCard}; at ${ts}`;
}

// The server validates `last4` BEFORE anything else on POST /card/close and
// rejects with `last4_must_be_4_digits`, so anything but exactly four digits is
// a wasted passkey tap. Used both to gate the UI and to fail before signing.
export function isWirexCardLast4(value: string | null | undefined): boolean {
  return /^\d{4}$/.test((value ?? "").trim());
}

// Client-side guard mirroring the server's validation of the two name fields —
// run BEFORE signing so an invalid name never costs the user a passkey tap only
// to come back as a 400. The delimiter rule is a security rule, not cosmetics:
// the signed message joins fields with "; ", so a semicolon (or newline) inside a
// name could rebuild the next field and make two different name pairs produce
// identical signed bytes. The delimiter codes are the server's verbatim; the
// length codes are client-side (the server states the 1–50 / 2–26 bounds).
// Throws on the first violation; a blank/omitted name is not checked (the caller
// omits it and the server applies its default).
const VIRTUAL_CARD_NAME_RULES = [
  { field: "card_name", min: 1, max: 50 },
  { field: "name_on_card", min: 2, max: 26 },
] as const;

export function assertWirexVirtualCardNames(params: {
  cardName?: string;
  nameOnCard?: string;
}): void {
  const values = [params.cardName, params.nameOnCard];
  for (const [index, rule] of VIRTUAL_CARD_NAME_RULES.entries()) {
    const value = values[index];
    if (value === undefined || value === "") continue;
    if (/[;\r\n]/.test(value)) {
      throw new Error(`${rule.field}_must_not_contain_semicolon_or_newline`);
    }
    if (value.length < rule.min || value.length > rule.max) {
      throw new Error(`${rule.field}_must_be_${rule.min}_to_${rule.max}_chars`);
    }
  }
}

// The EXACT string the MCP verifies for an in-app 3DS challenge response.
// Same contract as the other builders: the server rebuilds this from the request
// body and recovers the signer, so it MUST match nuri-wirex-mcp byte-for-byte —
// a drift makes every in-app 3DS approval fail silently.
export function buildWirex3dsResponseMessage(params: {
  approve: boolean; // true → "approve", false → "decline"
  transactionId: string; // verbatim from the pending challenge
  ts: number; // unix seconds; the server accepts ±5 minutes
}): string {
  const { approve, transactionId, ts } = params;
  return `Nuri Wirex: 3ds ${approve ? "approve" : "decline"} ${transactionId} at ${ts}`;
}
