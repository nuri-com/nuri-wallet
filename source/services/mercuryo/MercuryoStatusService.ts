// Mercuryo transaction-status lookup — moved out of MercuryoBuyBitcoinModal so
// a purchase can be followed with no sheet on screen.
import { MERCURYO_STATUS_ENDPOINT } from "../../config/endpoints";
import { parseTimestampMs } from "../../lib/date";
import { shortValue } from "../../lib/formatting";
import {
  mercuryoFlowLog,
  normalizeMercuryoStatus,
  normalizeMtid,
  parseFailureReason,
  parseSatsFromMercuryoItem,
} from "../../lib/mercuryo/helpers";
import type { MercuryoStatusSnapshot } from "../../types/mercuryo";

type MercuryoStatusItem = {
  status?: unknown;
  transactionId?: unknown;
  transaction_id?: unknown;
  merchantTransactionId?: unknown;
  merchant_transaction_id?: unknown;
  callbackId?: unknown;
  blockchainTxId?: unknown;
  type?: unknown;
  paymentMethod?: unknown;
  cardCountry?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  updatedAt?: unknown;
  updated_at?: unknown;
  fiatAmount?: unknown;
  fiatCurrency?: unknown;
  cryptoAmount?: unknown;
  cryptoCurrency?: unknown;
};

type MercuryoStatusResponse = {
  items?: MercuryoStatusItem[];
  count?: unknown;
};

const parseMercuryoStatusResponse = (text: string): MercuryoStatusResponse | null => {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as MercuryoStatusResponse;
  } catch {
    return null;
  }
};

export const fetchMercuryoStatus = async (mtid: string): Promise<MercuryoStatusSnapshot | null> => {
  const requestedMtid = String(mtid || "").trim();
  const requestedMtidNorm = normalizeMtid(requestedMtid);
  try {
    const url = `${MERCURYO_STATUS_ENDPOINT}?merchant_transaction_id=${encodeURIComponent(
      requestedMtid,
    )}`;
    const resp = await fetch(url);
    const text = await resp.text();
    const json = parseMercuryoStatusResponse(text);
    if (!resp.ok) {
      mercuryoFlowLog("status_fetch_http_error", {
        mtid: shortValue(requestedMtid),
        httpStatus: resp.status,
        body: shortValue(text, 140),
      });
      return null;
    }
    const items: MercuryoStatusItem[] = Array.isArray(json?.items) ? json.items : [];
    const count = Number.isFinite(Number(json?.count)) ? Number(json?.count) : items.length;

    type Candidate = {
      item: MercuryoStatusItem;
      index: number;
      status: string;
      txid: string;
      merchantTransactionId: string;
      merchantTransactionIdNorm: string;
      tsMs: number;
    };

    const candidates: Candidate[] = items.map((rawItem, index) => {
      const item = rawItem || {};
      const merchantTransactionId = String(
        item?.merchantTransactionId || item?.merchant_transaction_id || "",
      ).trim();
      const updatedAt = String(item?.updatedAt || item?.updated_at || "").trim();
      const createdAt = String(item?.createdAt || item?.created_at || "").trim();
      return {
        item,
        index,
        status: normalizeMercuryoStatus(item?.status),
        txid: String(item?.transactionId || item?.transaction_id || "").trim(),
        merchantTransactionId,
        merchantTransactionIdNorm: normalizeMtid(merchantTransactionId),
        tsMs: parseTimestampMs(updatedAt) || parseTimestampMs(createdAt),
      };
    });

    const exactMatches = candidates.filter(
      (entry) =>
        !!entry.merchantTransactionIdNorm && entry.merchantTransactionIdNorm === requestedMtidNorm,
    );
    const hasAnyMtid = candidates.some((entry) => !!entry.merchantTransactionIdNorm);

    let selected: Candidate | null = null;
    let selectionReason = "none";
    if (exactMatches.length > 0) {
      const sorted = [...exactMatches].sort((a, b) => (b.tsMs || 0) - (a.tsMs || 0));
      selected = sorted[0] || null;
      selectionReason = exactMatches.length > 1 ? "exact_mtid_latest" : "exact_mtid";
    } else if (candidates.length === 1 && !hasAnyMtid) {
      selected = candidates[0];
      selectionReason = "single_without_mtid_fallback";
    } else if (candidates.length > 0 && !hasAnyMtid) {
      selected = candidates[0];
      selectionReason = "no_mtid_in_payload_fallback";
    } else if (candidates.length > 0) {
      selectionReason = "mismatch_no_exact_mtid";
    }

    const first = selected?.item;
    const status = normalizeMercuryoStatus(first?.status);
    const amountSats = parseSatsFromMercuryoItem(first);
    const rawTxid = String(first?.transactionId || "").trim();
    const rawMerchantTransactionId = String(
      first?.merchantTransactionId || first?.merchant_transaction_id || "",
    ).trim();
    const rawCallbackId = String(first?.callbackId || "").trim();
    const rawBlockchainTxId = String(first?.blockchainTxId || "").trim();
    const rawType = String(first?.type || "").trim();
    const rawPaymentMethod = String(first?.paymentMethod || "").trim();
    const rawCardCountry = String(first?.cardCountry || "").trim();
    const rawCreatedAt = String(first?.createdAt || "").trim();
    const rawUpdatedAt = String(first?.updatedAt || "").trim();
    const rawFiatAmount = String(first?.fiatAmount || "").trim();
    const rawFiatCurrency = String(first?.fiatCurrency || "").trim();
    const rawCryptoAmount = String(first?.cryptoAmount || "").trim();
    const rawCryptoCurrency = String(first?.cryptoCurrency || "").trim();
    const failureReason = parseFailureReason(first);
    const transactionId = rawTxid || undefined;
    const sample = candidates
      .slice(0, 3)
      .map((entry) => {
        const key = entry.merchantTransactionId || entry.txid || `#${entry.index}`;
        return `${entry.status || "unknown"}:${shortValue(key)}`;
      })
      .join("|");
    mercuryoFlowLog("status_fetch", {
      mtid: shortValue(requestedMtid),
      httpStatus: resp.status,
      count,
      matchedCount: exactMatches.length,
      selectionReason,
      selectedIndex: selected?.index ?? -1,
      selectedStatus: status || "",
      selectedMtid: shortValue(rawMerchantTransactionId),
      selectedTxid: shortValue(transactionId),
      failureReason: failureReason ? shortValue(failureReason, 80) : "",
      sample,
    });
    return {
      status,
      merchantTransactionId: rawMerchantTransactionId || undefined,
      amountSats,
      transactionId,
      callbackId: rawCallbackId || undefined,
      blockchainTxId: rawBlockchainTxId || undefined,
      type: rawType || undefined,
      paymentMethod: rawPaymentMethod || undefined,
      cardCountry: rawCardCountry || undefined,
      createdAt: rawCreatedAt || undefined,
      updatedAt: rawUpdatedAt || undefined,
      fiatAmount: rawFiatAmount || undefined,
      fiatCurrency: rawFiatCurrency || undefined,
      cryptoAmount: rawCryptoAmount || undefined,
      cryptoCurrency: rawCryptoCurrency || undefined,
      failureReason,
      count,
      matchedCount: exactMatches.length,
      selectionReason,
      selectedIndex: selected?.index ?? undefined,
      httpStatus: resp.status,
    } as MercuryoStatusSnapshot;
  } catch (e: unknown) {
    const errMessage = e instanceof Error ? e.message : String(e);
    mercuryoFlowLog("status_fetch_exception", {
      mtid: shortValue(requestedMtid),
      error: errMessage,
    });
    return null;
  }
};
