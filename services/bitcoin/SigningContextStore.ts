// In-memory ephemeral context store for setup and signing flows
// Do NOT persist across launches; used to bridge between screens and deep-link handlers.

import { zeroize } from "../../lib/crypto";

type SetupContext = { skApp: Uint8Array };
type SigningContext = {
  psbtB64: string;
  inputIndex: number;
  msg32: string;
  pAgg?: string; // P (internal key)
  qAgg: string; // Q (output key)
  tweak32: string;
  aXOnly: string;
  aCompressed?: string; // Compressed pubkey (33 bytes)
  clientSecretNonce: Uint8Array; // Full 97-byte secret nonce from musig2.nonceGen()
  clientPubNonce: string;
  skApp: Uint8Array;
  csvBlocks?: number; // CSV timelock value (3 for external, 4 for internal)
  secretKey?: Uint8Array; // Optional, fetched with Face ID when needed
  request_id?: string; // Request ID for correlation
  btcSend?: {
    psbtB64: string;
    requestId: string;
    amountBtc?: string;
    toAddress?: string;
    origin: "bitcoin";
    inputs: Array<{
      inputIndex: number;
      msg32: string;
      tweak32: string;
      pAgg: string;
      qAgg: string;
      aXOnly: string;
      clientPk33: string;
      serverPk33: string;
      clientSecretNonce: Uint8Array;
      clientPubNonce: string;
      csvBlocks: number;
    }>;
    signedIndices?: number[];
  };
};

const setupContexts = new Map<string, SetupContext>();
const signingContexts = new Map<string, SigningContext>();

function tryZeroize(value: unknown): void {
  if (!(value instanceof Uint8Array)) return;
  try {
    zeroize(value);
  } catch {}
}

export function setSetupContext(state: string, ctx: SetupContext) {
  setupContexts.set(state, ctx);
}

export function getSetupContext(state: string): SetupContext | undefined {
  return setupContexts.get(state);
}

export function deleteSetupContext(state: string) {
  setupContexts.delete(state);
}

export function listSetupStates(): string[] {
  return Array.from(setupContexts.keys());
}

export function setSigningContext(state: string, ctx: SigningContext) {
  signingContexts.set(state, ctx);
}

export function getSigningContext(state: string): SigningContext | undefined {
  return signingContexts.get(state);
}

export function deleteSigningContext(state: string) {
  signingContexts.delete(state);
}

// Debug function to list all contexts
export function debugListContexts() {
  console.log("[ContextStore] Setup contexts:", Array.from(setupContexts.keys()));
  console.log("[ContextStore] Signing contexts:", Array.from(signingContexts.keys()));
}

export function listSigningStates(): string[] {
  return Array.from(signingContexts.keys());
}

export function clearAllContexts(): void {
  for (const ctx of setupContexts.values()) {
    tryZeroize(ctx?.skApp);
  }
  setupContexts.clear();

  for (const ctx of signingContexts.values()) {
    tryZeroize(ctx?.clientSecretNonce);
    tryZeroize(ctx?.skApp);
    tryZeroize(ctx?.secretKey);
    const btcInputs = ctx.btcSend?.inputs;
    if (btcInputs?.length) {
      for (const input of btcInputs) {
        tryZeroize(input?.clientSecretNonce);
      }
    }
  }
  signingContexts.clear();
}
