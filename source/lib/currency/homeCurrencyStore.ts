// The user's main currency: every figure the app converts or aggregates is
// stated in it, and the card settles in it (anything sent to the card is
// swapped into this currency's stable; card money in the other currency is
// offered back as found money). It is a DEVICE preference, like the language:
// stored on the device, kept across logout.
//
// Plain logic with its storage and change signal injected, so it is testable
// without React Native. `HomeCurrencyService` wires the real ones.

export const DISPLAY_CURRENCIES = ["EUR", "USD"] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = "EUR";
export const DISPLAY_CURRENCY_STORAGE_KEY = "@nuri:display_currency:v1";

export type DisplayCurrencyStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

/** A stored or passed value, or null when it is not a selectable currency. */
export function parseDisplayCurrency(raw: unknown): DisplayCurrency | null {
  return typeof raw === "string" && (DISPLAY_CURRENCIES as readonly string[]).includes(raw)
    ? (raw as DisplayCurrency)
    : null;
}

type Listener = (currency: DisplayCurrency) => void;

export class HomeCurrencyStore {
  private current: DisplayCurrency = DEFAULT_DISPLAY_CURRENCY;
  private readonly listeners = new Set<Listener>();
  // A choice made while the stored one is still loading wins over the load.
  private revision = 0;

  constructor(
    private readonly deps: {
      storage: DisplayCurrencyStorage;
      /** Fired once per actual change, after subscribers. */
      onChange?: (currency: DisplayCurrency) => void;
    },
  ) {}

  /** Loads the stored choice. Unknown or unreadable → the default (EUR). */
  async initialize(): Promise<void> {
    const revision = this.revision;
    let stored: DisplayCurrency | null = null;
    try {
      stored = parseDisplayCurrency(await this.deps.storage.getItem(DISPLAY_CURRENCY_STORAGE_KEY));
    } catch {}
    if (revision !== this.revision) return;
    this.apply(stored ?? DEFAULT_DISPLAY_CURRENCY);
  }

  getHomeCurrency(): DisplayCurrency {
    return this.current;
  }

  /** Applies at once; the write is best effort (the in-memory choice stands). */
  async setHomeCurrency(currency: DisplayCurrency): Promise<void> {
    const next = parseDisplayCurrency(currency);
    if (!next) throw new Error(`Unsupported display currency: ${String(currency)}`);
    this.revision += 1;
    this.apply(next);
    try {
      await this.deps.storage.setItem(DISPLAY_CURRENCY_STORAGE_KEY, next);
    } catch (error: unknown) {
      console.warn(
        "[HomeCurrency] persist failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private apply(next: DisplayCurrency): void {
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
    this.deps.onChange?.(next);
  }
}
