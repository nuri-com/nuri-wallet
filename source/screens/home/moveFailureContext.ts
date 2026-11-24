// What a failed Move hands support besides the server's own words (#1842).
//
// A server failure can come back as nothing more than "internal error;
// reference = …", which says neither which route failed nor at which step. This
// line names them: the engine and pair, the server call that failed, its
// classified code and HTTP status, and whether any order reached this device.
// It carries no addresses, amounts, order ids or keys — only route and phase —
// so it is safe in a log line and in the support dump.

type QuoteLike = { engine: string; from: string; to: string };

type FailureFields = {
  name?: unknown;
  tool?: unknown;
  code?: unknown;
  httpStatus?: unknown;
  retryable?: unknown;
};

/** A short token only: anything else (free text, a value with spaces) is dropped. */
const token = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : null;

export function moveFailureContext(quote: QuoteLike, error: unknown): string {
  const fields = (error !== null && typeof error === "object" ? error : {}) as FailureFields;
  const parts = [
    `engine=${token(quote.engine) ?? "unknown"}`,
    `route=${token(quote.from) ?? "?"}->${token(quote.to) ?? "?"}`,
    // Reaching here means no order was handed off: nothing was signed or moved.
    "phase=pre-handoff",
    `call=${token(fields.tool) ?? "unknown"}`,
  ];
  const code = token(fields.code);
  if (code) parts.push(`code=${code}`);
  if (typeof fields.httpStatus === "number" && fields.httpStatus > 0) {
    parts.push(`http=${fields.httpStatus}`);
  }
  if (fields.retryable === true) parts.push("retryable=true");
  const name = token(fields.name);
  if (name && name !== "Error") parts.push(`error=${name}`);
  return parts.join(" ");
}
