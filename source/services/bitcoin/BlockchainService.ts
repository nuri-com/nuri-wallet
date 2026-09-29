import { newOp, LOG_EMOJI } from "../../lib/OperationLogUtils";
import { ESPLORA_FALLBACK_API_BASE_URL, MEMPOOL_API_BASE_URL } from "../../config/endpoints";
import { errMsg } from "../../lib/errorMessage";
import type { AddressTx } from "../../types/bitcoin";

// mempool.space /v1/fees/recommended response.
type EsploraFeeEstimates = {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee?: number;
};

type BlockchainInfo = {
  height: number;
};

interface UTXO {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

interface Balance {
  total: number;
  confirmed: number;
  unconfirmed: number;
  txCount: number;
}

interface TransactionStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

interface AddressSummaryStats {
  funded_txo_sum?: number;
  spent_txo_sum?: number;
  funded_txo_count?: number;
  spent_txo_count?: number;
  tx_count?: number;
}

interface AddressSummary {
  address?: string;
  chain_stats?: AddressSummaryStats;
  mempool_stats?: AddressSummaryStats;
}

class BlockchainService {
  private esploraUrl = MEMPOOL_API_BASE_URL;
  private lastSyncTime = 0;
  private syncDebounceMs = 2000; // 2 seconds
  private lastSyncBalance: Balance | null = null;
  private lastSyncAddress: string | null = null;
  private requestTimeoutMs = 12_000;

  private shortAddress(address: string): string {
    const raw = String(address || "").trim();
    if (!raw) return "unknown";
    if (raw.length <= 12) return raw;
    return `${raw.slice(0, 6)}…${raw.slice(-6)}`;
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).host || "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * Set custom Esplora URL (for testnet/regtest)
   */
  setEsploraUrl(url: string): void {
    const op = newOp("BlockchainService", "setEsploraUrl", LOG_EMOJI.bitcoin);
    const oldUrl = this.esploraUrl;
    this.esploraUrl = url.replace(/\/$/, ""); // Remove trailing slash
    op.log(`Changed from ${oldUrl} to ${this.esploraUrl}`);
    op.end("Finished");
  }

  private tagInit(source: string, init?: RequestInit): RequestInit {
    const next: RequestInit = init ? { ...init } : {};
    (next as Record<string, unknown>).__nuriSource = source;
    return next;
  }

  /**
   * The same request against the fallback Esplora, once the primary has proven
   * unreachable. Mempool-only paths are not served there, so they never fail
   * over — they fail, as they would anyway.
   */
  private fallbackUrlFor(url: string): string | null {
    if (this.esploraUrl === ESPLORA_FALLBACK_API_BASE_URL) return null;
    if (!url.startsWith(this.esploraUrl)) return null;
    const path = url.slice(this.esploraUrl.length);
    if (path.startsWith("/v1/")) return null;
    return `${ESPLORA_FALLBACK_API_BASE_URL}${path}`;
  }

