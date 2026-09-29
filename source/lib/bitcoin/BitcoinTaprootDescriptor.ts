// WP3: Taproot Descriptor Builder
// Builds Bitcoin Taproot descriptors with MuSig2 key-path and CSV recovery script-path

/**
 * Creates a Taproot descriptor string for the wallet's spending policy
 * Key-path: MuSig2 aggregated key (A+C) for normal operations
 * Script-path: A-key only after CSV timelock for recovery
 *
 * CRITICAL: For tapscript leaves, pk() uses x-only keys (32 bytes)
 * not compressed keys (33 bytes) per BIP341.
 *
 * @param internalXOnlyHex - 64-char hex of internal key (x-only)
 * @param leafCompressedHex - 66-char hex of compressed pubkey (we'll convert to x-only)
 * @param csvBlocks - Number of blocks for CSV timelock (3 test, 12960 prod)
 * @returns Object with external and internal descriptor strings (identical)
 */
export function buildBitcoinTaprootDescriptor(
  internalXOnlyHex: string,
  leafCompressedHex: string,
  csvBlocks: number,
): { external: string; internal: string } {
  // 6.a: Normalize inputs
  const xOnly = internalXOnlyHex.trim().toLowerCase();
  const leaf = leafCompressedHex.trim().toLowerCase();

  // 13.a: Validate internalXOnlyHex is exactly 64 hex chars (x-only)
  if (!/^[0-9a-f]{64}$/.test(xOnly)) {
    throw new Error(
      `Invalid internalXOnlyHex: must be exactly 64 hex chars, got ${xOnly.length} chars`,
    );
  }

  // 13.b: Validate leafCompressedHex is exactly 66 hex chars (compressed)
  if (!/^(02|03)[0-9a-f]{64}$/.test(leaf)) {
    throw new Error(
      `Invalid leafCompressedHex: must be 66 hex chars starting with 02/03, got ${leaf.length} chars`,
    );
  }

  // CRITICAL: Convert compressed key to x-only for tapscript (BIP341)
  const leafXOnlyHex = leaf.slice(2); // Remove 02/03 prefix

  // 13.c: Validate csvBlocks is a positive integer
  if (!Number.isInteger(csvBlocks) || csvBlocks <= 0) {
    throw new Error(`Invalid csvBlocks: must be a positive integer, got ${csvBlocks}`);
  }

  // 7: Build whitespace-free descriptor with X-ONLY key in the leaf (BIP341 requirement)
  // CRITICAL: Use x-only key (32 bytes) not compressed (33 bytes) for tapscript
  const descriptor = `tr(${xOnly},and_v(v:pk(${leafXOnlyHex}),older(${csvBlocks})))`;

  // 13.d: Validate descriptor format
  const startsWithTr = descriptor.startsWith("tr(");
  const hasNoSpaces = !descriptor.includes(" ");
  const validationOk = startsWithTr && hasNoSpaces;

  // 12.b & 12.c: compact one-line audit log
  console.log(
    `[TaprootDescriptor] ok=${validationOk} noSpaces=${hasNoSpaces} csv=${csvBlocks} internal=${internalXOnlyHex.slice(0, 8)}… leaf=${leafXOnlyHex.slice(0, 8)}…`,
  );

  // Both external and internal use the same policy
  const result = {
    external: descriptor,
    internal: descriptor,
  };

  return result;
}
