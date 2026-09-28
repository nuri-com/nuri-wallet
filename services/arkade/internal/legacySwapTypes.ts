// Legacy swap-record types, kept locally because the swap provider package that
// defined them is out of the dependency tree.
//
// Why these still exist: devices hold swap records written by the retired
// Lightning engine. The persistence layer must keep describing them to read and
// clear them; nothing here talks to a provider.
//
// Structural only — copied from the retired package's public surface, narrowed
// to the fields this app actually reads.

/** The network label the retired package used. Ark addresses and invoices are
 * the only things it ever qualified. */
export type Network = "bitcoin" | "testnet" | "signet" | "mutinynet" | "regtest";

/** Lifecycle of a Boltz swap record, as persisted. Strings by design: these
 * came off the wire and are only compared, never constructed. */
export type BoltzSwapStatus = string;

/** A persisted Boltz swap record. Only the fields the repository filters and
 * sorts on are named; the rest are carried opaquely. */
export type BoltzSwap = {
  id?: string;
  status?: BoltzSwapStatus;
  type?: string;
  createdAt?: number;
  [key: string]: unknown;
};

/** The repository shape the retired package expected. Implemented by
 * `ArkadeV4SwapRepository` so historical records stay readable and clearable. */
export type SwapRepository = {
  saveSwap<T extends BoltzSwap>(swap: T): Promise<void>;
  deleteSwap(id: string): Promise<void>;
  getAllSwaps<T extends BoltzSwap>(filter?: unknown): Promise<T[]>;
  clear?(): Promise<void>;
  [Symbol.asyncDispose]?(): Promise<void>;
};
