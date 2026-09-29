// App-open runner for SwapKitLegacyArkadeRefund: wires the wallet, the swap key
// refund and a durable journal into the pure recovery module.
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { getArkadeReceiveAddress } from "../arkade/ArkadeAddressService";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { refundSwapKitArkadeVhtlc } from "./SwapKitArkadeVhtlcService";
import { callV1RecoveryTool, recoverLegacyArkadeRefunds } from "./SwapKitLegacyArkadeRefund";
import { isVhtlcRefundable } from "./vhtlcRefundTiming";

// Same key the removed v1 Arkade action handler journaled under, so a refund it
// already broadcast is replayed instead of attempted twice.
const JOURNAL_KEY = "swapkit:arkade-results:v1";

type JournalEntry = string | { txid: string; finalized?: boolean };

let journalChain: Promise<void> = Promise.resolve();

async function readJournal(): Promise<Record<string, JournalEntry>> {
  try {
    const parsed = await getCacheValue<unknown>(JOURNAL_KEY);
    return parsed && typeof parsed === "object"
      ? { ...(parsed as Record<string, JournalEntry>) }
      : {};
  } catch {
    return {};
  }
}

const journal = {
  async get(actionId: string): Promise<string | null> {
    const entry = (await readJournal())[actionId];
    if (!entry) return null;
    return typeof entry === "string" ? entry : String(entry.txid || "") || null;
  },
  set(actionId: string, txid: string): Promise<void> {
    const write = journalChain.then(async () => {
      const current = await readJournal();
      current[actionId] = { txid, finalized: false };
      await setCacheValue(JOURNAL_KEY, current);
    });
    journalChain = write.catch(() => {});
    return write;
  },
};

let running: Promise<string[]> | null = null;

/** Run once per app open; concurrent calls share the same run. */
export function runLegacyArkadeRefunds(): Promise<string[]> {
  if (running) return running;
  const run: Promise<string[]> = recoverLegacyArkadeRefunds({
    call: (tool, args) => callV1RecoveryTool(tool, args),
    getOwner: getEthereumAddress,
    getRefundAddress: getArkadeReceiveAddress,
    refund: refundSwapKitArkadeVhtlc,
    isRefundable: isVhtlcRefundable,
    journal,
  })
    .catch((): string[] => [])
    .finally(() => {
      running = null;
    });
  running = run;
  return run;
}
