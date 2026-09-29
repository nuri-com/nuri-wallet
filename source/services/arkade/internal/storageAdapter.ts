// Storage adapters for the Arkade SDK wallet. Owns the wallet contract
// repository, swap repository, and swap task queue caches.
import AsyncStorage from "@react-native-async-storage/async-storage";
// SDK 0.5 removed `WalletRepositoryImpl`; ported locally (same storage keys).
import { AsyncStorageWalletRepository } from "./asyncStorageWalletRepository";
import { AsyncStorageTaskQueue } from "@arkade-os/sdk/worker/expo";
import type { BoltzSwap, BoltzSwapStatus, SwapRepository } from "./legacySwapTypes";
import { bytesToHex } from "../../../lib/bytes";
import { sha256 } from "../../../lib/crypto";
import {
  ARKADE_V4_STORAGE_PREFIX,
  isArkadeV4StorageKey,
  scopeArkadeV4StorageKey,
} from "../ArkadeRecoveryBackupService";
import { logArkadeWalletSignTrace } from "./logging";
import { truncateForLog } from "./utils";

type ArkadeContractFilter = {
  script?: string | string[];
  state?: string | string[];
  type?: string | string[];
};

type ArkadeStoredContract = {
  script?: string;
  state?: string;
  type?: string;
  [key: string]: unknown;
};

type ArkadeSwapFilter = {
  id?: string | string[];
  status?: BoltzSwapStatus | BoltzSwapStatus[] | string | string[];
  type?: string | string[];
  orderBy?: "createdAt";
  orderDirection?: "asc" | "desc";
};

// Frozen on purpose: this string is written into stored swap records and read
// back on load, so it keeps its historical value even though the provider it
// names is retired. Renaming it would strand data on devices.
const ARKADE_CURRENT_SWAP_STORE_VERSION = "boltz-main-api-v1";

function normalizeSwapOwnerKey(ownerKey: string): string {
  return String(ownerKey || "")
    .trim()
    .toLowerCase();
}

function swapOwnerHash(ownerKey: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(ownerKey))).slice(0, 16);
}

function currentSwapCollectionKey(ownerKey: string): string {
  return `collection:swaps:${ARKADE_CURRENT_SWAP_STORE_VERSION}:${ownerKey}`;
}

function legacySwapCollectionKeys(ownerKey: string): string[] {
  return [
    "collection:swaps",
    "collection:reverseSwaps",
    "collection:submarineSwaps",
    `collection:swaps:${ownerKey}`,
  ];
}

function legacySwapTaskQueueKeys(ownerKey: string): string[] {
  const ownerHash = swapOwnerHash(ownerKey);
  const legacyPrefix = `${ARKADE_V4_STORAGE_PREFIX}swap-task:${ownerHash}`;
  return [`${legacyPrefix}:inbox`, `${legacyPrefix}:outbox`];
}

async function removeExistingAsyncStorageKeys(
  keys: string[],
  archivePrefix?: string,
): Promise<number> {
  const uniqueKeys = Array.from(new Set(keys.map(String).filter(Boolean)));
  if (uniqueKeys.length === 0) return 0;
  const pairs = await AsyncStorage.multiGet(uniqueKeys);
  const existing = pairs.filter(([, value]) => value !== null);
  if (existing.length === 0) return 0;
  if (archivePrefix) {
    // Legacy swap rows can hold the only local handle to an unsettled swap
    // from a previous app version (refund/settle evidence). Park them under
    // an archive key instead of destroying them.
    await AsyncStorage.multiSet(
      existing.map(([key, value]) => [`${archivePrefix}${key}`, value as string]),
    );
  }
  await AsyncStorage.multiRemove(existing.map(([key]) => key));
  return existing.length;
}

class ArkadeV4StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(scopeArkadeV4StorageKey(key));
  }

  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(scopeArkadeV4StorageKey(key), value);
  }

  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(scopeArkadeV4StorageKey(key));
  }

  async clear(): Promise<void> {
    const keys = (await AsyncStorage.getAllKeys()).map(String).filter(isArkadeV4StorageKey);
    if (keys.length > 0) {
      await AsyncStorage.multiRemove(keys);
    }
  }
}

class ArkadeV4ContractRepository {
  readonly version = 1 as const;

