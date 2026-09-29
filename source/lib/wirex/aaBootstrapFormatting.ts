import { buildHttpErrorDigest } from "./errorHandling";

export const aaBootstrapStageLabel = (stage: string): string => {
  const normalized = stage.trim();
  if (!normalized) return "AA bootstrap in progress...";
  switch (normalized) {
    case "initializing":
      return "AA bootstrap: initializing";
    case "building_kernel_account":
      return "AA bootstrap: preparing kernel account";
    case "kernel_account_ready":
      return "AA bootstrap: kernel resolved";
    case "discovering_webauthn_permission":
      return "AA bootstrap: discovering onchain WebAuthn permission";
    case "permission_discovery_result":
      return "AA bootstrap: onchain discovery result";
    case "permission_status":
      return "AA bootstrap: checking WebAuthn permission";
    case "weighted_signer_state":
      return "AA bootstrap: reading weighted signer state";
    case "weighted_validator_ready":
      return "AA bootstrap: weighted validator prepared";
    case "migrating_to_weighted_validator":
      return "AA bootstrap: switching root to weighted validator";
    case "weighted_validator_not_initialized":
      return "AA bootstrap: account is not weighted-initialized";
    case "kernel_balance_checked":
      return "AA bootstrap: checking kernel balance";
    case "kernel_funding_required":
      return "AA bootstrap: kernel needs prefunding";
    case "updating_weighted_signers":
      return "AA bootstrap: updating weighted signer set";
    case "weighted_signers_updated":
      return "AA bootstrap: weighted signer set updated";
    case "waiting_for_weighted_signer_visibility":
      return "AA bootstrap: waiting for weighted signer visibility";
    case "weighted_signer_visibility_timeout":
      return "AA bootstrap: weighted signer visibility timed out";
    case "retrying_weighted_signer_update_after_timeout":
      return "AA bootstrap: retrying weighted signer update";
    case "installing_modules_and_registering":
      return "AA bootstrap: install + register onchain";
    case "upgrading_existing_kernel":
      return "AA bootstrap: upgrade existing kernel";
    case "requesting_operation_for_existing_upgrade":
      return "AA bootstrap: requesting operation (legacy policy)";
    case "waiting_for_requested_operation_maturation":
      return "AA bootstrap: waiting for requested operation maturity";
    case "requested_operation_maturation_timeout":
      return "AA bootstrap: request matured too slowly";
    case "request_existing_upgrade_retry_with_root_permission_sudo":
      return "AA bootstrap: retry request with root validator mode";
    case "request_existing_upgrade_receipt_timeout":
      return "AA bootstrap: request receipt timed out";
    case "request_existing_upgrade_recorded_onchain_after_timeout":
      return "AA bootstrap: request recorded onchain after timeout";
    case "request_existing_upgrade_receipt_timeout_unconfirmed":
      return "AA bootstrap: request timeout not confirmed onchain";
    case "request_existing_upgrade_already_requested":
      return "AA bootstrap: request already recorded onchain";
    case "request_existing_upgrade_failed":
      return "AA bootstrap: request operation failed";
    case "upgrade_existing_after_request_receipt_timeout":
      return "AA bootstrap: upgrade receipt timed out";
    case "upgrade_existing_after_request_receipt_timeout_recovered":
      return "AA bootstrap: upgrade recovered from timeout";
    case "upgrade_existing_after_request_retry_with_root_permission_sudo":
      return "AA bootstrap: retry upgrade with root validator mode";
    case "root_permission_validator_ready":
      return "AA bootstrap: using root permission validator";
    case "root_permission_validator_skipped":
      return "AA bootstrap: root permission validator skipped";
    case "user_operation_sent":
      return "AA bootstrap: user operation sent";
    case "waiting_for_user_operation_receipt":
      return "AA bootstrap: waiting for onchain receipt";
    case "user_operation_receipt_failed":
      return "AA bootstrap: user operation receipt lookup failed";
    case "verifying_post_receipt_failure_state":
      return "AA bootstrap: verifying onchain state after receipt failure";
    case "waiting_for_post_receipt_state_recovery":
      return "AA bootstrap: waiting for onchain state recovery";
    case "retrying_create_and_register_after_timeout":
      return "AA bootstrap: retrying create after timeout";
    case "post_receipt_failure_recovered":
      return "AA bootstrap: recovered from onchain state";
    case "post_receipt_failure_unrecovered":
      return "AA bootstrap: receipt failure not recoverable yet";
    case "post_receipt_failure_recovery_check_failed":
      return "AA bootstrap: recovery-state check failed";
    case "already_ready":
      return "AA bootstrap: already dual-signer ready";
    case "completed":
      return "AA bootstrap: completed";
    case "readiness_checked":
      return "AA transfer: readiness checked";
    case "token_transfer_prepared":
      return "AA transfer: token transfer prepared";
    default:
      return `AA bootstrap: ${normalized.replace(/_/g, " ")}`;
  }
};

export const formatAaBootstrapError = (message: string): string => {
  if (message === "zerodev_deprecated_disabled") {
    return "The deprecated ZeroDev AA path is disabled. Use the selfhost bundler and public RPC only.";
  }
  if (message === "missing_selfhost_bundler_rpc_url") {
    return "Selfhost mode requires a selfhost bundler RPC URL.";
  }
  if (message === "missing_selfhost_public_rpc_url") {
    return "Selfhost mode requires a public Base Sepolia RPC URL.";
  }
  if (message === "missing_selfhost_paymaster_address") {
    return "Selfhost mode requires a hosted paymaster address.";
  }
  if (message === "invalid_selfhost_paymaster_address") {
    return "Selfhost mode requires a valid hosted paymaster address.";
  }
  if (message === "selfhost_zerodev_endpoint_forbidden") {
    return "Selfhost mode rejects ZeroDev hosts. Use your own bundler and public RPC URLs.";
  }
  if (message === "kernel_insufficient_funds") {
    return "Selfhost sponsorship is not active. Configure the hosted paymaster before bootstrapping AA.";
  }
  if (message === "existing_account_not_weighted_validator_initialized") {
    return "This AA was not initialized with weighted validator; use a fresh wallet or migrate this account first.";
  }
  if (message === "selfhost_kernel_not_deployed") {
    return "The AA kernel is not deployed yet. Run the Wirex AA bootstrap first.";
  }
  if (message === "wirex_funds_management_not_installed") {
    return "The Wirex FundsManagement module is not installed on this AA yet.";
  }
  if (message === "invalid_aa_transfer_recipient") {
    return "Sponsored AA send requires a valid recipient address.";
  }
  if (message === "invalid_aa_transfer_token") {
    return "Sponsored AA send requires a valid token address.";
  }
  if (message === "invalid_aa_transfer_amount") {
    return "Sponsored AA send requires a positive token amount.";
  }
  if (message === "aa_token_balance_insufficient") {
    return "The AA wallet does not hold enough token balance for this sponsored send.";
  }
  if (message === "weighted_signer_not_installed") {
    return "Weighted signer update completed but the passkey signer is not visible onchain yet.";
  }
  const httpDigest = buildHttpErrorDigest(message);
  if (httpDigest) {
    return httpDigest;
  }
  return message;
};

export const attachAaBootstrapSummary = (
  payload: Record<string, unknown> | null,
  aaBootstrap: Record<string, unknown> | null,
): unknown => {
  if (!payload) {
    return aaBootstrap ? { aaBootstrap } : payload;
  }
  if (!aaBootstrap) {
    return payload;
  }
  return {
    ...payload,
    aaBootstrap,
  };
};
