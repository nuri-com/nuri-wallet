import { asObject, asArray, asString, asNumber, readArray } from "./debugHelpers";
import type { WirexDebugRunnerStepResult } from "./debugFlowRunner";

const readSnapshotWallet = (payload: unknown): Record<string, unknown> | null => {
  const root = asObject(payload);
  const snapshot = asObject(root?.snapshot);
  return asObject(snapshot?.wallet);
};

const readSnapshotBalanceValue = (
  payload: unknown,
  key: "onchainBalanceBeforeMint" | "onchainBalanceAfterMint",
): Record<string, unknown> | null => {
  const root = asObject(payload);
  const snapshot = asObject(root?.snapshot);
  return asObject(snapshot?.[key]);
};

const readOperation = (payload: unknown, key: "recipient" | "mint" | "push") => {
  const root = asObject(payload);
  const operations = asObject(root?.operations);
  return asObject(operations?.[key]);
};

const buildWalletBalanceLines = (payload: unknown): string[] => {
  const wallet = readSnapshotWallet(payload);
  if (!wallet) return [];
  const balances = asArray(wallet?.balances)
    .map((value) => asObject(value))
    .filter(Boolean) as Record<string, unknown>[];
  if (!balances.length) return [];
  const lines = ["walletBalances:"];
  for (const balance of balances) {
    lines.push(
      `${asString(balance.token_symbol, "token")}: ${String(balance.balance ?? "0")} | ${asString(balance.token_address, "missing")}`,
    );
  }
  return lines;
};

/** Every summary ends the same way: the wallet balances, then the run's steps,
 *  each separated by a blank line and each omitted when it has nothing to say. */
const withBalancesAndSteps = (lines: string[], payload: unknown): string => {
  const walletBalanceLines = buildWalletBalanceLines(payload);
  if (walletBalanceLines.length) {
    lines.push("");
    lines.push(...walletBalanceLines);
  }
  const stepLines = buildStepSummary(payload);
  if (stepLines.length) {
    lines.push("");
    lines.push(...stepLines);
  }
  return lines.join("\n");
};

export const buildStepSummary = (payload: unknown): string[] => {
  const root = asObject(payload);
  const steps = asArray(root?.steps);
  if (!steps.length) {
    return [];
  }
  const lines: string[] = ["Steps:"];
  for (const stepRaw of steps) {
    const step = asObject(stepRaw);
    const name = asString(step?.name, "unknown_step");
    const ok = step?.ok === true ? "ok" : "fail";
    const status = asNumber(step?.status);
    const note = asString(step?.note);
    const details: string[] = [];
    if (status !== null) details.push(String(status));
    if (note) details.push(note);
    lines.push(`${name}: ${ok}${details.length ? ` (${details.join(", ")})` : ""}`);
  }
  return lines;
};

export const buildOnboardingSummary = (payload: unknown): string => {
  const root = asObject(payload);
  if (!root) return "No onboarding response.";
  const summary = asObject(root.summary);
  const lines: string[] = [];
  const verificationStatus = asString(summary?.verificationStatus, "unknown");
  const sharing = asObject(summary?.sharing);
  const sharingAttempted = sharing?.attempted === true;
  const sharingApplied = sharing?.applied === true;
  const bankAccountsCount = Number(summary?.bankAccountsCount || 0);
  const cardsCount = Number(summary?.cardsCount || 0);
  const recipientsCount = Number(summary?.recipientsCount || 0);

  lines.push(`ok: ${root.ok === true ? "yes" : "no"}`);
  lines.push(`userStatus: ${asString(root.userStatus, "unknown")}`);
  lines.push("");
  lines.push("Step 1 - KYC sharing token:");
  if (!sharingAttempted) {
    lines.push("not attempted");
  } else {
    lines.push(sharingApplied ? "applied" : "failed");
  }
  lines.push("");
  lines.push("Step 2 - KYC:");
  lines.push(verificationStatus === "Approved" ? "approved" : verificationStatus);
  const kycLink = asString(summary?.kycLink);
  if (kycLink && verificationStatus !== "Approved") {
    lines.push(`kycLink: ${kycLink}`);
  }
  lines.push("");
  lines.push("Step 3 - Provisioning:");
  lines.push(`bankAccounts: ${String(bankAccountsCount)}`);
  lines.push(`cards: ${String(cardsCount)}`);
  lines.push(`recipients: ${String(recipientsCount)}`);
  const capabilities = asObject(summary?.capabilities);
  if (capabilities) {
    lines.push("");
    lines.push("Capabilities:");
    const capKeys = ["sepaAccount", "achAccount", "speiAccount", "visaVirtualCard"];
    for (const key of capKeys) {
      const cap = asObject(capabilities[key]);
      if (!cap) continue;
      const status = asString(cap.status, "Unknown");
      const reason = asString(cap.reason);
      lines.push(`${key}: ${status}${reason ? ` (${reason})` : ""}`);
    }
  }
  const stepLines = buildStepSummary(payload);
  if (stepLines.length) {
    lines.push("");
    lines.push(...stepLines);
  }
  return lines.join("\n");
};

