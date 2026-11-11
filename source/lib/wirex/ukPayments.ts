// lib/wirex/ukPayments.ts
// Pure helpers for the UK bank account (sort code + account number) and for
// sending to UK bank accounts. Kept out of the service and the screens so they
// can be tested without a renderer.

// Where the user stands with the UK account, as the server reports it from
// Wirex's capabilities. "unavailable" covers everyone not resident in the UK.
export type UkAccountState = "active" | "opening" | "available" | "not_ready" | "unavailable";

const UK_ACCOUNT_STATES = new Set<string>([
  "active",
  "opening",
  "available",
  "not_ready",
  "unavailable",
]);

export function parseUkAccountState(raw: unknown): UkAccountState | null {
  return typeof raw === "string" && UK_ACCOUNT_STATES.has(raw) ? (raw as UkAccountState) : null;
}

/** Digits only, at most six. */
export function sortCodeDigits(text: string): string {
  return text.replace(/\D/g, "").slice(0, 6);
}

/** A sort code as typed, written the way UK banks print it: 12-34-56. */
export function formatSortCodeInput(text: string): string {
  return sortCodeDigits(text).replace(/(\d{2})(?=\d)/g, "$1-");
}

export function isValidSortCode(text: string): boolean {
  return /^\d{6}$/.test(text.replace(/[\s-]/g, ""));
}

/** Digits only, at most eight. */
export function accountNumberDigits(text: string): string {
  return text.replace(/\D/g, "").slice(0, 8);
}

export function isValidAccountNumber(text: string): boolean {
  return /^\d{8}$/.test(text.replace(/\s/g, ""));
}

type BankAccountLike = {
  type?: string | null;
  account_type?: string | null;
  status?: string | null;
  sort_code?: string | null;
  account_number?: string | null;
};

/**
 * The user's own UK account details from the status bank account list: the
 * FasterPayment account that carries a sort code and an account number. null
 * while there is none (not opened, or Wirex is still setting it up).
 */
export function ukBankDetails(
  accounts: readonly BankAccountLike[] | null | undefined,
): { sortCode: string; accountNumber: string } | null {
  for (const account of accounts ?? []) {
    const type = (account?.type ?? account?.account_type ?? "").trim().toLowerCase();
    if (type !== "fasterpayment") continue;
    const sortCode = (account.sort_code ?? "").replace(/\D/g, "");
    const accountNumber = (account.account_number ?? "").replace(/\D/g, "");
    if (/^\d{6}$/.test(sortCode) && /^\d{8}$/.test(accountNumber)) {
      return { sortCode, accountNumber };
    }
  }
  return null;
}

/**
 * Whether to ask the server to open the UK account now: Wirex offers it and
 * this wallet has not been asked about yet in this run of the app. Every
 * other state either needs nothing or is not ours to change.
 */
export function shouldOpenUkAccount(state: UkAccountState | null, alreadyAsked: boolean): boolean {
  return state === "available" && !alreadyAsked;
}
