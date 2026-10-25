// Committing the wallet identity after a passkey ceremony.
//
// One rule, and it is the whole point of this module: a restore that ends on a
// different passkey than the one this device held must leave NOTHING of the old
// wallet behind before anything of the new one is written. The old wallet's
// address history is the last identity-bearing residue, and its deletion is
// verified by reading storage back, so a cleanup that fails to take effect is a
// hard stop: no new credential metadata, no new key material, and the device
// stays on the old identity so the next attempt retries the switch.
//
// Callers get one of four outcomes and must treat "aborted" as fatal for the
// ceremony: show the retryable error and persist nothing.

export type RestoreIdentityCommitDeps = {
  getPreviousCredentialId: () => string;
  clearPreviousAddresses: () => Promise<void>;
  replaceIdentity: (
    credId: string,
    credPubkey?: string,
    clientPk33?: string,
  ) => Promise<{ ok: boolean; reason?: string }>;
  upsertMetadata: (
    credId: string,
    credPubkey?: string,
    clientPk33?: string,
  ) => Promise<{ ok: boolean; reason?: string }>;
};

export type RestoreIdentityCommitResult =
  | { kind: "skipped" }
  // metadataError is surfaced, never fatal: the credential is unchanged, so a
  // failed merge cannot pair one identity with another.
  | { kind: "same"; metadataError?: unknown }
  | { kind: "replaced" }
  | { kind: "aborted"; stage: "cleanup" | "replace"; error: unknown };

export async function commitRestoreIdentity(
  deps: RestoreIdentityCommitDeps,
  next: { credIdB64u?: string; credPubkeyB64u?: string; clientPk33?: string },
): Promise<RestoreIdentityCommitResult> {
  const nextCredId = String(next.credIdB64u || "").trim();
  if (!nextCredId) return { kind: "skipped" };

  const previousCredId = String(deps.getPreviousCredentialId() || "").trim();
  if (!previousCredId || previousCredId === nextCredId) {
    // Same identity: the merge is correct here, and it is not fatal because no
    // second identity can be paired with it.
    try {
      await deps.upsertMetadata(nextCredId, next.credPubkeyB64u, next.clientPk33);
    } catch (metadataError) {
      return { kind: "same", metadataError };
    }
    return { kind: "same" };
  }

  try {
    await deps.clearPreviousAddresses();
  } catch (error) {
    return { kind: "aborted", stage: "cleanup", error };
  }

  try {
    const replaced = await deps.replaceIdentity(nextCredId, next.credPubkeyB64u, next.clientPk33);
    if (!replaced.ok) {
      return {
        kind: "aborted",
        stage: "replace",
        error: new Error(replaced.reason || "identity_replace_failed"),
      };
    }
  } catch (error) {
    return { kind: "aborted", stage: "replace", error };
  }

  return { kind: "replaced" };
}