  private async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchOnce(url, init);
    } catch (error: unknown) {
      // Unreachable host, not a bad request: every response, including a 4xx,
      // comes back through the branch above. Retrying the identical path on the
      // second Esplora is the difference between a balance and a zero.
      const fallback = this.fallbackUrlFor(url);
      if (!fallback) throw error;
      const response = await this.fetchOnce(fallback, init);
      // It answered — stay there for the rest of the session rather than paying
      // the primary's timeout on every single read.
      this.esploraUrl = ESPLORA_FALLBACK_API_BASE_URL;
      return response;
    }
  }

  private async fetchOnce(url: string, init?: RequestInit): Promise<Response> {
    const ms = this.requestTimeoutMs;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (controller) {
      const id = setTimeout(() => {
        try {
          controller.abort();
        } catch {}
      }, ms);
      try {
        return await fetch(url, { ...(init ?? {}), signal: controller.signal });
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`timeout after ${ms}ms`);
        }
        throw error;
      } finally {
        clearTimeout(id);
      }
    }

    // Fallback: timeout without abort (avoids hanging refresh locks).
    const p = fetch(url, init);
    // Prevent "losing" race branch from becoming an unhandled rejection.
    p.catch(() => {});
    return (await Promise.race([
      p,
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
      ),
    ])) as Response;
  }

  /**
   * Fetch UTXOs for an address
   */
  async fetchUTXOs(address: string): Promise<UTXO[]> {
    const op = newOp("BlockchainService", "fetchUTXOs", LOG_EMOJI.bitcoin);
    op.log(`addr=${this.shortAddress(address)} host=${this.hostOf(this.esploraUrl)}`);

    try {
      const url = `${this.esploraUrl}/address/${address}/utxo`;
      op.log("GET /address/:address/utxo");

      const response = await this.fetchWithTimeout(url, this.tagInit("bitcoin:utxos"));
      op.log(`Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        op.error("API error", errorText);
        throw new Error(`Failed to fetch UTXOs: ${response.statusText} - ${errorText}`);
      }

      const utxos: UTXO[] = await response.json();

      let confirmedCount = 0;
      let unconfirmedCount = 0;
      let confirmedTotal = 0;
      let unconfirmedTotal = 0;

      for (const utxo of utxos) {
        if (utxo.status.confirmed) {
          confirmedCount += 1;
          confirmedTotal += utxo.value;
        } else {
          unconfirmedCount += 1;
          unconfirmedTotal += utxo.value;
        }
      }

      const totalSats = confirmedTotal + unconfirmedTotal;

      op.log("UTXO summary", {
        total: utxos.length,
        confirmedCount,
        unconfirmedCount,
        totalSats,
        addressSuffix: String(address).slice(-6),
      });

      return utxos;
    } catch (error: unknown) {
      const msg = errMsg(error);
      op.error("Network error", msg);

      // Check if it's a network error
      if (msg.includes("fetch")) {
        throw new Error(`Network error: Unable to connect to ${this.esploraUrl}`);
      }

      throw error;
    } finally {
      op.end("Finished");
    }
  }

  /**
   * Fetch address summary (balance + stats)
   */
  async fetchAddressSummary(address: string): Promise<AddressSummary> {
    const op = newOp("BlockchainService", "fetchAddressSummary", LOG_EMOJI.bitcoin);
    try {
      const url = `${this.esploraUrl}/address/${address}`;
      const response = await this.fetchWithTimeout(url, this.tagInit("bitcoin:addressSummary"));
      if (!response.ok) {
        const errorText = await response.text();
        op.error("API error", errorText);
        throw new Error(`Failed to fetch address summary: ${response.statusText} - ${errorText}`);
      }
      const summary = (await response.json()) as AddressSummary;
      op.log(`ok addr=${this.shortAddress(address)} status=${response.status}`);
      return summary;
    } catch (error: unknown) {
      const msg = errMsg(error);
      op.error("Network error", msg);
      if (msg.includes("fetch")) {
        throw new Error(`Network error: Unable to connect to ${this.esploraUrl}`);
      }
      throw error;
    } finally {
      op.end("OK");
    }
  }

  private balanceFromSummary(summary: AddressSummary): Balance {
    const chain = summary?.chain_stats ?? {};
    const mempool = summary?.mempool_stats ?? {};
    const chainFunded = Number(chain.funded_txo_sum ?? 0);
    const chainSpent = Number(chain.spent_txo_sum ?? 0);
    const mempoolFunded = Number(mempool.funded_txo_sum ?? 0);
    const mempoolSpent = Number(mempool.spent_txo_sum ?? 0);
    const chainTxCount = Number(chain.tx_count ?? 0);
    const mempoolTxCount = Number(mempool.tx_count ?? 0);
    const confirmed =
      (Number.isFinite(chainFunded) ? chainFunded : 0) -
      (Number.isFinite(chainSpent) ? chainSpent : 0);
    const unconfirmed =
      (Number.isFinite(mempoolFunded) ? mempoolFunded : 0) -
      (Number.isFinite(mempoolSpent) ? mempoolSpent : 0);
    const total = confirmed + unconfirmed;
    const txCount =
      (Number.isFinite(chainTxCount) ? chainTxCount : 0) +
      (Number.isFinite(mempoolTxCount) ? mempoolTxCount : 0);
    return { total, confirmed, unconfirmed, txCount };
  }

  /**
   * Calculate balance using address summary (no UTXO fetch)
   */
  async getBalanceSummary(address: string): Promise<Balance> {
    const op = newOp("BlockchainService", "getBalanceSummary", LOG_EMOJI.bitcoin);
    try {
      const summary = await this.fetchAddressSummary(address);
      const balance = this.balanceFromSummary(summary);
      op.log(`ok addr=${this.shortAddress(address)}`, {
        total: balance.total,
        confirmed: balance.confirmed,
        unconfirmed: balance.unconfirmed,
      });
      return balance;
    } catch (error: unknown) {
      op.error("Failed to calculate balance summary", errMsg(error));
      throw error;
    } finally {
      op.end("OK");
    }
  }

  /**
   * Get current block height
   */
  async getCurrentBlockHeight(): Promise<number> {
    const op = newOp("BlockchainService", "getCurrentBlockHeight", LOG_EMOJI.bitcoin);

    try {
      const url = `${this.esploraUrl}/blocks/tip/height`;
      const response = await this.fetchWithTimeout(url, this.tagInit("bitcoin:blockHeight"));

      if (!response.ok) {
        throw new Error(`Failed to fetch block height: ${response.statusText}`);
      }

      const height = await response.json();
      op.log(`Current height: ${height}`);
      return height;
    } catch (error: unknown) {
      op.error("Error", errMsg(error));
      // Return a reasonable default for testing
      return 850000;
    } finally {
      op.end("Finished");
    }
  }

  /**
   * Calculate balance from UTXOs
   */
  async getBalance(address: string): Promise<Balance> {
    const op = newOp("BlockchainService", "getBalance", LOG_EMOJI.bitcoin);
    op.log(`calc addr=${this.shortAddress(address)}`);

    try {
      const utxos = await this.fetchUTXOs(address);

      let confirmed = 0;
      let unconfirmed = 0;
      let confirmedCount = 0;
      let unconfirmedCount = 0;

      for (const utxo of utxos) {
        if (utxo.status.confirmed) {
          confirmed += utxo.value;
          confirmedCount++;
        } else {
          unconfirmed += utxo.value;
          unconfirmedCount++;
        }
      }

      const balance: Balance = {
        total: confirmed + unconfirmed,
        confirmed,
        unconfirmed,
        txCount: 0,
      };

      op.log("Balance calculated", {
        total: balance.total,
        confirmed: balance.confirmed,
        unconfirmed: balance.unconfirmed,
        confirmedCount,
        unconfirmedCount,
      });

      return balance;
    } catch (error: unknown) {
      op.error("Failed to calculate balance", errMsg(error));
      throw error;
    } finally {
      op.end("Finished");
    }
  }

  /**
   * Broadcast a transaction
   */
  async broadcastTransaction(txHex: string): Promise<string> {
    console.log("[BlockchainService:broadcastTransaction] === Broadcasting transaction ===");
    console.log("[BlockchainService:broadcastTransaction] Transaction hex length:", txHex.length);
    console.log(
      "[BlockchainService:broadcastTransaction] First 64 chars:",
      `${txHex.slice(0, 64)}...`,
    );

    try {
      const url = `${this.esploraUrl}/tx`;
      console.log("[BlockchainService:broadcastTransaction] Broadcast URL:", url);

      const response = await fetch(
        url,
        this.tagInit("bitcoin:broadcast", {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
          },
          body: txHex,
        }),
      );

      console.log("[BlockchainService:broadcastTransaction] Response status:", response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[BlockchainService:broadcastTransaction] ❌ Broadcast failed:", errorText);

        // Parse common error messages
        if (errorText.includes("dust")) {
          throw new Error("Transaction output amount is below dust limit");
        }
        if (errorText.includes("fee")) {
          throw new Error("Insufficient fee or fee rate too low");
        }
        if (errorText.includes("already in block chain")) {
          throw new Error("Transaction already confirmed");
        }
        if (errorText.includes("conflict")) {
          throw new Error("Transaction conflicts with existing transaction");
        }

        throw new Error(`Broadcast failed: ${errorText}`);
      }

      const txid = await response.text();
      console.log("[BlockchainService:broadcastTransaction] ✅ Transaction broadcast successfully");
      console.log("[BlockchainService:broadcastTransaction] TXID:", txid);
      console.log("[BlockchainService:broadcastTransaction] View on mempool.space:");
      console.log(
        `[BlockchainService:broadcastTransaction]   ${this.esploraUrl.replace("/api", "")}/tx/${txid}`,
      );

      return txid;
    } catch (error: unknown) {
      console.error("[BlockchainService:broadcastTransaction] ❌ Broadcast error:", errMsg(error));
      console.error(
        "[BlockchainService:broadcastTransaction] Stack:",
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Get transaction details
   */
  async getTransaction(txid: string): Promise<AddressTx> {
    console.log("[BlockchainService:getTransaction] === Fetching transaction ===");
    console.log("[BlockchainService:getTransaction] TXID:", txid);

    try {
      const url = `${this.esploraUrl}/tx/${txid}`;
      const response = await fetch(url, this.tagInit("bitcoin:tx"));

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[BlockchainService:getTransaction] ❌ Failed to fetch:", errorText);
        throw new Error(`Failed to fetch transaction: ${response.statusText}`);
      }

      const tx = (await response.json()) as AddressTx;
      console.log("[BlockchainService:getTransaction] ✅ Transaction fetched");
      console.log(
        "[BlockchainService:getTransaction] Confirmations:",
        tx.status?.confirmed ? "confirmed" : "unconfirmed",
      );
      console.log("[BlockchainService:getTransaction] Inputs:", tx.vin?.length || 0);
      console.log("[BlockchainService:getTransaction] Outputs:", tx.vout?.length || 0);

      return tx;
    } catch (error: unknown) {
      console.error("[BlockchainService:getTransaction] ❌ Error:", errMsg(error));
      throw error;
    }
  }

  /**
   * Fetch the latest transactions for an address.
   * Returns unconfirmed (mempool) + most recent confirmed page.
   */
  async fetchAddressTransactions(address: string): Promise<AddressTx[]> {
    const op = newOp("BlockchainService", "fetchAddressTransactions", LOG_EMOJI.bitcoin);
    try {
      const url = `${this.esploraUrl}/address/${address}/txs`;
      op.log(`Request URL: ${url}`);
      const response = await this.fetchWithTimeout(url, this.tagInit("bitcoin:addressTxs"));
      if (!response.ok) {
        const errorText = await response.text();
        op.error("API error", errorText);
        throw new Error(`Failed to fetch transactions: ${response.statusText}`);
      }
      const txs = (await response.json()) as AddressTx[];
      op.log(`Fetched ${txs.length} transactions`);
      return Array.isArray(txs) ? txs : [];
    } catch (error: unknown) {
      op.error("Network error", errMsg(error));
      throw error;
    } finally {
      op.end("Finished");
    }
  }

  /**
   * Fetch next page of confirmed transactions (older) using last seen txid.
   */
  async fetchMoreAddressTransactions(address: string, lastSeenTxid: string): Promise<AddressTx[]> {
    const op = newOp("BlockchainService", "fetchMoreAddressTransactions", LOG_EMOJI.bitcoin);
    try {
      // Esplora expects the last seen txid as a path param
      const url = `${this.esploraUrl}/address/${address}/txs/chain/${lastSeenTxid}`;
      op.log(`Request URL: ${url}`);
      const response = await this.fetchWithTimeout(url, this.tagInit("bitcoin:addressTxs:more"));
      if (!response.ok) {
        const errorText = await response.text();
        op.error("API error", errorText);
        throw new Error(
          `Failed to fetch more transactions: ${response.status} ${response.statusText}`,
        );
      }
      const txs = (await response.json()) as AddressTx[];
      op.log(`Fetched ${txs.length} more transactions`);
      return Array.isArray(txs) ? txs : [];
    } catch (error: unknown) {
      op.error("Network error", errMsg(error));
      throw error;
    } finally {
      op.end("Finished");
    }
  }

  /**
   * Fetch all transactions for an address by paging until exhaustion.
   * Includes mempool txs and all confirmed txs reachable via /txs/chain.
   * NOTE: A safety cap prevents pathological downloads (maxPages).
   */
  async fetchAllAddressTransactions(address: string, maxPages = 50): Promise<AddressTx[]> {
    const op = newOp("BlockchainService", "fetchAllAddressTransactions", LOG_EMOJI.bitcoin);
    try {
      const firstPage = await this.fetchAddressTransactions(address);
      const all: AddressTx[] = Array.isArray(firstPage) ? [...firstPage] : [];
      // Use last confirmed txid from first page as the pagination cursor
      const confirmedFirst = all.filter((t) => t?.status?.confirmed);
      let lastSeen =
        confirmedFirst.length > 0 ? confirmedFirst[confirmedFirst.length - 1]?.txid : null;
      let page = 0;
      while (lastSeen && page < maxPages) {
        const older = await this.fetchMoreAddressTransactions(address, lastSeen);
        if (!older || older.length === 0) break;
        all.push(...older);
        // Update lastSeen to the last element of this page (oldest of this batch)
        lastSeen = older[older.length - 1]?.txid ?? null;
        page += 1;
      }
      op.log(`Total transactions collected: ${all.length} (pages: ${page + 1})`);
      return all;
    } catch (error: unknown) {
      op.error("Error", errMsg(error));
      throw error;
    } finally {
      op.end("Finished");
    }
  }

  /**
   * Get raw transaction hex
   */
  async getRawTransaction(txid: string): Promise<string> {
    console.log("[BlockchainService:getRawTransaction] === Fetching raw transaction ===");
    console.log("[BlockchainService:getRawTransaction] TXID:", txid);

    try {
      const url = `${this.esploraUrl}/tx/${txid}/hex`;
      const response = await fetch(url, this.tagInit("bitcoin:rawTx"));

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[BlockchainService:getRawTransaction] ❌ Failed to fetch:", errorText);
        throw new Error(`Failed to fetch raw transaction: ${response.statusText}`);
      }

      const txHex = await response.text();
      console.log("[BlockchainService:getRawTransaction] ✅ Raw transaction fetched");
      console.log("[BlockchainService:getRawTransaction] Hex length:", txHex.length);

      return txHex;
    } catch (error: unknown) {
      console.error("[BlockchainService:getRawTransaction] ❌ Error:", errMsg(error));
      throw error;
    }
  }

  /**
   * Get transaction status
   */
  async getTransactionStatus(txid: string): Promise<TransactionStatus> {
    console.log("[BlockchainService:getTransactionStatus] Checking status for:", txid);

    try {
      const url = `${this.esploraUrl}/tx/${txid}/status`;
      const response = await fetch(url, this.tagInit("bitcoin:txStatus"));

      if (!response.ok) {
        throw new Error(`Failed to fetch transaction status: ${response.statusText}`);
      }

      const status = await response.json();
      console.log(
        "[BlockchainService:getTransactionStatus] Status:",
        status.confirmed ? "confirmed" : "unconfirmed",
      );

      return status;
    } catch (error: unknown) {
      console.error("[BlockchainService:getTransactionStatus] ❌ Error:", errMsg(error));
      throw error;
    }
  }

  /**
   * Sync wallet data with debouncing
   */
  async sync(address: string): Promise<Balance | null> {
    const op = newOp("BlockchainService", "sync", LOG_EMOJI.bitcoin);
    op.log(`addr=${this.shortAddress(address)}`);

    // Debounce rapid sync calls
    const now = Date.now();
    const timeSinceLastSync = now - this.lastSyncTime;

    if (timeSinceLastSync < this.syncDebounceMs) {
      op.log("Debounced", {
        sinceLastMs: timeSinceLastSync,
        minIntervalMs: this.syncDebounceMs,
      });
      if (this.lastSyncAddress === address && this.lastSyncBalance) {
        op.end("CACHE_HIT");
        return this.lastSyncBalance;
      }
      op.end("SKIP");
      return null;
    }

    this.lastSyncTime = now;

    try {
      // Calculate balance via address summary to avoid heavy UTXO polling
      const balance = await this.getBalanceSummary(address);
      this.lastSyncBalance = balance;
      this.lastSyncAddress = address;

      op.log("Sync complete", {
        total: balance.total,
        confirmed: balance.confirmed,
        unconfirmed: balance.unconfirmed,
      });
      op.end("OK");
      return balance;
    } catch (error: unknown) {
      op.error("Sync failed", errMsg(error));
      op.end("ERR");
      throw error;
    }
  }

  /**
   * Get current fee estimates
   */
  async getFeeEstimates(): Promise<EsploraFeeEstimates> {
    console.log("[BlockchainService:getFeeEstimates] === Fetching fee estimates ===");

    try {
      const url = `${this.esploraUrl}/v1/fees/recommended`;
      console.log("[BlockchainService:getFeeEstimates] URL:", url);

      const response = await fetch(url, this.tagInit("bitcoin:fees"));

      if (!response.ok) {
        throw new Error(`Failed to fetch fee estimates: ${response.statusText}`);
      }

      const fees = (await response.json()) as EsploraFeeEstimates;
      console.log("[BlockchainService:getFeeEstimates] ✅ Fee estimates (sat/vB):");
      console.log("[BlockchainService:getFeeEstimates]   Fast (10 min):", fees.fastestFee);
      console.log("[BlockchainService:getFeeEstimates]   Medium (30 min):", fees.halfHourFee);
      console.log("[BlockchainService:getFeeEstimates]   Slow (1 hour):", fees.hourFee);
      console.log("[BlockchainService:getFeeEstimates]   Economy (1 day):", fees.economyFee);

      return fees;
    } catch (error: unknown) {
      console.error("[BlockchainService:getFeeEstimates] ❌ Error:", errMsg(error));

      // Return default fees if API fails. A guess either way: kept near what
      // the network normally asks, since every sat above it is paid for nothing.
      const defaultFees = {
        fastestFee: 4,
        halfHourFee: 4,
        hourFee: 3,
        economyFee: 1,
      };

      console.log("[BlockchainService:getFeeEstimates] Using default fees:", defaultFees);
      return defaultFees;
    }
  }

  /**
   * Get blockchain info (height, etc.)
   */
  async getBlockchainInfo(): Promise<BlockchainInfo> {
    console.log("[BlockchainService:getBlockchainInfo] === Fetching blockchain info ===");

    try {
      const url = `${this.esploraUrl}/blocks/tip/height`;
      const response = await fetch(url, this.tagInit("bitcoin:blockHeight"));

      if (!response.ok) {
        throw new Error(`Failed to fetch blockchain info: ${response.statusText}`);
      }

      const height = await response.text();
      console.log("[BlockchainService:getBlockchainInfo] ✅ Current block height:", height);

      return { height: Number.parseInt(height) };
    } catch (error: unknown) {
      console.error("[BlockchainService:getBlockchainInfo] ❌ Error:", errMsg(error));
      throw error;
    }
  }
}

// Export singleton instance
export const blockchainService = new BlockchainService();
export default blockchainService;
