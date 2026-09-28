export class ArkadeMaxSendAmountError extends Error {
  readonly maxAmountSats: number;

  constructor(maxAmountSats: number) {
    super("arkade_max_send_amount_required");
    this.name = "ArkadeMaxSendAmountError";
    this.maxAmountSats = Math.max(0, Math.trunc(Number(maxAmountSats || 0)));
  }
}

export function isArkadeMaxSendAmountError(error: unknown): error is ArkadeMaxSendAmountError {
  return (
    error instanceof ArkadeMaxSendAmountError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "ArkadeMaxSendAmountError" &&
      Number.isFinite(Number((error as { maxAmountSats?: unknown }).maxAmountSats)))
  );
}

export function maxFundableAmountSats(params: {
  availableSats: number;
  requestedSats: number;
  fundingSats: number;
}): number {
  const availableSats = Math.max(0, Math.trunc(Number(params.availableSats || 0)));
  const requestedSats = Math.max(0, Math.trunc(Number(params.requestedSats || 0)));
  const fundingSats = Math.max(0, Math.trunc(Number(params.fundingSats || 0)));
  const feeSats = Math.max(0, fundingSats - requestedSats);
  return Math.max(0, availableSats - feeSats);
}
