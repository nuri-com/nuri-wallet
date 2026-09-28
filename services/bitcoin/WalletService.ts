// services/bitcoin/WalletService.ts
import * as btc from "@scure/btc-signer";
import { hexToBytes } from "../../lib/bytes";
import type { BitcoinSendPsbtSource } from "../../lib/bitcoin/buildBitcoinSendPsbt";
import {
  deriveMusig2CsvAddress,
  type Musig2CsvAddress,
} from "../../lib/bitcoin/deriveMusig2CsvAddress";
import { newOp, LOG_EMOJI } from "../../lib/OperationLogUtils";
import { errMsg } from "../../lib/errorMessage";
import {
  getMusig2AddressCache,
  storeBitcoinAddress,
  storeMusig2AddressCache,
  getArkadeBoardingAddressCache,
  storeArkadeBoardingAddressCache,
} from "../../lib/secureKeyStorage";
import { isSendSourceBoundToCredential } from "../../lib/bitcoin/sendSourceBinding";
import { isSameWalletIdentity, type WalletIdentity } from "../../lib/bitcoin/walletIdentity";
import { getArkadeWalletSummary } from "../arkade/ArkadeWalletService";
import { authStateManager } from "../auth/AuthStateService";
import { currentWalletCredId } from "../auth/walletCredential";

/**
 * The configured/stored network name (`BITCOIN_NETWORK`, `StoredWallet.network`)
 * mapped to the id the address derivation speaks. One mapping, so a derivation
 * done outside this service (the v4 address resolved in `Musig2WalletKeys`) can
 * never end up on a different network than the one done inside it.
 */
/**
 * Raised when a MuSig2 descriptor is about to be installed for an identity that is no longer loaded
 * (the keys were resolved before an in-app login replaced it). Nothing is mutated: the run is stale
 * and its result must be dropped, never presented as the current account's wallet.
 */
export class StaleWalletIdentityError extends Error {
  constructor() {
    super("MuSig2 wallet identity changed while the wallet was loading.");
    this.name = "StaleWalletIdentityError";
  }
}

export function toDerivationNetwork(network: string): "main" | "testnet" | "regtest" {
  if (network === "testnet") return "testnet";
  if (network === "regtest") return "regtest";
  return "main";
}

/**
 * The same credential, but only once the persisted auth state has loaded.
 * AuthStateService reads storage asynchronously from its own constructor, so a
 * caller that runs at module load (the cache seeds below) would otherwise ask
 * while `walletPublicKeys` is still null, miss the scoped cache every time and
 * leave a returning user without an address until live hydration finishes.
 */
async function loadedWalletCredId(): Promise<string | null> {
  try {
    await authStateManager.initialize();
  } catch {}
  return currentWalletCredId();
}

/**
 * Address state owned by WalletService and exposed via subscription so it can
 * be driven headless (no mounted Bitcoin tab) and consumed through
 * `useSyncExternalStore`. Both wallets are live at once: `currentAddress` is
 * the arkade boarding address, `musig2Address` the MuSig2+CSV on-chain receive
 * address. Neither supersedes the other.
 */
export type BitcoinAddressState = {
  currentAddress: string;
  /** The v4 (arkade co-signer) MuSig2+CSV address — receive and send use this. */
  musig2Address: string;
  uiSetupCompleted: boolean;
  isGeneratingAddress: boolean;
  /**
   * Why the last arkade address generation failed, empty when it did not. The
   * receive sheet needs this to offer a retry: a fresh login has no cached
   * address to fall back on, so a swallowed failure leaves the user staring at
   * "no address yet" with nothing to tap.
   */
  addressError: string;
};

interface WalletDescriptor {
  external: string;
  internal: string;
}

interface StoredWallet {
  descriptors: WalletDescriptor;
  network: "mainnet" | "testnet" | "regtest";
  addressIndex: { external: number; internal: number };
  aggregatedKeys: {
    external: string; // x-only hex
    internal: string; // x-only hex
  };
  userKeys: {
    external: string; // compressed hex for CSV recovery
    internal: string; // compressed hex for CSV recovery
  };
  /** BIP68 sequence of the recovery leaf — a raw block count, or seconds with the type flag. */
  csvSequence: number;
}

