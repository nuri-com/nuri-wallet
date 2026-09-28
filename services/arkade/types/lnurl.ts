export type ArkadeLnurlStatus = {
  username: string | null;
  registered: boolean;
  lightningAddress: string | null;
  evmAddress: string | null;
  arkadeAddress: string | null;
  btcAddress: string | null;
  email: string | null;
  lnurlpUrl: string | null;
  callbackUrl: string | null;
  minSendableMsat: number;
  maxSendableMsat: number;
  hasPublishedInvoice: boolean;
  invoiceExpiresAtMs: number;
};

export type ArkadePendingLnurlSwapRestore = {
  id: string;
  type: "reverse";
  createdAt: number;
  preimage: string;
  status: string;
  request?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
};

export type ArkadePendingLnurlSwap = {
  id: string;
  username: string;
  invoice: string;
  preimageHex: string;
  preimageHashHex: string;
  amountSats: number;
  amountMsat: number;
  status: string;
  invoicePrefix: string;
  createdAtMs: number;
  updatedAtMs: number;
  restore: ArkadePendingLnurlSwapRestore | null;
};