  private readonly storage = new ArkadeV4StorageAdapter();

  private readonly key = "collection:contracts";

  private writeQueue: Promise<void> = Promise.resolve();

  private async readAllContracts(): Promise<ArkadeStoredContract[]> {
    const raw = await this.storage.getItem(this.key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ArkadeStoredContract[]) : [];
    } catch {
      return [];
    }
  }

  private async writeAllContracts(contracts: ArkadeStoredContract[]): Promise<void> {
    await this.storage.setItem(this.key, JSON.stringify(contracts));
  }

  private matchesFilter(contract: ArkadeStoredContract, filter?: ArkadeContractFilter): boolean {
    if (!filter) return true;
    const matches = (value: unknown, expected?: string | string[]) => {
      if (expected === undefined) return true;
      const current = String(value || "");
      return Array.isArray(expected)
        ? expected.map(String).includes(current)
        : String(expected) === current;
    };
    return (
      matches(contract?.script, filter.script) &&
      matches(contract?.state, filter.state) &&
      matches(contract?.type, filter.type)
    );
  }

  async getContracts(filter?: ArkadeContractFilter): Promise<ArkadeStoredContract[]> {
    const contracts = await this.readAllContracts();
    return contracts.filter((contract) => this.matchesFilter(contract, filter));
  }

  async saveContract(contract: ArkadeStoredContract): Promise<void> {
    const script = String(contract?.script || "").trim();
    if (!script) {
      throw new Error("contract script required");
    }
    const promise = this.writeQueue.then(async () => {
      const contracts = await this.readAllContracts();
      const next = contracts.filter((item) => String(item?.script || "") !== script);
      next.push(contract);
      await this.writeAllContracts(next);
    });
    this.writeQueue = promise.catch((error) => {
      console.error("[ArkadeV4ContractRepository] Failed to save contract:", error);
    });
    return promise;
  }

  async deleteContract(script: string): Promise<void> {
    const target = String(script || "").trim();
    const promise = this.writeQueue.then(async () => {
      const contracts = await this.readAllContracts();
      await this.writeAllContracts(
        contracts.filter((item) => String(item?.script || "") !== target),
      );
    });
    this.writeQueue = promise.catch((error) => {
      console.error("[ArkadeV4ContractRepository] Failed to delete contract:", error);
    });
    return promise;
  }

  async deleteContracts(targetScripts: string[]): Promise<number> {
    const targetSet = new Set(
      targetScripts.map((script) => String(script || "").trim()).filter(Boolean),
    );
    if (targetSet.size === 0) return 0;
    let result = 0;
    const promise = this.writeQueue.then(async () => {
      const contracts = await this.readAllContracts();
      const before = contracts.length;
      const next = contracts.filter((item) => !targetSet.has(String(item?.script || "")));
      await this.writeAllContracts(next);
      result = before - next.length;
    });
    this.writeQueue = promise.catch((error) => {
      console.error("[ArkadeV4ContractRepository] Failed to delete contracts:", error);
    });
    await promise;
    return result;
  }

  async clear(): Promise<void> {
    await this.storage.removeItem(this.key);
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

class ArkadeV4SwapRepository implements SwapRepository {
  readonly version = 1 as const;

  private readonly storage = new ArkadeV4StorageAdapter();

  private readonly key: string;

  private writeQueue: Promise<void> = Promise.resolve();

  constructor(ownerKey: string) {
    const normalizedOwner = normalizeSwapOwnerKey(ownerKey);
    if (!normalizedOwner) {
      throw new Error("arkade swap repository owner required");
    }
    this.key = currentSwapCollectionKey(normalizedOwner);
  }

  private async readAllSwaps<T extends BoltzSwap>(): Promise<T[]> {
    const raw = await this.storage.getItem(this.key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  private async writeAllSwaps(swaps: BoltzSwap[]): Promise<void> {
    await this.storage.setItem(this.key, JSON.stringify(swaps));
  }

  async saveSwap<T extends BoltzSwap>(swap: T): Promise<void> {
    const promise = this.writeQueue.then(async () => {
      const swaps = await this.readAllSwaps<BoltzSwap>();
      const next = swaps.filter(
        (item) => String((item as BoltzSwap).id || "") !== String((swap as BoltzSwap).id || ""),
      );
      next.push(swap);
      await this.writeAllSwaps(next);
    });
    this.writeQueue = promise.catch((error) => {
      console.error("[ArkadeV4SwapRepository] Failed to save swap:", error);
    });
    return promise;
  }

  async deleteSwap(id: string): Promise<void> {
    const promise = this.writeQueue.then(async () => {
      const swaps = await this.readAllSwaps<BoltzSwap>();
      await this.writeAllSwaps(
        swaps.filter((swap) => String((swap as BoltzSwap).id || "") !== String(id)),
      );
    });
    this.writeQueue = promise.catch((error) => {
      console.error("[ArkadeV4SwapRepository] Failed to delete swap:", error);
    });
    return promise;
  }

  async getAllSwaps<T extends BoltzSwap>(filter?: ArkadeSwapFilter): Promise<T[]> {
    let swaps = await this.readAllSwaps<T>();
    if (filter?.id) {
      const ids = new Set(Array.isArray(filter.id) ? filter.id.map(String) : [String(filter.id)]);
      swaps = swaps.filter((swap) => ids.has(String((swap as BoltzSwap).id || "")));
    }
    if (filter?.status) {
      const statuses = new Set(
        Array.isArray(filter.status) ? filter.status.map(String) : [String(filter.status)],
      );
      swaps = swaps.filter((swap) => statuses.has(String((swap as BoltzSwap).status || "")));
    }
    if (filter?.type) {
      const types = new Set(
        Array.isArray(filter.type) ? filter.type.map(String) : [String(filter.type)],
      );
      swaps = swaps.filter((swap) => types.has(String((swap as BoltzSwap).type || "")));
    }
    if (filter?.orderBy === "createdAt") {
      const direction = filter.orderDirection === "asc" ? 1 : -1;
      swaps = swaps
        .slice()
        .sort(
          (a, b) =>
            (Number((a as BoltzSwap).createdAt || 0) - Number((b as BoltzSwap).createdAt || 0)) *
            direction,
        );
    }
    return swaps;
  }

  async clear(): Promise<void> {
    await this.storage.removeItem(this.key);
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

export type ArkadeStorageAdapterBundle = {
  walletRepository: AsyncStorageWalletRepository;
  contractRepository: ArkadeV4ContractRepository;
};

let cachedStorage: ArkadeStorageAdapterBundle | null = null;
let cachedSwapRepository: SwapRepository | null = null;
let cachedSwapRepositoryOwnerKey: string | null = null;
let cachedSwapTaskQueue: AsyncStorageTaskQueue | null = null;
let cachedSwapTaskQueueOwnerKey: string | null = null;

export function getArkadeStorageAdapter(): ArkadeStorageAdapterBundle {
  if (cachedStorage) return cachedStorage;
  const adapter = new ArkadeV4StorageAdapter();
  cachedStorage = {
    walletRepository: new AsyncStorageWalletRepository(adapter),
    contractRepository: new ArkadeV4ContractRepository(),
  };
  logArkadeWalletSignTrace("storage_adapter_ready", {
    namespace: ARKADE_V4_STORAGE_PREFIX,
    storage_kind: "async_repository_contracts_v2",
    expected_next: "vtxo_manager_uses_nuri_contract_repository",
  });
  return cachedStorage;
}

export function getArkadeSwapRepository(ownerKey: string): SwapRepository {
  const normalizedOwner = normalizeSwapOwnerKey(ownerKey);
  if (cachedSwapRepository && cachedSwapRepositoryOwnerKey === normalizedOwner) {
    return cachedSwapRepository;
  }
  cachedSwapRepository = new ArkadeV4SwapRepository(normalizedOwner);
  cachedSwapRepositoryOwnerKey = normalizedOwner;
  logArkadeWalletSignTrace("swap_repository_ready", {
    namespace: ARKADE_V4_STORAGE_PREFIX,
    owner: truncateForLog(normalizedOwner, 18),
    store_version: ARKADE_CURRENT_SWAP_STORE_VERSION,
    storage_kind: "async_swap_repository",
    expected_next: "fresh_boltz_main_api_swap_store",
  });
  return cachedSwapRepository;
}

export function getArkadeSwapTaskQueue(ownerKey: string): AsyncStorageTaskQueue {
  const normalizedOwner = normalizeSwapOwnerKey(ownerKey);
  if (cachedSwapTaskQueue && cachedSwapTaskQueueOwnerKey === normalizedOwner) {
    return cachedSwapTaskQueue;
  }
  const ownerHash = swapOwnerHash(normalizedOwner);
  cachedSwapTaskQueue = new AsyncStorageTaskQueue(
    AsyncStorage,
    `${ARKADE_V4_STORAGE_PREFIX}swap-task:${ARKADE_CURRENT_SWAP_STORE_VERSION}:${ownerHash}`,
  );
  cachedSwapTaskQueueOwnerKey = normalizedOwner;
  logArkadeWalletSignTrace("swap_task_queue_ready", {
    namespace: ARKADE_V4_STORAGE_PREFIX,
    owner_hash: ownerHash,
    store_version: ARKADE_CURRENT_SWAP_STORE_VERSION,
    storage_kind: "async_swap_task_queue",
    expected_next: "expo_boltz_swap_manager",
  });
  return cachedSwapTaskQueue;
}

export function getArkadeSwapRepositoryOwnerKey(): string | null {
  return cachedSwapRepositoryOwnerKey;
}

const LEGACY_SWAP_ARCHIVE_PREFIX = `${ARKADE_V4_STORAGE_PREFIX}legacy-swap-archive:`;

// Union of the SDK's submarine/reverse/chain final statuses. Anything outside
// this set is a swap the SwapManager would still monitor or act on.
const FINAL_PERSISTED_SWAP_STATUSES = new Set([
  "invoice.failedToPay",
  "transaction.claimed",
  "invoice.settled",
  "invoice.expired",
  "transaction.failed",
  "transaction.refunded",
  "swap.expired",
]);

/**
 * Owner-agnostic check whether any persisted swap collection contains a swap
 * the SDK SwapManager would still monitor (non-final status). Used to decide
 * if lightning should be initialized eagerly after an app restart.
 */
export async function hasPersistedNonFinalArkadeSwaps(): Promise<boolean> {
  const collectionPrefix = scopeArkadeV4StorageKey(
    `collection:swaps:${ARKADE_CURRENT_SWAP_STORE_VERSION}:`,
  );
  const keys = (await AsyncStorage.getAllKeys())
    .map(String)
    .filter((key) => key.startsWith(collectionPrefix));
  if (keys.length === 0) return false;
  const pairs = await AsyncStorage.multiGet(keys);
  for (const [, value] of pairs) {
    if (!value) continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) continue;
      for (const swap of parsed) {
        const status = String((swap as { status?: unknown })?.status || "");
        if (!FINAL_PERSISTED_SWAP_STATUSES.has(status)) return true;
      }
    } catch {}
  }
  return false;
}

export async function deleteLegacyArkadeSwapRuntimeState(ownerKey: string): Promise<number> {
  const normalizedOwner = normalizeSwapOwnerKey(ownerKey);
  if (!normalizedOwner) return 0;
  const legacySwapKeys = legacySwapCollectionKeys(normalizedOwner).map(scopeArkadeV4StorageKey);
  const legacyTaskQueueKeys = legacySwapTaskQueueKeys(normalizedOwner);
  // Swap collections are archived (they may hold the only refund handle for
  // an in-flight swap from a prior version); task queues are transient and
  // are removed outright.
  const archived = await removeExistingAsyncStorageKeys(legacySwapKeys, LEGACY_SWAP_ARCHIVE_PREFIX);
  const removed = await removeExistingAsyncStorageKeys(legacyTaskQueueKeys);
  logArkadeWalletSignTrace("legacy_swap_runtime_deleted", {
    namespace: ARKADE_V4_STORAGE_PREFIX,
    owner: truncateForLog(normalizedOwner, 18),
    archived,
    removed,
    store_version: ARKADE_CURRENT_SWAP_STORE_VERSION,
    expected_next: "only_current_boltz_main_api_swap_store_remains",
  });
  return archived + removed;
}

export function resetArkadeStorageAdapterCache(): void {
  cachedStorage = null;
  cachedSwapRepository = null;
  cachedSwapRepositoryOwnerKey = null;
  cachedSwapTaskQueue = null;
  cachedSwapTaskQueueOwnerKey = null;
}