class WalletService {
  // MuSig2 + CSV on-chain wallet state. Lives alongside the arkade address
  // state below: both wallets are active at once, so this is never a mode switch.
  private wallet: StoredWallet | null = null;
  // The credential `wallet` was derived for. Account replacement keeps the descriptor installed until
  // hydration rebuilds it, so the credential has to be remembered next to it: a value that cannot be
  // tied to the loaded credential is never exposed as a send source (see isSendSourceBoundToCredential).
  private walletCredId: string | null = null;
  // Bumped whenever the address state is reset for a new identity. A descriptor install carries the
  // epoch it started under and lands only while this still matches (see WalletIdentity).
  private identityEpoch = 0;
  // ---- Address state (subscription surface) ----
  private addressState: BitcoinAddressState = {
    currentAddress: "",
    musig2Address: "",
    uiSetupCompleted: false,
    isGeneratingAddress: false,
    addressError: "",
  };
  private addressListeners = new Set<(state: BitcoinAddressState) => void>();
  private lastCachedAddress: string | null = null;
  // Bumped on every resetAddressState() so an in-flight generateNewAddress()
  // started under a prior identity can't republish the previous session's
  // address after a re-login reset.
  private addressGeneration = 0;
  // The running boarding-address load, so a second caller joins it rather than
  // being turned away with nothing to await — but only a caller of the SAME
  // identity. A load started before a re-login answers `null` at its own
  // generation check, so joining it from the new identity would end that
  // identity's bootstrap without ever asking for its address.
  private addressLoadInFlight: Promise<string | null | undefined> | null = null;
  private addressLoadGeneration = -1;
  // Consecutive failed boarding-address loads, reset by the next success. The
  // count rides along in the failure log line so a support dump distinguishes
  // "one transient miss" from "this device has never managed to load one" —
  // the state a user experiences as a permanently empty receive sheet.
  private addressFailureStreak = 0;

  constructor() {
    // Seed boarding address from the dedicated arkade cache so the receive
    // modal can show the last known address before generateNewAddress resolves.
    void this.seedBoardingAddressFromCache();
    void this.seedMusig2AddressFromCache();
  }

  /** Stable-reference snapshot for `useSyncExternalStore`. */
  getAddressSnapshot(): BitcoinAddressState {
    return this.addressState;
  }

  subscribeAddress(listener: (state: BitcoinAddressState) => void): () => void {
    this.addressListeners.add(listener);
    return () => {
      this.addressListeners.delete(listener);
    };
  }

  private notifyAddress(patch: Partial<BitcoinAddressState>): void {
    this.addressState = { ...this.addressState, ...patch };
    this.addressListeners.forEach((listener) => listener(this.addressState));
  }

  /**
   * Set the receive address and persist it to secure storage (lowercased,
   * de-duplicated). No-op when unchanged so subscribers don't re-render.
   */
  setCurrentAddress(address: string): void {
    const addr = String(address || "");
    if (this.addressState.currentAddress === addr) return;
    this.notifyAddress({ currentAddress: addr });
    const normalized = addr.trim().toLowerCase();
    if (!normalized || this.lastCachedAddress === normalized) return;
    this.lastCachedAddress = normalized;
    void (async () => {
      try {
        await storeBitcoinAddress(normalized);
      } catch {}
    })();
  }

  /**
   * Set the MuSig2+CSV on-chain receive address (not persisted as *the* address,
   * but cached in its own slot). Deriving it needs the loaded wallet, so without
   * the cache the home could not tell "this identity has an on-chain wallet"
   * until that finished — the rail, and its share of the total, appeared seconds
   * after the rest of the screen.
   */
  /**
   * The identity epoch the address state belongs to. A caller that awaits
   * before publishing an address captures this first and hands it back to
   * `setMusig2Address`, so a load started under the previous identity cannot
   * write into the state a re-login has already reset.
   */
  getAddressGeneration(): number {
    return this.addressGeneration;
  }

  setMusig2Address(address: string, expectedGeneration?: number): void {
    if (expectedGeneration !== undefined && expectedGeneration !== this.addressGeneration) return;
    const addr = String(address || "");
    if (this.addressState.musig2Address === addr) return;
    this.notifyAddress({ musig2Address: addr });
    const normalized = addr.trim().toLowerCase();
    if (!normalized) return;
    void storeMusig2AddressCache(normalized, currentWalletCredId()).catch(() => {});
  }

