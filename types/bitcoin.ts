// Centralized types for bitcoin domain — extracted from screen files
export type BitcoinTransactionsProps = {
  visible: boolean;
  onClose: () => void;
  address?: string;
  /**
   * Every address whose on-chain rows belong to this rail. A row is classified
   * against the address it was read for, so this list is what decides rail
   * membership and cannot be collapsed into `address`. History only: `address`
   * stays the single address the rail fetches, caches and is paid at.
   * Omitted = the rail is exactly `address`.
   */
  historyAddresses?: readonly string[];
  /**
   * Which bitcoin rail's activity this is. The two rails are separate accounts —
   * the arkade wallet and the MuSig2 on-chain one — and the fetch returns both,
   * so without this each rail's list showed the other's transactions as well.
   * Omitted = both, which is what the app did before the rails were separate.
   */
  rail?: "arkade" | "onchain";
};

export type TxInput = {
  txid?: string;
  vout?: number;
  prevout?: {
    scriptpubkey?: string;
    scriptpubkey_address?: string;
    value?: number;
  } | null;
};

export type TxOutput = {
  scriptpubkey: string;
  scriptpubkey_address?: string;
  value?: number;
};

export type AddressTx = {
  txid: string;
  fee?: number;
  status?: {
    confirmed: boolean;
    block_time?: number;
    block_height?: number;
    block_hash?: string;
  };
  vin?: TxInput[];
  vout: TxOutput[];
};

export type BitcoinSendProps = {
  visible: boolean;
  presetAddress?: string;
  presetAmountSats?: string;
  allowAmountEdit?: boolean;
  /** Which wallet the sats leave from, chosen in BitcoinSendSourceModal. */
  sendSource?: "arkade" | "onchain";
  onClose: () => void;
  onSendSuccess?: (payload: { txId: string }) => void;
};