export const buildProvisioningSummary = (payload: unknown): string => {
  const root = asObject(payload);
  if (!root) return "No provisioning data yet.";
  const snapshot = asObject(root.snapshot);
  const bankAccounts = readArray(snapshot, "bankAccounts")
    .map((value) => asObject(value))
    .filter(Boolean) as Record<string, unknown>[];
  const cards = readArray(snapshot, "cards")
    .map((value) => asObject(value))
    .filter(Boolean) as Record<string, unknown>[];

  const lines: string[] = [];
  lines.push("Cash Accounts:");
  if (!bankAccounts.length) {
    lines.push("none");
  } else {
    for (const account of bankAccounts) {
      const details = asObject(account.details);
      lines.push(
        `${asString(account.account_type, "Unknown")} ${asString(account.status, "Unknown")} | ${asString(details?.iban, "n/a")} | ${asString(details?.bic, "n/a")}`,
      );
    }
  }

  lines.push("");
  lines.push("Cards:");
  if (!cards.length) {
    lines.push("none");
  } else {
    for (const card of cards) {
      const cardData = asObject(card.card_data);
      lines.push(
        `${asString(card.id, "unknown")} | ${asString(card.status, "Unknown")} | ****${asString(cardData?.card_number_last_4, "----")} | ${asString(cardData?.expiry_date, "n/a")} | ${asString(cardData?.format, "n/a")}`,
      );
    }
  }

  return lines.join("\n");
};

export const buildPushSummary = (payload: unknown): string => {
  const root = asObject(payload);
  if (!root) return "No push-to-card response.";
  const summary = asObject(root.summary);
  const wallet = readSnapshotWallet(payload);
  const lines: string[] = [];
  lines.push(`ok: ${root.ok === true ? "yes" : "no"}`);
  lines.push(
    `result: ${
      root.ok === true
        ? "Push completed successfully."
        : "Push did not complete. Check the failing step below."
    }`,
  );
  lines.push(`externalCardId: ${asString(root.externalCardId, "missing")}`);
  if (wallet) {
    lines.push(`wirexWallet: ${asString(wallet.wallet_address, "missing")}`);
  }
  lines.push(`amount: ${String(root.amount ?? "unknown")} ${asString(root.currency, "")}`.trim());
  lines.push(`selectedToken: ${asString(root.selectedTokenAddress, "missing")}`);
  if (summary) {
    lines.push(`reason: ${asString(summary.reason, "n/a")}`);
    lines.push(`executed: ${summary.executed === true ? "yes" : "no"}`);
    lines.push(`estimationId: ${asString(summary.estimationId, "missing")}`);
    lines.push(`transferId: ${asString(summary.transferId, "missing")}`);
    const cap = asObject(summary.cardTransferCapability);
    if (cap) {
      lines.push(
        `cardTransferCapability: ${asString(cap.status, "Unknown")}${
          asString(cap.reason) ? ` (${asString(cap.reason)})` : ""
        }`,
      );
    }
  }
  return withBalancesAndSteps(lines, payload);
};

export const buildPushRecipientSummary = (payload: unknown): string => {
  const root = asObject(payload);
  if (!root) return "No recipient creation response.";
  const summary = asObject(root.summary);
  const lines: string[] = [];
  lines.push(`ok: ${root.ok === true ? "yes" : "no"}`);
  lines.push(
    `result: ${
      root.ok === true ? "Recipient is ready for push-to-card." : "Recipient creation failed."
    }`,
  );
  lines.push(`externalCardId: ${asString(root.externalCardId, "missing")}`);
  if (summary) {
    lines.push(`reason: ${asString(summary.reason, "n/a")}`);
    lines.push(`cardLast4: ${asString(summary.cardLast4, "n/a")}`);
    lines.push(`createdExternalCardId: ${asString(summary.createdExternalCardId, "missing")}`);
    lines.push(`resolvedExternalCardId: ${asString(summary.resolvedExternalCardId, "missing")}`);
  }
  const stepLines = buildStepSummary(payload);
  if (stepLines.length) {
    lines.push("");
    lines.push(...stepLines);
  }
  return lines.join("\n");
};

