// A claim that Arkade has dropped never hears about it.
//
// Arkade takes every queued registration into the next round and asks each one
// to confirm it is there. A registration that does not confirm in time, or whose
// round fails, is removed for good and never queued again (arkd v0.9.26,
// `startConfirmation` and the intent store's `Pop`). Nothing tells the phone: the
// SDK keeps waiting for a round naming its registration, and with the
// connection reopened after a cut (roundEventStream.ts) it waits until the
// connection finally dies. Claims sat like that for 10 to 46 minutes.
//
// So a round join gets two deadlines. A round has to name the registration
// within ROUND_START_TIMEOUT_MS of registering, and once it has, it has to end
// within ROUND_FINISH_TIMEOUT_MS. A missed deadline ends the join with an error
// the SDK cleans up after like any other failure.

/** Rounds start back to back, about every 70 s; two of them must pass first. */
export const ROUND_START_TIMEOUT_MS = 150_000;
/** Arkade gives a whole round 60 s. */
export const ROUND_FINISH_TIMEOUT_MS = 90_000;

export const ROUND_NOT_STARTED_MESSAGE =
  "Arkade did not start a round for this claim. Nothing was moved.";
export const ROUND_NOT_FINISHED_MESSAGE =
  "Arkade's round for this claim did not finish. Nothing was moved.";

export type RoundWatchdogEvent = {
  type?: string;
  id?: string;
  intentIdHashes?: string[];
};

export type RoundWatchdogOptions = {
  startTimeoutMs?: number;
  finishTimeoutMs?: number;
  onExpire: (error: Error) => void;
};

export type RoundWatchdog = {
  /** The join registered; `intentHash` is sha256 of the registration id, as hex. */
  registered: (intentHash: string) => void;
  /** Every event the join's stream delivers. */
  observe: (event: RoundWatchdogEvent) => void;
  stop: () => void;
};

export function createRoundWatchdog(options: RoundWatchdogOptions): RoundWatchdog {
  const startTimeoutMs = options.startTimeoutMs ?? ROUND_START_TIMEOUT_MS;
  const finishTimeoutMs = options.finishTimeoutMs ?? ROUND_FINISH_TIMEOUT_MS;
  const ownHashes = new Set<string>();
  let ownBatchId = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = (ms: number, message: string) => {
    clear();
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      stopped = true;
      options.onExpire(new Error(message));
    }, ms);
  };

  return {
    registered(intentHash) {
      const hash = String(intentHash || "").toLowerCase();
      if (!hash || stopped) return;
      ownHashes.add(hash);
      if (!ownBatchId) arm(startTimeoutMs, ROUND_NOT_STARTED_MESSAGE);
    },
    observe(event) {
      if (stopped) return;
      const type = String(event?.type || "");
      const id = String(event?.id || "").trim();
      if (type === "batch_started") {
        const named = (event.intentIdHashes || []).some((h) =>
          ownHashes.has(String(h || "").toLowerCase()),
        );
        if (named && id) {
          ownBatchId = id;
          arm(finishTimeoutMs, ROUND_NOT_FINISHED_MESSAGE);
        }
        return;
      }
      if ((type === "batch_finalized" || type === "batch_failed") && id && id === ownBatchId) {
        clear();
      }
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}
