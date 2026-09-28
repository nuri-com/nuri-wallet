import { beforeEach, describe, expect, it, vi } from "vitest";

const CLIENT_PK33 = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const SERVER_PK33 = "03c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const ARKADE_CSV = { type: "seconds", value: 6674432 } as const;

let walletPublicKeys: { userExternal?: string; walletPasskeyCredIdB64u?: string } | null = null;
let cachedContext: Record<string, unknown> | null = null;
let liveContext: Record<string, unknown> | null = null;
let liveContextError: Error | null = null;
let cachedAddress: string | null = null;

const getSigningPublicContext = vi.fn(async () => {
  if (liveContextError) throw liveContextError;
  return liveContext;
});

vi.mock("../auth/AuthStateService", () => ({
  authStateManager: { getState: () => ({ walletPublicKeys }) },
}));
vi.mock("../arkade/internal/identity", () => ({
  getCachedArkadeIdentity: () =>
    cachedContext ? { getCachedSigningPublicContext: () => cachedContext } : null,
  getOrCreateArkadeIdentity: async () => ({ getSigningPublicContext }),
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getMusig2AddressCache: async () => cachedAddress,
}));
vi.mock("./WalletService", () => ({ toDerivationNetwork: () => "main" }));
vi.mock("../../lib/OperationLogUtils", () => ({
  logWithId: () => {},
  LOG_EMOJI: { bitcoin: "₿" },
}));

const { aggregatedPXOnlyHex } = await import("../../lib/musig2Agg");
const { deriveMusig2CsvAddress } = await import("../../lib/bitcoin/deriveMusig2CsvAddress");
const { bip68SequenceFromTimelock } = await import("../../lib/bitcoin/csv");
const { hexToBytes } = await import("../../lib/bytes");
const { resolveArkadeMusig2WalletKeys } = await import("./Musig2WalletKeys");

const AGGREGATED = aggregatedPXOnlyHex(hexToBytes(CLIENT_PK33), hexToBytes(SERVER_PK33));
const ARKADE_ADDRESS = deriveMusig2CsvAddress({
  aggregatedXonly32: AGGREGATED,
  userCompressed: CLIENT_PK33,
  csvSequence: bip68SequenceFromTimelock(ARKADE_CSV),
  network: "main",
}).address;

function arkadeContext(nuriServerCsv: unknown): Record<string, unknown> {
  return {
    clientPk33: CLIENT_PK33,
    serverPk33: SERVER_PK33,
    aggregatedPk33: `02${AGGREGATED}`,
    aggregatedXonly32: AGGREGATED,
    nuriServerCsv,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  walletPublicKeys = { userExternal: CLIENT_PK33, walletPasskeyCredIdB64u: "cred-1" };
  cachedContext = null;
  liveContext = arkadeContext(ARKADE_CSV);
  liveContextError = null;
  cachedAddress = null;
});

describe("resolveArkadeMusig2WalletKeys", () => {
  it("escalates to the authenticated context when cached context has no timelock", async () => {
    cachedContext = arkadeContext(null);
    const keys = await resolveArkadeMusig2WalletKeys();
    expect(getSigningPublicContext).toHaveBeenCalledTimes(1);
    expect(keys).toEqual({
      credId: "cred-1",
      userCompressed: CLIENT_PK33,
      aggregatedXonly32: AGGREGATED,
      csvTimelock: ARKADE_CSV,
    });
  });

  it("serves a warm cached timelock without a round-trip", async () => {
    cachedContext = arkadeContext(ARKADE_CSV);
    const keys = await resolveArkadeMusig2WalletKeys();
    expect(getSigningPublicContext).not.toHaveBeenCalled();
    expect(keys?.csvTimelock).toEqual(ARKADE_CSV);
  });

  it("falls back only when the default reproduces the cached address", async () => {
    cachedContext = arkadeContext(null);
    liveContextError = new Error("signer unreachable");
    cachedAddress = ARKADE_ADDRESS;
    expect((await resolveArkadeMusig2WalletKeys())?.csvTimelock).toEqual(ARKADE_CSV);
  });

  it("publishes nothing when no source confirms the timelock", async () => {
    cachedContext = arkadeContext(null);
    liveContextError = new Error("signer unreachable");
    expect(await resolveArkadeMusig2WalletKeys()).toBeNull();
  });
});