export const buildPushMintSummary = (payload: unknown): string => {
  const root = asObject(payload);
  if (!root) return "No sandbox mint response.";
  const summary = asObject(root.summary);
  const wallet = readSnapshotWallet(payload);
  const onchainBefore = readSnapshotBalanceValue(payload, "onchainBalanceBeforeMint");
  const onchainAfter = readSnapshotBalanceValue(payload, "onchainBalanceAfterMint");
  const lines: string[] = [];
  lines.push(`ok: ${root.ok === true ? "yes" : "no"}`);
  lines.push(`amount: ${String(root.amount ?? "unknown")} ${asString(root.currency, "")}`.trim());
  lines.push(`selectedToken: ${asString(root.selectedTokenAddress, "missing")}`);
  if (summary) {
    lines.push(`reason: ${asString(summary.reason, "n/a")}`);
    lines.push(`walletAddress: ${asString(summary.walletAddress, "missing")}`);
    lines.push(`observedBalance: ${String(summary.observedBalance ?? "unknown")}`);
    lines.push(
      `result: ${
        summary.wirexBalanceSynced === true
          ? "Wirex balance is funded and ready."
          : summary.onchainBalanceIncreased === true
            ? "Token was minted onchain, but Wirex balance is still zero."
            : "Mint was accepted, but balance did not change."
      }`,
    );
    if (summary.explorerUrl) {
      lines.push(`explorerUrl: ${asString(summary.explorerUrl, "missing")}`);
    }
  }
  if (wallet) {
    lines.push(`wirexWallet: ${asString(wallet.wallet_address, "missing")}`);
  }
  if (onchainBefore) {
    lines.push(`onchainBefore: ${asString(onchainBefore.balance, "unknown")}`);
  }
  if (onchainAfter) {
    lines.push(`onchainAfter: ${asString(onchainAfter.balance, "unknown")}`);
  }
  return withBalancesAndSteps(lines, payload);
};

export const buildPushFlowSummary = (payload: unknown): string => {
  const root = asObject(payload);
  if (!root) return "No full push demo response.";
  const summary = asObject(root.summary);
  const recipient = readOperation(payload, "recipient");
  const mint = readOperation(payload, "mint");
  const push = readOperation(payload, "push");
  const wallet = readSnapshotWallet(payload);
  const lines: string[] = [];

  lines.push(`ok: ${root.ok === true ? "yes" : "no"}`);
  lines.push(
    `result: ${
      root.ok === true
        ? "Full sandbox push demo completed successfully."
        : summary?.reason === "funded_onchain_waiting_for_wirex_balance"
          ? "Sandbox token reached the smart wallet, but Wirex balance is still zero."
          : "Full sandbox push demo is blocked. See the step list below."
    }`,
  );
  lines.push(`externalCardId: ${asString(root.externalCardId, "missing")}`);
  lines.push(`amount: ${String(root.amount ?? "unknown")} ${asString(root.currency, "")}`.trim());
  lines.push(`selectedToken: ${asString(root.selectedTokenAddress, "missing")}`);
  if (wallet) {
    lines.push(`wirexWallet: ${asString(wallet.wallet_address, "missing")}`);
  }
  if (summary) {
    lines.push(`reason: ${asString(summary.reason, "n/a")}`);
    lines.push(`executeRequested: ${summary.executeRequested === true ? "yes" : "no"}`);
    lines.push(`recipientReady: ${summary.recipientReady === true ? "yes" : "no"}`);
    lines.push(`fundsMinted: ${summary.fundsMinted === true ? "yes" : "no"}`);
    lines.push(`wirexBalanceSynced: ${summary.wirexBalanceSynced === true ? "yes" : "no"}`);
    lines.push(
      `onchainBalanceIncreased: ${summary.onchainBalanceIncreased === true ? "yes" : "no"}`,
    );
    lines.push(`estimationId: ${asString(summary.estimationId, "missing")}`);
    lines.push(`transferId: ${asString(summary.transferId, "missing")}`);
    if (summary.explorerUrl) {
      lines.push(`explorerUrl: ${asString(summary.explorerUrl, "missing")}`);
    }
  }

  if (recipient) {
    lines.push("");
    lines.push("recipient:");
    lines.push(`ok: ${recipient.ok === true ? "yes" : "no"}`);
    lines.push(`externalCardId: ${asString(recipient.externalCardId, "missing")}`);
  }
  if (mint) {
    lines.push("");
    lines.push("mint:");
    lines.push(`ok: ${mint.ok === true ? "yes" : "no"}`);
    lines.push(`selectedToken: ${asString(mint.selectedTokenAddress, "missing")}`);
    lines.push(`reason: ${asString(asObject(mint.summary)?.reason, "n/a")}`);
  }
  if (push) {
    lines.push("");
    lines.push("push:");
    lines.push(`ok: ${push.ok === true ? "yes" : "no"}`);
    lines.push(`transferId: ${asString(asObject(push.summary)?.transferId, "missing")}`);
  }

  return withBalancesAndSteps(lines, payload);
};

