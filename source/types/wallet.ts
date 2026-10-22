import type { SendBalanceOption } from "../components/send/SendFromRow";
import type { SendBalance } from "../lib/send/sendRouting";
// Centralized types for wallet domain — extracted from screen files
import type { ZapRemitDestination } from "../lib/remit/zapremitForm";

export type PendingWalletTransfer = {
  amount: number;
  createdAt: string;
  txHash?: string | null;
  orderId?: string | null;
  depositAddress?: string | null;
  // Payment hash of the Lightning invoice a EURC→BTC swap settles to. It links
  // this row to the Arkade receive, which learns the sats arrived well before
  // SwapKit reports the order terminal.
  paymentHash?: string | null;
  kind: "wallet_transfer" | "card_topup" | "bank_transfer";
  /** Which way the money moves on THIS rail: `out` is a debit (the source leg
   * of a swap or a plain send), `in` a credit (the destination leg). A single
   * stable→stable order writes BOTH — a debit on the source rail and a credit
   * on the destination rail — so this, together with `fiat`, is what lets two
   * rows share one orderId. Absent on older rows: their direction is inferred
   * from `source` (kept back-compatible in pendingTransferView). */
  direction?: "in" | "out";
  /**
   * Which stablecoin rail this transfer is on — the euro wallet or the dollar
   * one. They are two balances at one address, so a row without it was shown on
   * the euro rail and written as euros whatever it actually spent. Absent on
   * rows persisted before this existed, which are euro by construction: the
   * dollar rail could not produce one.
   */
  fiat?: "EUR" | "USD";
  source?: string | null;
  // Absolute ceiling any approval/CoW signature for this order may carry, in
  // EURC. `amount` is what actually left (already up to the accepted drift), so
  // resuming from it and applying the drift multiplier again would authorize
  // quote x 1.05^2. The cap is computed once, at quote time, and is the only
  // value a cold resume may bound with.
  maxSellEurc?: number | null;
};

export type WalletDetailsProps = {
  visible: boolean;
  onClose: () => void;
  accountHolderName?: string | null;
  accountHolderAddress?: string | null;
  iban?: string | null;
  bic?: string | null;
  siweAddress?: string | null;
};

export type BankInfo = {
  address: string;
};

export type WalletSendStablecoinProps = {
  visible: boolean;
  onClose: () => void;
  prefilledAddress?: string | null;
  prefilledAmount?: string | null;
  /** A payout destination a scanned code named (a TanQR merchant). */
  presetPayout?: ZapRemitDestination | null;
  maxStablecoinAvailable?: number | null;
  /** Card top-up: "Send Euro to Card" headline, recipient (the AA address) stays hidden. */
  toCard?: boolean;
  /**
   * Which ERC20 leaves the wallet. Defaults to the home-currency stablecoin
   * (EURC). The unified home's Dollar row passes USDC: same transfer, same
   * sheet, only the contract and the symbol differ.
   */
  token?: {
    address: `0x${string}`;
    decimals: number;
    /** Rendered next to every amount — "€" for EURC, "$" for USDC. */
    symbol: string;
    /** Accessibility/copy code, e.g. "EUR" / "USD". */
    code: string;
  };
  onSuccess?: (payload: { amount: number; txHash?: string | null; confirmed: boolean }) => void;
  /** The recipient as a person (contact, Nuri user): shown by name, not address. */
  person?: { name: string; nuriUsername?: string } | null;
  /** Every balance that can pay this recipient, for the "From" picker. */
  balanceOptions?: SendBalanceOption[];
  /** The balance this screen pays from. */
  balance?: SendBalance;
  /** Another balance picked: the host opens the screen that pays from it. */
  onPickBalance?: (key: SendBalance) => void;
};

export type WalletIbanRecipientProps = {
  visible: boolean;
  onClose: () => void;
  onContinue?: (data: {
    iban: string;
    firstName: string;
    lastName: string;
    reference?: string;
  }) => void;
  onScanPress?: () => void;
  prefilledIban?: string;
  prefilledFirstName?: string;
  prefilledLastName?: string;
  prefilledReference?: string;
};

export type WalletIbanAmountConfirmationProps = {
  visible: boolean;
  onClose: () => void;
  iban: string;
  firstName: string;
  lastName: string;
  reference?: string;
  prefilledAmount?: string | null;
  currency?: string | null;
  maxStablecoinAvailable?: number | null;
  onSuccess?: (address?: string | null) => void;
};

// ── Wallet transaction row types ─────────────────────────────────────────
// The wallet transaction layer: normalized Base onchain EVM transfers plus
// synthesized card events and local pending transfers.

export type WalletTransactionsProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * Which token's history this is. The wallet holds euro and dollar on ONE
   * address, so the address cannot tell the two rails apart — without this the
   * Dollar rail shows euro rows and no USDC at all. Omitted = euro.
   */
  token?: { address: `0x${string}`; fiatCode: string };
  address?: string | null;
  primaryAddress?: string | null;
  secondaryAddress?: string | null;
  explorerAddress?: string | null;
  pendingTransfers?: Array<{
    amount: number;
    createdAt: string;
    txHash?: string | null;
    orderId?: string | null;
    kind: "wallet_transfer" | "card_topup" | "bank_transfer";
    source?: string | null;
    /** Which stable rail the row belongs to; absent means the euro one. */
    fiat?: "EUR" | "USD";
  }>;
  onRepeatIbanSend?: (data: { iban: string; firstName: string; lastName: string }) => void;
  /** Send again to a row's recipient: the Cash send opens on that address, from this list's currency. */
  onSendAgain?: (address: string) => void;
};

export type WalletOrderState = "placed" | "pending" | "processed" | "rejected";
export type WalletOrderKind = "issue" | "redeem";

export type WalletCounterpartDetails = {
  firstName?: string;
  lastName?: string;
  name?: string;
  companyName?: string;
  country?: string;
};

export type WalletOrderMeta = {
  placedAt: string;
  processedAt?: string;
  rejectedReason?: string;
  supportingDocumentId?: string;
  txHashes?: string[];
};

// `WalletTransactionRow` is what the wallet transaction list consumes: a
// normalized row covering Base onchain transfers, synthesized card events, and
// local pending transfers. The `kind` and `meta` extensions are app-specific.

export type WalletTransactionRowKind =
  | WalletOrderKind
  | "card_topup"
  | "card_topup_swap"
  | "card_withdrawal"
  | "wallet_transfer_in"
  | "wallet_transfer_out"
  | "wallet_transfer_pending"
  | "card_topup_pending"
  | "bank_transfer_pending"
  | "pending_balance";

export type WalletTransactionRowMeta = Partial<WalletOrderMeta> & {
  // Synthesized onchain rows + local pending entries store a single tx hash here.
  txHash?: string | null;
  source?: "onchain_card" | "onchain_wallet" | "pending_topup" | string;
  from?: string;
  to?: string;
  orderId?: string | null;
  amount?: string | number;
};

export type WalletTransactionRow = {
  id: string;
  kind: WalletTransactionRowKind | string;
  state?: WalletOrderState | string;
  amount?: string;
  currency?: string;
  chain?: string;
  profile?: string;
  address?: string;
  counterpart?: {
    identifier?: Partial<{
      standard: string;
      iban: string;
      IBAN: string;
      address: string;
      chain: string;
    }>;
    details?: WalletCounterpartDetails;
  };
  memo?: string;
  referenceNumber?: string;
  meta?: WalletTransactionRowMeta;
  transactions?: Array<{ status?: string | null; hash?: string | null }> | null;
};
