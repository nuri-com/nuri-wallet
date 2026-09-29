// Centralized types for mercuryo domain — extracted from screen files

export type MercuryoBuyBitcoinProps = {
  visible: boolean;
  onClose: () => void;
  bitcoinAddress?: string | null;
};

export type MercuryoStatusSnapshot = {
  status: string;
  merchantTransactionId?: string;
  amountSats?: number;
  transactionId?: string;
  callbackId?: string;
  blockchainTxId?: string;
  failureReason?: string;
  type?: string;
  paymentMethod?: string;
  cardCountry?: string;
  createdAt?: string;
  updatedAt?: string;
  fiatAmount?: string;
  fiatCurrency?: string;
  cryptoAmount?: string;
  cryptoCurrency?: string;
  count?: number;
  matchedCount?: number;
  selectionReason?: string;
  selectedIndex?: number;
  httpStatus?: number;
};

export type DebugMercuryoProps = {
  visible: boolean;
  onClose: () => void;
};