  /**
   * Derive and publish the MuSig2 on-chain receive address. Independent of
   * `generateNewAddress`, which owns the arkade boarding address — the Bitcoin
   * tab needs both at once. No-op (returns null) until the on-chain wallet is
   * initialized, so arkade-only identities are unaffected.
   */
  async generateMusig2Address(): Promise<string | null> {
    if (!this.wallet) return null;
    try {
      const generation = this.addressGeneration;
      const address = await this.getNewAddress(false);
      this.setMusig2Address(address, generation);
      return address;
    } catch (error: unknown) {
      console.warn("[WalletService:generateMusig2Address] failed:", errMsg(error));
      return null;
    }
  }

  setUiSetupCompleted(value: boolean): void {
    if (this.addressState.uiSetupCompleted === value) return;
    this.notifyAddress({ uiSetupCompleted: value });
  }

  private setGeneratingAddress(value: boolean): void {
    if (this.addressState.isGeneratingAddress === value) return;
    this.notifyAddress({ isGeneratingAddress: value });
  }

  /**
   * Reset the address state back to its initial empty values and notify
   * subscribers. Used on in-app passkey re-login (same JS process) so the new
   * user never sees the previous user's receive address.
   */
  resetAddressState(): void {
    // The descriptor outlives the identity it was derived for (only hydration replaces it), so it is
    // unbound here, and the epoch moves so a hydrate that started under the previous identity cannot
    // install its descriptors afterwards. A send source is refused until the loaded credential derives
    // its own.
    this.walletCredId = null;
    this.identityEpoch += 1;
    this.addressGeneration += 1;
    this.lastCachedAddress = null;
    // The running load belongs to the identity being replaced; it will discard
    // its own result. Dropping the reference here lets the next caller start a
    // load for the new identity instead of awaiting that discarded one.
    this.addressLoadInFlight = null;
    this.addressLoadGeneration = -1;
    // The streak counts one identity's consecutive failures. Carrying it into
    // the next login would report the new user's first failure as fails=N.
    this.addressFailureStreak = 0;
    this.notifyAddress({
      currentAddress: "",
      musig2Address: "",
      uiSetupCompleted: false,
      isGeneratingAddress: false,
      addressError: "",
    });
  }

  // Never use deriveBoardingAddressOffline here — cached params can go stale
  // and produce the wrong address (funds sent there are lost).
  private async seedBoardingAddressFromCache(): Promise<void> {
    try {
      const generation = this.addressGeneration;
      if (this.addressState.currentAddress) return;
      const cached = await getArkadeBoardingAddressCache(await loadedWalletCredId());
      if (generation !== this.addressGeneration) return;
      if (!cached) return;
      if (this.addressState.currentAddress) return;
      this.setCurrentAddress(cached);
    } catch {}
  }

  // The v4 MuSig2 address is the only on-chain address there is, and it has its
  // own cache slot: seeding from it lets the receive sheet paint before the
  // arkade signing context has resolved.
  private async seedMusig2AddressFromCache(): Promise<void> {
    try {
      const generation = this.addressGeneration;
      if (this.addressState.musig2Address) return;
      const cached = await getMusig2AddressCache(await loadedWalletCredId());
      if (generation !== this.addressGeneration) return;
      if (!cached || this.addressState.musig2Address) return;
      this.notifyAddress({ musig2Address: cached });
    } catch {}
  }

  /**
   * Generate / refresh the arkade receive (boarding) address from the live
   * wallet summary, falling back to the cached boarding address.
   *
   * Single-flight: a call made while one is running JOINS it instead of
   * returning nothing. A caller that arrived during the startup hydration used
   * to get an immediate `undefined` and never learned that the load it was
   * waiting on had failed, so an empty receive sheet stayed empty.
   */
  async generateNewAddress(): Promise<string | null | undefined> {
    if (this.addressLoadInFlight && this.addressLoadGeneration === this.addressGeneration) {
      return this.addressLoadInFlight;
    }
    const generation = this.addressGeneration;
    const load = this.runAddressLoad(generation);
    this.addressLoadInFlight = load;
    this.addressLoadGeneration = generation;
    try {
      return await load;
    } finally {
      if (this.addressLoadInFlight === load) {
        this.addressLoadInFlight = null;
        this.addressLoadGeneration = -1;
      }
    }
  }

