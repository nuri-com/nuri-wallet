// AsyncStorage-backed `WalletRepository` for React Native.
//
// SDK 0.5 removed `WalletRepositoryImpl`, the KV-backed wallet store this app
// passed its AsyncStorage adapter to. The replacements it ships —
// `InMemoryWalletRepository` and `IndexedDBWalletRepository` — are useless
// here: one loses state on reload, the other needs a browser.
//
// So the 0.4.62 implementation is ported verbatim, preserving:
//   - the storage keys (`vtxos:<addr>`, `utxos:<addr>`, `tx:<addr>`,
//     `wallet:state`), so data already on devices keeps loading;
//   - upsert-by-outpoint on save (never blind-overwrite);
//   - the SDK's own tapTree/tapLeaf/extraWitness hex encoding.
//
// Serialization mirrors the SDK's internal `serializeVtxo`/`deserializeVtxo`
// (dist/chunk-3TCWQPAC.js:11053+), which are not exported. If a future SDK
// changes that shape, this file must change with it.

import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import type {
  ArkTransaction,
  ExtendedCoin,
  ExtendedVirtualCoin,
  WalletRepository,
} from "@arkade-os/sdk";

// `WalletState` is declared but not named-exported by the SDK's bundled d.ts;
// derive it from the repository interface instead.
type WalletState = NonNullable<Awaited<ReturnType<WalletRepository["getWalletState"]>>>;

/** Minimal KV surface — satisfied by the app's AsyncStorage adapter. */
export type ArkadeKeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

const getVtxosStorageKey = (address: string) => `vtxos:${address}`;
const getUtxosStorageKey = (address: string) => `utxos:${address}`;
const getTransactionsStorageKey = (address: string) => `tx:${address}`;
const WALLET_STATE_STORAGE_KEY = "wallet:state";

type SerializedTapLeaf = { cb: string; s: string };
type TapLeafScript = [ReturnType<typeof TaprootControlBlock.decode>, Uint8Array];

const serializeTapLeaf = (t: TapLeafScript): SerializedTapLeaf => ({
  cb: hex.encode(TaprootControlBlock.encode(t[0])),
  s: hex.encode(t[1]),
});

const deserializeTapLeaf = (t: SerializedTapLeaf): TapLeafScript => [
  TaprootControlBlock.decode(hex.decode(t.cb)),
  hex.decode(t.s),
];

type AnyRecord = Record<string, unknown>;

type SerializedAsset = { assetId: string; amount: string };

const serializeAsset = (a: { assetId: string; amount: bigint }): SerializedAsset => ({
  assetId: a.assetId,
  amount: a.amount.toString(),
});

const deserializeAsset = (a: { assetId: string; amount: string | number | bigint }) => {
  if (typeof a.amount === "number" && !Number.isSafeInteger(a.amount)) {
    throw new Error(
      `Unsafe legacy asset amount for ${a.assetId}; re-sync from the original source`,
    );
  }
  return {
    assetId: a.assetId,
    amount: typeof a.amount === "bigint" ? a.amount : BigInt(a.amount),
  };
};

const serializeAssets = (assets: unknown) =>
  (assets as { assetId: string; amount: bigint }[] | undefined)?.map(serializeAsset);

const deserializeAssets = (assets: unknown) =>
  (assets as SerializedAsset[] | undefined)?.map(deserializeAsset);

/**
 * Restore the field defaults the SDK's own reader applied.
 *
 * SDK 0.4.62's `deserializeVtxo` piped every stored vtxo through
 * `normalizeVtxo`, which fills `isSpent`/`isSwept`/`isPreconfirmed`/`spentBy`/
 * `commitmentTxIds` and — crucially — revives `expiresAt` as a `Date`. Reading
 * without it leaves `expiresAt` a string, so every expiry comparison is
 * meaningless and cached coins can drop out of the balance. 0.5 no longer
 * exports `normalizeVtxo`, so the same defaults are applied here.
 */
const normalizeStoredVtxo = (v: AnyRecord): AnyRecord => ({
  ...v,
  isSpent: (v.isSpent as boolean | undefined) ?? false,
  isSwept: (v.isSwept as boolean | undefined) ?? false,
  isPreconfirmed: (v.isPreconfirmed as boolean | undefined) ?? false,
  spentBy: (v.spentBy as string | undefined) ?? "",
  commitmentTxIds: (v.commitmentTxIds as string[] | undefined) ?? [],
  expiresAt: v.expiresAt === undefined ? undefined : new Date(v.expiresAt as string | number),
  expiresAtHeight: v.expiresAtHeight,
});

const serializeCoin = (coin: AnyRecord): AnyRecord => ({
  ...coin,
  tapTree: hex.encode(coin.tapTree as Uint8Array),
  forfeitTapLeafScript: serializeTapLeaf(coin.forfeitTapLeafScript as TapLeafScript),
  intentTapLeafScript: serializeTapLeaf(coin.intentTapLeafScript as TapLeafScript),
  extraWitness: (coin.extraWitness as Uint8Array[] | undefined)?.map((w) => hex.encode(w)),
});

