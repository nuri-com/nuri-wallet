import { getAuthData, storeAuthData } from "../../lib/secureKeyStorage";

export const V1_WALLET_MIGRATION_OLD_CREDENTIAL_ID_KEY = "v1_wallet_migration_old_credential_id";

const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function preserveV1WalletMigrationOldCredentialId(
  credentialId: string,
): Promise<void> {
  const normalized = credentialId.trim();
  if (!CREDENTIAL_ID_PATTERN.test(normalized)) {
    throw new Error("Invalid legacy passkey credential ID");
  }
  await storeAuthData(V1_WALLET_MIGRATION_OLD_CREDENTIAL_ID_KEY, normalized);
}

export async function getV1WalletMigrationOldCredentialId(): Promise<string | null> {
  const stored = (await getAuthData(V1_WALLET_MIGRATION_OLD_CREDENTIAL_ID_KEY))?.trim() ?? "";
  return CREDENTIAL_ID_PATTERN.test(stored) ? stored : null;
}