  private async runAddressLoad(generation: number): Promise<string | null | undefined> {
    console.log("[WalletService:generateNewAddress] Generating new address...");
    this.setGeneratingAddress(true);
    this.setAddressError("");

    try {
      try {
        const summary = await getArkadeWalletSummary();
        const address = summary.boardingAddress;
        console.log("[WalletService:generateNewAddress] Arkade boarding address (live):", address);
        if (generation !== this.addressGeneration) return null;
        this.addressFailureStreak = 0;
        this.setCurrentAddress(address);
        try {
          await storeArkadeBoardingAddressCache(address, currentWalletCredId());
        } catch {}
        return address;
      } catch (summaryError) {
        console.warn(
          "[WalletService:generateNewAddress] Arkade summary failed, trying cache:",
          summaryError,
        );
        const cached = await getArkadeBoardingAddressCache(currentWalletCredId());
        if (cached) {
          console.log(
            "[WalletService:generateNewAddress] Arkade boarding address (cache fallback):",
            cached,
          );
          if (generation !== this.addressGeneration) return null;
          // A cache hit ends the call with an address published, so the streak
          // it would otherwise carry forward describes no user-visible failure.
          this.addressFailureStreak = 0;
          this.setCurrentAddress(cached);
          return cached;
        }
        throw summaryError;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.addressFailureStreak += 1;
      // One canonical line carrying the streak and the root cause. The streak
      // makes each line distinct, so the log buffer's repeat suppression can't
      // collapse a device that keeps failing into a single early entry.
      console.error(
        `[WalletService:generateNewAddress] Failed to generate address: fails=${this.addressFailureStreak} cached=${this.lastCachedAddress ? 1 : 0} err=${msg}`,
      );
      // Published, not just logged: without it the receive sheet cannot tell a
      // wallet that has no address yet from one whose generation failed, so it
      // renders "no address yet" and offers no way to try again.
      if (generation === this.addressGeneration) {
        this.setAddressError(msg || "address_generation_failed");
      }
      return undefined;
    } finally {
      this.setGeneratingAddress(false);
    }
  }

  private setAddressError(message: string): void {
    const next = String(message || "");
    if (this.addressState.addressError === next) return;
    this.notifyAddress({ addressError: next });
  }

  /**
   * Check if wallet is available
   */
  /**
   * Creates a new wallet with MuSig2 key-path and CSV script-path recovery
   */
  async createWallet(
    externalDesc: string,
    internalDesc: string,
    network: string,
    aggregatedExternal: string,
    aggregatedInternal: string,
    csvSequence: number,
    userExternalKey?: string,
    userInternalKey?: string,
    identity?: WalletIdentity,
  ): Promise<void> {
    const op = newOp("WalletService", "createWallet", LOG_EMOJI.bitcoin);
    op.log(
      `Network=${network} csvSequence=${csvSequence} extDescLen=${externalDesc.length} intDescLen=${internalDesc.length}`,
    );

    try {
      // Validate inputs
      if (!externalDesc || !internalDesc) {
        throw new Error("Missing descriptors");
      }

      if (!aggregatedExternal || aggregatedExternal.length !== 64) {
        throw new Error(
          `Invalid aggregated external key: ${aggregatedExternal?.length || 0} chars (expected 64)`,
        );
      }

      if (!aggregatedInternal || aggregatedInternal.length !== 64) {
        throw new Error(
          `Invalid aggregated internal key: ${aggregatedInternal?.length || 0} chars (expected 64)`,
        );
      }

      // Install-and-bind only for the identity the keys were resolved under. Resolving them is async,
      // so an in-app login can replace the identity in that window: without this, the previous
      // account's descriptor lands in the singleton and is stamped as the new account's, and a send
      // source derived from it looks legitimate. Nothing is touched on a mismatch.
      if (identity && !isSameWalletIdentity(identity, this.currentIdentity())) {
        throw new StaleWalletIdentityError();
      }

      // Store wallet configuration
      this.wallet = {
        descriptors: {
          external: externalDesc,
          internal: internalDesc,
        },
        network: network as "mainnet" | "testnet" | "regtest",
        addressIndex: { external: 0, internal: 0 },
        aggregatedKeys: {
          external: aggregatedExternal,
          internal: aggregatedInternal,
        },
        userKeys: {
          external: userExternalKey || "",
          internal: userInternalKey || "",
        },
        csvSequence,
      };
      // Bind the descriptor to the credential whose keys it was derived from, so it can only ever be
      // used as a send source while that same credential is loaded.
      this.walletCredId = identity ? identity.credId : currentWalletCredId();

      op.log("Wallet stored in memory; address indices initialized");
      op.end("Finished");
    } catch (error: unknown) {
      op.error("Failed to create wallet", errMsg(error));
      throw error;
    }
  }

  /**
   * The loaded (v4) wallet's CSV derivation, or null when it has no recovery
   * leaf configured. The address the user is paid on and the source a spend is
   * built from both read this one call, so they cannot drift apart.
   */
  private deriveCurrentMusig2(): Musig2CsvAddress | null {
    const wallet = this.wallet;
    if (!wallet) return null;
    const aggregatedXonly32 = wallet.aggregatedKeys.external;
    const userCompressed = wallet.userKeys.external;
    if (!aggregatedXonly32 || !userCompressed || wallet.csvSequence <= 0) return null;
    return deriveMusig2CsvAddress({
      aggregatedXonly32,
      userCompressed,
      csvSequence: wallet.csvSequence,
      network: toDerivationNetwork(wallet.network),
    });
  }

  /**
   * The v4 wallet's PSBT funding source: the address a spend leaves from plus
   * the taproot key material a key-path spend has to tweak with. Null rather
   * than a throw when the wallet is not loaded — a caller that cannot send yet
   * is a normal state, not a failure.
   */
  /** The identity the wallet state belongs to right now. */
  private currentIdentity(): WalletIdentity {
    return { credId: currentWalletCredId(), epoch: this.identityEpoch };
  }

  /** Identity epoch, for callers that capture an identity before doing async work. */
  getIdentityEpoch(): number {
    return this.identityEpoch;
  }

  /**
   * The credential the installed MuSig2 descriptor was derived for, or null when it is unbound
   * (account replaced, or hydration has not installed one). Consumers that expose a send address to a
   * route must refuse an unbound descriptor rather than derive from the previous account's keys.
   */
  getMusig2DescriptorCredId(): string | null {
    return this.walletCredId;
  }

  getMusig2SendSource(): BitcoinSendPsbtSource | null {
    try {
      // Never hand out the previous account's address: a descriptor that is not bound to the loaded
      // credential is unusable, whatever it derives to.
      if (!isSendSourceBoundToCredential(this.walletCredId, currentWalletCredId())) return null;
      const derived = this.deriveCurrentMusig2();
      if (!derived) return null;
      return {
        address: derived.address,
        tapInternalKey: derived.tapInternalKey,
        tapMerkleRoot: derived.tapMerkleRoot,
      };
    } catch (error: unknown) {
      console.warn("[WalletService:getMusig2SendSource] failed:", errMsg(error));
      return null;
    }
  }

  /**
   * Get a new address
   * Derives P2TR address from the aggregated MuSig2 key with CSV script tree
   */
  async getNewAddress(increment = true): Promise<string> {
    const op = newOp("WalletService", "getNewAddress", LOG_EMOJI.bitcoin);
    op.log("Generating new address");

    if (!this.wallet) {
      const error = "Wallet not initialized - call createWallet first";
      console.error("[WalletService:getNewAddress] ❌", error);
      throw new Error(error);
    }

    try {
      const aggregatedKey = this.wallet.aggregatedKeys.external;
      const userKey = this.wallet.userKeys.external;
      const csvSequence = this.wallet.csvSequence;
      op.log(
        `index=${this.wallet.addressIndex.external} aggregated=${aggregatedKey.slice(0, 16)}... user=${userKey ? `${userKey.slice(0, 16)}...` : "not set"} csvSequence=${csvSequence}`,
      );

      let address: string;
      const derived = this.deriveCurrentMusig2();
      if (derived) {
        address = derived.address;
      } else {
        // No recovery leaf configured: key-path only, no script tree.
        op.log("Creating P2TR key-path only (no CSV)");
        const p2tr = btc.p2tr(hexToBytes(aggregatedKey));
        if (!p2tr.address) throw new Error("Failed to derive P2TR address");
        address = p2tr.address;
      }

      // Determine network prefix
      let expectedPrefix = "bc1p"; // mainnet taproot
      if (this.wallet.network === "testnet") {
        expectedPrefix = "tb1p";
      } else if (this.wallet.network === "regtest") {
        expectedPrefix = "bcrt1p";
      }

      op.log(`Expected prefix: ${expectedPrefix}`);
      op.log(`Generated address: ${address}`);

      // Validate address format
      if (!address.startsWith(expectedPrefix.slice(0, -1))) {
        op.error("Address prefix mismatch", {
          expected: expectedPrefix.slice(0, -1),
          actual: address,
        });
      }

      // Increment address index if requested
      if (increment) {
        this.wallet.addressIndex.external++;
        op.log(`Incremented index to: ${this.wallet.addressIndex.external}`);
      }

      op.log("Address generated successfully");
      op.end("Finished");
      return address;
    } catch (error: unknown) {
      op.error("Failed to generate address", errMsg(error));
      throw error;
    }
  }

  /**
   * Get the current wallet's first address (for display)
   */
  async getCurrentAddress(): Promise<string> {
    const op = newOp("WalletService", "getCurrentAddress", LOG_EMOJI.bitcoin);
    op.log("Getting current address (index 0)");

    try {
      // Get address without incrementing index
      const address = await this.getNewAddress(false);
      op.log(`Current address: ${address}`);
      op.end("Finished");
      return address;
    } catch (error: unknown) {
      op.error("Failed", errMsg(error));
      throw error;
    }
  }

  /**
   * Check if wallet is available
   */
  isAvailable(): boolean {
    const op = newOp("WalletService", "isAvailable", LOG_EMOJI.bitcoin);
    const available = true;
    op.log(`Service available: ${available}`);
    op.end("Finished");
    return available;
  }
  getDescriptors(): WalletDescriptor | null {
    const op = newOp("WalletService", "getDescriptors", LOG_EMOJI.bitcoin);
    op.log("Retrieving descriptors");

    if (!this.wallet) {
      op.log("No wallet initialized");
      return null;
    }

    op.log("Returning descriptors");
    op.end("Finished");
    return this.wallet.descriptors;
  }

  /**
   * Get current network
   */
  getNetwork(): string {
    const network = this.wallet?.network || "mainnet";
    console.log("[WalletService:getNetwork] Current network:", network);
    return network;
  }

  /**
   * Get wallet info for debugging
   */
  getWalletInfo(): any {
    console.log("[WalletService:getWalletInfo] === Wallet Info ===");

    if (!this.wallet) {
      console.log("[WalletService:getWalletInfo] No wallet initialized");
      return null;
    }

    const info = {
      network: this.wallet.network,
      csvSequence: this.wallet.csvSequence,
      addressIndices: this.wallet.addressIndex,
      hasExternalDesc: !!this.wallet.descriptors.external,
      hasInternalDesc: !!this.wallet.descriptors.internal,
      aggregatedExternalKey: `${this.wallet.aggregatedKeys.external.slice(0, 16)}...`,
      aggregatedInternalKey: `${this.wallet.aggregatedKeys.internal.slice(0, 16)}...`,
      userKeys: this.wallet.userKeys, // Include userKeys for CSV scripts
    };

    console.log("[WalletService:getWalletInfo] Info:", JSON.stringify(info, null, 2));
    return info;
  }

  /**
   * Load wallet from stored descriptors (for app restart)
   */
  async loadWallet(
    descriptors: WalletDescriptor,
    network: string,
    aggregatedKeys: { external: string; internal: string },
    csvSequence: number,
  ): Promise<void> {
    console.log("[WalletService:loadWallet] === Loading wallet from stored data ===");
    console.log("[WalletService:loadWallet] Network:", network);
    console.log("[WalletService:loadWallet] CSV sequence:", csvSequence);

    try {
      await this.createWallet(
        descriptors.external,
        descriptors.internal,
        network,
        aggregatedKeys.external,
        aggregatedKeys.internal,
        csvSequence,
      );

      console.log("[WalletService:loadWallet] ✅ Wallet loaded successfully");
    } catch (error: unknown) {
      console.error("[WalletService:loadWallet] ❌ Failed to load wallet:", errMsg(error));
      throw error;
    }
  }

  /**
   * Get the aggregated key for external addresses (used as tapInternalKey)
   * This is the MuSig2 aggregated public key used for key-path spending
   */
  getAggregatedKey(): string | null {
    console.log("[WalletService:getAggregatedKey] Getting aggregated key");

    if (!this.wallet) {
      console.log("[WalletService:getAggregatedKey] No wallet initialized");
      return null;
    }

    const aggregatedKey = this.wallet.aggregatedKeys.external;
    console.log(
      "[WalletService:getAggregatedKey] ✅ Returning aggregated key:",
      `${aggregatedKey.slice(0, 16)}...`,
    );
    return aggregatedKey;
  }

  /**
   * Returns true if a wallet is currently loaded in memory
   */
  isInitialized(): boolean {
    return this.wallet !== null;
  }

  /**
   * Clear wallet from memory
   */
  clear(): void {
    console.log("[WalletService:clear] Clearing wallet from memory");
    this.wallet = null;
    this.walletCredId = null;
    this.identityEpoch += 1;
    console.log("[WalletService:clear] ✅ Wallet cleared");
  }
}

// Export singleton instance
export const walletService = new WalletService();
