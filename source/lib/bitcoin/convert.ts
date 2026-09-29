import type { TxInput, TxOutput } from "../../types/bitcoin";

export const SATS_PER_BTC = 100_000_000;

export function satsToFiat(sats: number, fiatPerBtc: number | null): number | null {
  if (fiatPerBtc === null) return null;
  return (sats / SATS_PER_BTC) * fiatPerBtc;
}

/**
 * What the two-unit amount entry currently means in sats. In sats mode the
 * typed digits ARE the answer; in fiat mode they are converted at the live
 * rate, and without a rate there is no amount yet.
 */
export function satsFromAmountEntry(
  isSatsMode: boolean,
  satsDigits: string,
  fiatDigits: string,
  fiatPerBtc: number | null,
): number {
  if (isSatsMode) {
    const sats = satsDigits ? Number(satsDigits) : 0;
    return Number.isFinite(sats) ? sats : 0;
  }
  if (!fiatPerBtc || fiatPerBtc <= 0) return 0;
  const fiat = fiatDigits ? Number(fiatDigits) : 0;
  if (!Number.isFinite(fiat)) return 0;
  return Math.round((fiat / fiatPerBtc) * SATS_PER_BTC);
}

export function classifyTransaction(
  t: { vin?: TxInput[]; vout?: TxOutput[] },
  addr: string,
): { isIncoming: boolean; amountSats: number } {
  const fromSelf = (t.vin || []).reduce((sum, vin) => {
    const a = vin?.prevout?.scriptpubkey_address;
    const v = vin?.prevout?.value || 0;
    return sum + (a === addr ? v : 0);
  }, 0);
  const toSelf = (t.vout || []).reduce((sum, vout) => {
    const a = vout?.scriptpubkey_address;
    const v = vout?.value || 0;
    return sum + (a === addr ? v : 0);
  }, 0);
  const toOthers = (t.vout || []).reduce((sum, vout) => {
    const a = vout?.scriptpubkey_address;
    const v = vout?.value || 0;
    return sum + (a && a !== addr ? v : 0);
  }, 0);
  if (fromSelf > 0) {
    const sent = toOthers > 0 ? toOthers : Math.max(0, fromSelf - toSelf);
    return { isIncoming: false, amountSats: sent };
  }
  return { isIncoming: true, amountSats: toSelf };
}
