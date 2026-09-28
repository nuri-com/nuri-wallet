export type QrParseResult =
  | {
      type: "bitcoin";
      address: string;
      amountSats?: number;
      label?: string;
      message?: string;
      lightning?: string;
      ark?: string;
    }
  | { type: "ark"; address: string; amountSats?: number }
  | {
      type: "lightning-invoice";
      invoice: string;
      amountSats?: number;
      description?: string;
      expiry?: number;
    }
  | { type: "lightning-address"; address: string }
  | { type: "lnurl"; url: string }
  | {
      type: "evm";
      /** For plain sends: the recipient. For ERC-20 /transfer: the token contract address. */
      address: string;
      chainId?: number;
      value?: bigint;
      /** For ERC-20 /transfer: the recipient address (from the `address` query param). */
      transferRecipient?: string;
      /** For ERC-20 /transfer: the token amount (from the `uint256` query param). */
      tokenAmount?: bigint;
      functionName?: string;
    }
  | {
      type: "sepa";
      iban: string;
      bic?: string;
      name?: string;
      amount?: number;
      currency?: string;
      reference?: string;
    }
  | { type: "iban"; iban: string }
  | { type: "bolt12-offer"; offer: string }
  | { type: "monero"; address: string; amountXmr?: number }
  | { type: "zcash"; address: string; amountZec?: number }
  | {
      type: "caip10";
      namespace: string;
      chainRef: string;
      address: string;
    }
  | { type: "unknown"; raw: string };

export type SuggestedAction = {
  label: string;
  sublabel?: string;
  icon: string;
  onPress: () => void;
};
