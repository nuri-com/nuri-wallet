import { STAGE_DONE, STAGE_ACTION, STAGE_FAILED, type StageState } from "./debugConfig";

const STEP_LABELS: Record<string, string> = {
  create_user: "Create user",
  create_user_retry: "Retry create user",
  create_user_fallback_hosted: "Fallback create user",
  sponsor_eoa_balance: "Sponsor EOA gas",
  aa_onchain_bootstrap: "AA dual-signer bootstrap",
  aa_onchain_bootstrap_retry_1: "AA dual-signer bootstrap retry 1",
  aa_onchain_bootstrap_retry_2: "AA dual-signer bootstrap retry 2",
  aa_bootstrap_required_on_device: "AA bootstrap required on device",
  set_kyc_sharing_token: "Apply sharing token",
  get_user_after_sharing: "Reload user after sharing",
  kyc_link: "Request KYC link",
  kyc_token: "Request KYC token",
  activate_bank_ach: "Activate ACH",
  activate_bank_sepa: "Activate SEPA",
  activate_bank_spei: "Activate SPEI",
  list_bank_accounts: "Load cash accounts",
  list_cards_precreate: "Load cards (pre-check)",
  create_virtual_card: "Create virtual card",
  list_cards: "Load cards",
  list_recipients: "Load recipients",
  list_recipients_after_create: "Reload recipients",
  get_wallet_balances_before_mint: "Load Wirex wallet balance (before)",
  get_wallet_balances_after_mint: "Load Wirex wallet balance (after)",
  get_onchain_balance_before_mint: "Load onchain token balance (before)",
  get_onchain_balance_after_mint: "Load onchain token balance (after)",
  select_mint_target: "Select sandbox mint target",
  mint_wallet_balance: "Mint sandbox token",
  ensure_card_recipient: "Ensure card recipient",
  mint_sandbox_balance: "Mint sandbox balance",
  compare_onchain_vs_wirex_balance: "Compare onchain vs Wirex balance",
  run_push_to_card: "Run push to card",
  issue_user_scoped_token: "Issue user-scoped token",
  tokenize_card: "Tokenize card (PCI)",
  create_card_recipient_from_tokenized_card: "Create card recipient",
  resolve_external_card_id_from_created_recipient: "Resolve external card id",
  resolve_external_card_id: "Resolve external card id",
  create_card_transfer_estimate: "Create card transfer estimate",
  select_transfer_token: "Select transfer token",
  execute_card_transfer: "Execute card transfer",
  get_user_after_transfer: "Reload user after transfer",
  get_user_final: "Load final user",
};

export const getStageLabel = (state: StageState): string => {
  if (state === STAGE_DONE) return "Done";
  if (state === STAGE_ACTION) return "Action needed";
  if (state === STAGE_FAILED) return "Failed";
  return "Pending";
};

export const getFriendlyStepName = (name: string): string => STEP_LABELS[name] || name;

export const formatBackendStage = (value: string): string => {
  const normalized = value.trim();
  if (!normalized) return "idle";
  const withoutPrefix = normalized.startsWith("step:") ? normalized.slice(5) : normalized;
  const mapped = getFriendlyStepName(withoutPrefix);
  if (mapped !== withoutPrefix) return mapped;
  return withoutPrefix.replace(/_/g, " ");
};

export const isLocalProxyUrl = (value: string): boolean => {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]"
    );
  } catch {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(normalized);
  }
};