const deserializeCoin = (raw: AnyRecord): AnyRecord => ({
  ...raw,
  tapTree: hex.decode(raw.tapTree as string),
  forfeitTapLeafScript: deserializeTapLeaf(raw.forfeitTapLeafScript as SerializedTapLeaf),
  intentTapLeafScript: deserializeTapLeaf(raw.intentTapLeafScript as SerializedTapLeaf),
  extraWitness: (raw.extraWitness as string[] | undefined)?.map((w) => hex.decode(w)),
});

const serializeVtxo = (vtxo: AnyRecord): AnyRecord => ({
  ...serializeCoin(vtxo),
  assets: serializeAssets(vtxo.assets),
});

const deserializeVtxo = (raw: AnyRecord): ExtendedVirtualCoin =>
  normalizeStoredVtxo({
    ...deserializeCoin(raw),
    createdAt: new Date(raw.createdAt as string),
    assets: deserializeAssets(raw.assets),
  }) as unknown as ExtendedVirtualCoin;

/**
 * Wallet repository persisting to the app's AsyncStorage adapter.
 *
 * Replaces the SDK's removed `WalletRepositoryImpl` byte-for-byte in storage
 * layout, so upgrading does not strand a user's cached wallet data.
 */
export class AsyncStorageWalletRepository implements WalletRepository {
  readonly version = 1 as const;

  constructor(private readonly storage: ArkadeKeyValueStorage) {}

  async getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
    const stored = await this.storage.getItem(getVtxosStorageKey(address));
    if (!stored) return [];
    try {
      return (JSON.parse(stored) as AnyRecord[]).map(deserializeVtxo);
    } catch (error) {
      console.error(`Failed to parse VTXOs for address ${address}:`, error);
      return [];
    }
  }

  async saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void> {
    const stored = await this.getVtxos(address);
    for (const vtxo of vtxos) {
      const existing = stored.findIndex((v) => v.txid === vtxo.txid && v.vout === vtxo.vout);
      if (existing !== -1) stored[existing] = vtxo;
      else stored.push(vtxo);
    }
    await this.storage.setItem(
      getVtxosStorageKey(address),
      JSON.stringify(stored.map((v) => serializeVtxo(v as unknown as AnyRecord))),
    );
  }

  async deleteVtxos(address: string): Promise<void> {
    await this.storage.removeItem(getVtxosStorageKey(address));
  }

  async getUtxos(address: string): Promise<ExtendedCoin[]> {
    const stored = await this.storage.getItem(getUtxosStorageKey(address));
    if (!stored) return [];
    try {
      return (JSON.parse(stored) as AnyRecord[]).map(
        (raw) => deserializeCoin(raw) as unknown as ExtendedCoin,
      );
    } catch (error) {
      console.error(`Failed to parse UTXOs for address ${address}:`, error);
      return [];
    }
  }

  async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
    const stored = await this.getUtxos(address);
    for (const utxo of utxos) {
      const existing = stored.findIndex((u) => u.txid === utxo.txid && u.vout === utxo.vout);
      if (existing !== -1) stored[existing] = utxo;
      else stored.push(utxo);
    }
    await this.storage.setItem(
      getUtxosStorageKey(address),
      JSON.stringify(stored.map((u) => serializeCoin(u as unknown as AnyRecord))),
    );
  }

  async deleteUtxos(address: string): Promise<void> {
    await this.storage.removeItem(getUtxosStorageKey(address));
  }

  async getTransactionHistory(address: string): Promise<ArkTransaction[]> {
    const stored = await this.storage.getItem(getTransactionsStorageKey(address));
    if (!stored) return [];
    try {
      return JSON.parse(stored) as ArkTransaction[];
    } catch (error) {
      console.error(`Failed to parse transactions for address ${address}:`, error);
      return [];
    }
  }

  async saveTransactions(address: string, txs: ArkTransaction[]): Promise<void> {
    const stored = await this.getTransactionHistory(address);
    for (const tx of txs) {
      const existing = stored.findIndex(
        (t) =>
          t.key.boardingTxid === tx.key.boardingTxid &&
          t.key.commitmentTxid === tx.key.commitmentTxid &&
          t.key.arkTxid === tx.key.arkTxid,
      );
      if (existing !== -1) stored[existing] = tx;
      else stored.push(tx);
    }
    await this.storage.setItem(getTransactionsStorageKey(address), JSON.stringify(stored));
  }

  async deleteTransactions(address: string): Promise<void> {
    await this.storage.removeItem(getTransactionsStorageKey(address));
  }

  async getWalletState(): Promise<WalletState | null> {
    const stored = await this.storage.getItem(WALLET_STATE_STORAGE_KEY);
    if (!stored) return null;
    try {
      return JSON.parse(stored) as WalletState;
    } catch (error) {
      console.error("Failed to parse wallet state:", error);
      return null;
    }
  }

  async saveWalletState(state: WalletState): Promise<void> {
    await this.storage.setItem(WALLET_STATE_STORAGE_KEY, JSON.stringify(state));
  }

  /** Matches the removed SDK class: never implemented for the legacy KV store. */
  async clear(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return;
  }
}