export const buildAaSponsoredSendSummary = (payload: unknown): string => {
  const root = asObject(payload);
  if (!root) return "No sponsored AA transfer response.";
  const readiness = asObject(root.readiness);
  const lines: string[] = [];

  lines.push(`ok: ${root.ok === true ? "yes" : "no"}`);
  lines.push(`eoa: ${asString(root.eoaAddress, "missing")}`);
  lines.push(`aa: ${asString(root.kernelAddress, "missing")}`);
  lines.push(`recipient: ${asString(root.recipientAddress, "missing")}`);
  lines.push(
    `token: ${asString(root.tokenSymbol, "unknown")} | ${asString(root.tokenAddress, "missing")}`,
  );
  lines.push(`amount: ${asString(root.amount, "unknown")}`);
  lines.push(`rawAmount: ${asString(root.rawAmount, "missing")}`);
  lines.push(`sponsorshipMode: ${asString(root.sponsorshipMode, "missing")}`);
  lines.push(`paymaster: ${asString(root.paymasterAddressUsed, "missing")}`);
  lines.push(`userOperationHash: ${asString(root.userOperationHash, "missing")}`);
  lines.push(`transactionHash: ${asString(root.transactionHash, "missing")}`);
  lines.push(`kernelTokenBalanceBefore: ${asString(root.kernelTokenBalanceBefore, "missing")}`);
  lines.push(`kernelTokenBalanceAfter: ${asString(root.kernelTokenBalanceAfter, "missing")}`);
  lines.push(
    `recipientTokenBalanceBefore: ${asString(root.recipientTokenBalanceBefore, "missing")}`,
  );
  lines.push(`recipientTokenBalanceAfter: ${asString(root.recipientTokenBalanceAfter, "missing")}`);

  if (readiness) {
    lines.push("");
    lines.push("readiness:");
    lines.push(`kernelDeployed: ${readiness.kernelDeployed === true ? "yes" : "no"}`);
    lines.push(
      `fundsManagementInstalled: ${readiness.fundsManagementInstalled === true ? "yes" : "no"}`,
    );
    lines.push(`weightedInitialized: ${readiness.weightedInitialized === true ? "yes" : "no"}`);
    lines.push(`weightedSignerCount: ${String(readiness.weightedSignerCount ?? "0")}`);
    lines.push(`weightedThreshold: ${String(readiness.weightedThreshold ?? "0")}`);
    lines.push(`weightedDelay: ${String(readiness.weightedDelay ?? "0")}`);
    lines.push(`kernelBalanceEth: ${asString(readiness.kernelBalanceEth, "missing")}`);
  }

  return lines.join("\n");
};

export const buildWirexRunAllSummary = (steps: WirexDebugRunnerStepResult[]): string => {
  if (!steps.length) return "No run-all steps executed yet.";

  const lines = ["Wirex chronological run-all"];
  for (const step of steps) {
    lines.push(`${step.title}: ${step.status}${step.note ? ` | ${step.note}` : ""}`);
  }
  const finalStep = steps[steps.length - 1];
  lines.push("");
  lines.push(
    `result: ${finalStep?.status === "ok" ? "completed" : finalStep?.status || "unknown"}`,
  );
  return lines.join("\n");
};
