/**
 * A nuri username → the rails that can pay it.
 *
 * The directory is already public: `<username>.nuri.eth` resolves through the
 * arkade CCIP-Read gateway, which serves four text records — lightning, evm,
 * arkade, btc — signed off an offchain resolver on mainnet. Nothing here talks
 * to the arkade server directly, and nothing here needs a session: the pay page
 * is opened by strangers.
 *
 * The records are read by NAME, never enumerated. Offchain records emit no
 * onchain events, so the ENS subgraph (and therefore the ENS web app) lists none
 * of them — "0 text records" there is an indexing artefact, not an empty
 * profile. Asking for the key returns the value.
 *
 * The gateway answers only DIRECT subnames of the parent domain, so
 * `<username>.<parent>` is the only shape built here.
 */

import { ethers } from "ethers";
import { ENS_PARENT_DOMAIN } from "../../config/constants";
import { withFallback } from "../rpc/chainRpc";

/** ENS lives on Ethereum mainnet; the resolved rails are usable anywhere. */
const ENS_CHAIN_ID = 1;

/** The keys the nuri gateway serves (`src/ArkadeEnsGateway.js`). */
const TEXT_KEYS = {
  lightningAddress: "com.nuri.lightning",
  evmAddress: "com.nuri.evm",
  arkadeAddress: "com.nuri.arkade",
  btcAddress: "com.nuri.btc",
  onchainAddress: "com.nuri.btc.onchain",
} as const;

export type PayRecipient = {
  username: string;
  /** LUD-16 address, e.g. `alice@nuri.com`. */
  lightningAddress: string | null;
  /** One address, valid on every EVM chain the recipient's account spans. */
  evmAddress: string | null;
  arkadeAddress: string | null;
  /** Bitcoin boarding address (P2TR). */
  btcAddress: string | null;
  /** Co-signed onchain wallet address (MuSig2+CSV); null for users without one. */
  onchainAddress: string | null;
};

/**
 * ENSIP-10 wildcard resolution. The gateway's resolver implements
 * `resolve(name, data)` only, so the inner `text(node, key)` call is encoded by
 * hand and the answer decoded from the wrapper — a direct `text()` call to the
 * resolver reverts.
 */
const INNER = new ethers.Interface(["function text(bytes32,string) view returns (string)"]);
const OUTER = new ethers.Interface(["function resolve(bytes,bytes) view returns (bytes)"]);

/**
 * EIP-3668, walked by hand instead of through `enableCcipRead`.
 *
 * ethers' own CCIP client fetches the gateway with its `FetchRequest`, which
 * comes back with an empty body in the app's web bundle — ethers then reports
 * the read as `OFFCHAIN_FAULT / 500_SERVER_ERROR` and every registered user
 * looks unpayable. The same URL fetched with the platform `fetch` returns the
 * answer, so the gateway call is made here and only the two `eth_call`s are left
 * to ethers.
 *
 * This is not a shortcut past verification: the gateway's answer is handed back
 * to the resolver's own callback on-chain, which checks the signature over it.
 * An answer the resolver rejects reverts the second call and resolves nothing.
 */
const OFFCHAIN_LOOKUP = new ethers.Interface([
  "error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)",
]);

const cache = new Map<string, PayRecipient | null>();

function cleaned(value: string): string | null {
  const trimmed = String(value || "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The gateway's signed answer for one offchain lookup. */
async function fetchOffchainAnswer(
  urls: readonly string[],
  sender: string,
  callData: string,
): Promise<string> {
  let lastError: unknown = null;
  for (const template of urls) {
    const href = template
      .replace("{sender}", sender.toLowerCase())
      .replace("{data}", callData.toLowerCase());
    try {
      const response = template.includes("{data}")
        ? await fetch(href)
        : await fetch(href, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ data: callData.toLowerCase(), sender: sender.toLowerCase() }),
          });
      const text = await response.text();
      if (!response.ok) {
        lastError = new Error(`gateway ${response.status} at ${href}: ${text.slice(0, 80)}`);
        continue;
      }
      let body: { data?: string } | null = null;
      try {
        body = JSON.parse(text) as { data?: string };
      } catch {
        // Not JSON: something between us and the gateway answered instead of it.
        lastError = new Error(`gateway answered non-JSON at ${href}: ${text.slice(0, 80)}`);
        continue;
      }
      if (typeof body?.data === "string" && body.data.startsWith("0x")) return body.data;
      lastError = new Error("gateway answered without data");
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("offchain lookup failed");
}

/**
 * One `eth_call` that follows an OffchainLookup revert to its gateway and back.
 * A call that does not revert that way is returned as-is.
 */
async function callThroughGateway(
  provider: ethers.JsonRpcProvider,
  to: string,
  data: string,
): Promise<string> {
  try {
    return await provider.call({ to, data, enableCcipRead: false });
  } catch (error) {
    const revert = (error as { data?: unknown })?.data;
    if (typeof revert !== "string") throw error;
    const parsed = OFFCHAIN_LOOKUP.parseError(revert);
    if (parsed?.name !== "OffchainLookup") throw error;

    const [sender, urls, callData, callbackFunction, extraData] = parsed.args as unknown as [
      string,
      string[],
      string,
      string,
      string,
    ];
    const answer = await fetchOffchainAnswer(urls, sender, callData);
    const callback = ethers.concat([
      callbackFunction,
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes"], [answer, extraData]),
    ]);
    return await provider.call({ to: sender, data: callback, enableCcipRead: false });
  }
}

/**
 * Resolves a username to its rails, or null when the name carries none (an
 * unregistered username answers every key with an empty string).
 *
 * Throws only when every RPC is unreachable. Callers must keep "no such user"
 * (null) and "we could not check" (throw) apart: showing an outage as an unknown
 * username sends the payer away from a link that is perfectly valid.
 */
export async function resolvePayRecipient(username: string): Promise<PayRecipient | null> {
  const normalized = String(username || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;

  const cached = cache.get(normalized);
  if (cached !== undefined) return cached;

  const name = `${normalized}.${ENS_PARENT_DOMAIN}`;
  const node = ethers.namehash(name);
  const dnsName = ethers.dnsEncode(name, 255);

  const recipient = await withFallback(ENS_CHAIN_ID, async (provider) => {
    const resolver = await provider.getResolver(name);
    if (!resolver) return null;

    // One key at a time, NOT Promise.all: four concurrent lookups make the
    // gateway answer some of them with a 500, which turns a registered user into
    // "cannot be paid". Four sequential round-trips is the cost of four answers.
    const entries: Array<readonly [string, string | null]> = [];
    for (const [field, key] of Object.entries(TEXT_KEYS)) {
      const wrapped = await callThroughGateway(
        provider,
        resolver.address,
        OUTER.encodeFunctionData("resolve", [
          dnsName,
          INNER.encodeFunctionData("text", [node, key]),
        ]),
      );
      const [inner] = OUTER.decodeFunctionResult("resolve", wrapped);
      const [value] = INNER.decodeFunctionResult("text", inner);
      entries.push([field, cleaned(String(value ?? ""))] as const);
    }

    const rails = Object.fromEntries(entries) as Omit<PayRecipient, "username">;
    const hasAnyRail = Object.values(rails).some((value) => value !== null);
    return hasAnyRail ? { username: normalized, ...rails } : null;
  });

  cache.set(normalized, recipient);
  return recipient;
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function resetPayRecipientCache(): void {
  cache.clear();
}
