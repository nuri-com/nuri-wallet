import * as btc from "@scure/btc-signer";
import * as musig2 from "@scure/btc-signer/musig2.js";
import { Script } from "@scure/btc-signer/script.js";
import { Point } from "@noble/secp256k1";
import {
  type PartialSig,
  type SignerSession,
  type TreeNonces,
  type TreePartialSigs,
  type TxTree,
  CosignerPublicKey,
  getArkPsbtFields,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { bytesToHex, hexToBytes } from "../../lib/bytes";
import { sha256, zeroize } from "../../lib/crypto";
import { errMsg } from "../../lib/errorMessage";
import { shortTime } from "../../lib/logShared";
import { ArkadeRemoteIdentity } from "./ArkadeRemoteIdentity";
import { getPendingBatchCommitmentTx } from "./internal/batchCommitment";

// musig2.Session marks Q/gAcc/e/b/R/getSessionKeyAggCoeff as private in @scure/btc-signer's
// type declarations, but our split-key remote-signing flow needs to read them. Casting
// through unknown to a precise structural shape — no `any` — pending discussion with Emin
// on whether to drop this access entirely (use Arkade's TreeSignerSession or reimplement
// the math against @noble/secp256k1).
type Musig2Session = {
  Q: { y: bigint };
  gAcc: bigint;
  e: bigint;
  b: bigint;
  R: { y: bigint };
  getSessionKeyAggCoeff(P: Point): bigint;
  partialSigVerify(partialSig: Uint8Array, pubNonces: Uint8Array[], i: number): boolean;
};

const NOT_INITIALIZED = new Error("Arkade signer session not initialized");
const TAP_TWEAK_TAG = sha256(new TextEncoder().encode("TapTweak"));

type TxNodeLike = {
  txid: string;
  root: btc.Transaction;
};

type TxState = {
  txid: string;
  cosignerPk33: string;
  msg32: Uint8Array;
  tweak32: Uint8Array;
  outerCosignerPk33List: string[];
  clientPubNonce66: string;
  clientSecNonce97: Uint8Array;
  serverPubNonce66: string;
  outerPubNonce66: Uint8Array;
  outerNonceByPk33: Map<string, Uint8Array>;
};

const SECP256K1_N = Point.CURVE().n;

function computeTapTweak(preTweakedXonly32: Uint8Array, tapMerkleRoot: Uint8Array): Uint8Array {
  const preimage = new Uint8Array([...preTweakedXonly32, ...tapMerkleRoot]);
  return sha256(new Uint8Array([...TAP_TWEAK_TAG, ...TAP_TWEAK_TAG, ...preimage]));
}

function modN(value: bigint): bigint {
  const mod = value % SECP256K1_N;
  return mod >= 0n ? mod : mod + SECP256K1_N;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  const hexValue = bytesToHex(bytes);
  return BigInt(`0x${hexValue || "0"}`);
}

function bigIntTo32Bytes(value: bigint): Uint8Array {
  const normalized = modN(value).toString(16).padStart(64, "0");
  return hexToBytes(normalized);
}

function evenScalar(point: { y: bigint }, value: bigint): bigint {
  return (point.y & 1n) === 0n ? modN(value) : modN(-value);
}

function decodeSecretNonce97(secretNonce97: Uint8Array): {
  k1: bigint;
  k2: bigint;
  publicKey33: Uint8Array;
} {
  if (!(secretNonce97 instanceof Uint8Array) || secretNonce97.length !== 97) {
    throw new Error("invalid secret nonce length");
  }
  const k1 = bytesToBigInt(secretNonce97.subarray(0, 32));
  const k2 = bytesToBigInt(secretNonce97.subarray(32, 64));
  const publicKey33 = new Uint8Array(secretNonce97.subarray(64, 97));
  return { k1, k2, publicKey33 };
}

function computeNestedClientOuterPartial(params: {
  clientPriv32: Uint8Array;
  clientSecNonce97: Uint8Array;
  clientPk33: string;
  serverPk33: string;
  cosignerPk33: string;
  outerCosignerPk33List: string[];
  outerAggregateNonce66: Uint8Array;
  outerTweak32: Uint8Array;
  msg32: Uint8Array;
}): Uint8Array {
  const {
    clientPriv32,
    clientSecNonce97,
    clientPk33,
    serverPk33,
    cosignerPk33,
    outerCosignerPk33List,
    outerAggregateNonce66,
    outerTweak32,
    msg32,
  } = params;

  const outerKeys = musig2.sortKeys(outerCosignerPk33List.map((pk) => hexToBytes(pk)));
  const outerSession = new musig2.Session(
    outerAggregateNonce66,
    outerKeys,
    msg32,
    outerTweak32.length > 0 ? [outerTweak32] : [],
    outerTweak32.length > 0 ? [true] : [],
  ) as unknown as Musig2Session;
  const innerKeys = musig2.sortKeys([hexToBytes(clientPk33), hexToBytes(serverPk33)]);
  const innerSession = new musig2.Session(
    outerAggregateNonce66,
    innerKeys,
    msg32,
  ) as unknown as Musig2Session;

  const outerCoeff = outerSession.getSessionKeyAggCoeff(Point.fromBytes(hexToBytes(cosignerPk33)));
  const clientCoeff = innerSession.getSessionKeyAggCoeff(Point.fromBytes(hexToBytes(clientPk33)));
  const outerGlobal = modN(evenScalar(outerSession.Q, 1n) * BigInt(outerSession.gAcc));

  const decodedNonce = decodeSecretNonce97(clientSecNonce97);
  const expectedPk = clientPk33.toLowerCase();
  const noncePk = bytesToHex(decodedNonce.publicKey33).toLowerCase();
  if (noncePk !== expectedPk) {
    throw new Error("client secret nonce key mismatch");
  }

  const k1 = evenScalar(outerSession.R, decodedNonce.k1);
  const k2 = evenScalar(outerSession.R, decodedNonce.k2);
  const clientSecret = bytesToBigInt(clientPriv32);

  const factor = modN(BigInt(outerSession.e) * outerCoeff * outerGlobal);
  const nonceTerm = modN(k1 + modN(BigInt(outerSession.b) * k2));
  const secretTerm = modN(factor * clientCoeff * clientSecret);
  return bigIntTo32Bytes(modN(nonceTerm + secretTerm));
}

function addPartialSigs32(a32: Uint8Array, b32: Uint8Array): Uint8Array {
  if (a32.length !== 32 || b32.length !== 32) {
    throw new Error("partial sig must be 32 bytes");
  }
  return bigIntTo32Bytes(bytesToBigInt(a32) + bytesToBigInt(b32));
}

function formatNonceEntriesForLog(
  outerKeys: Uint8Array[],
  nonceByPk33: Map<string, Uint8Array>,
): string {
  return outerKeys
    .map((pk) => {
      const keyHex = bytesToHex(pk).toLowerCase();
      const nonce = nonceByPk33.get(keyHex);
      return `${keyHex}:${nonce ? bytesToHex(nonce).toLowerCase() : "missing"}`;
    })
    .join(",");
}

function shortRef(value: string, head = 8, tail = 4): string {
  const raw = String(value || "").trim();
  if (!raw) return "n/a";
  if (raw.length <= head + tail + 3) return raw;
  return `${raw.slice(0, head)}...${raw.slice(-tail)}`;
}

function shortError(error: unknown, max = 140): string {
  const raw = errMsg(error, "unknown").replace(/\s+/g, " ").trim();
  if (raw.length <= max) return raw || "unknown";
  return `${raw.slice(0, Math.max(0, max - 3))}...`;
}

function makeTreePartialSig(s32: Uint8Array): PartialSig {
  const outS = new Uint8Array(s32);
  return {
    s: outS,
    R: new Uint8Array(33),
    encode() {
      return new Uint8Array(outS);
    },
  };
}

export class ArkadeRemoteSignerSession implements SignerSession {
  private initialized = false;
  private treeTxCount = 0;
  private traceTag = "n/a";
  private graph: TxTree | null = null;
  private scriptRoot: Uint8Array | null = null;
  private rootInputAmount: bigint | null = null;
  private treeSessionId: string | null = null;
  private txNodes: TxNodeLike[] = [];
  private txStates: Map<string, TxState> = new Map();
  private outerAggregateNonces: Map<string, { pubNonce: Uint8Array }> = new Map();
  private partialSigCache: TreePartialSigs | null = null;
  private cachedPriv32: Uint8Array | null = null;
  private approvalToken: string | null = null;

  constructor(private readonly identity: ArkadeRemoteIdentity) {}

  private ensureInitialized(): void {
    if (!this.initialized || !this.graph || !this.scriptRoot || this.rootInputAmount == null) {
      throw NOT_INITIALIZED;
    }
  }

  private clearCachedPriv(): void {
    if (this.cachedPriv32) {
      zeroize(this.cachedPriv32);
      this.cachedPriv32 = null;
    }
  }

  private logTree(event: string, fields: Record<string, string | number | undefined>): void {
    const parts = [`trace=${this.traceTag}`];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const normalized = String(value).trim();
      if (!normalized) continue;
      parts.push(`${key}=${normalized}`);
    }
    console.log(`🔐 [${shortTime()} ArkadeRemoteSignerSession.${event}] ${parts.join(" ")}`);
  }

  private async getCachedPriv(expectedClientPk33: string): Promise<Uint8Array> {
    if (this.cachedPriv32) {
      const cachedPk = bytesToHex(musig2.IndividualPubkey(this.cachedPriv32)).toLowerCase();
      if (cachedPk === expectedClientPk33) {
        return this.cachedPriv32;
      }
      this.clearCachedPriv();
    }

    const priv = await this.identity.getSigningKeyCopy(expectedClientPk33, "tree_signing_session");
    const clientPkFromPriv = bytesToHex(musig2.IndividualPubkey(priv)).toLowerCase();
    if (clientPkFromPriv !== expectedClientPk33) {
      zeroize(priv);
      throw new Error("client private key/public key mismatch with auth state");
    }
    this.cachedPriv32 = priv;
    this.logTree("clientKey", {
      source: "passkey_prf",
      clientPk: shortRef(expectedClientPk33, 10, 6),
    });
    return priv;
  }

  private getPrevOutput(
    finalKeyXonly32: Uint8Array,
    tx: btc.Transaction,
  ): { amount: bigint; script: Uint8Array } {
    this.ensureInitialized();
    const graph = this.graph as TxTree;

    const p2trScript = Script.encode(["OP_1", finalKeyXonly32]);
    if (tx.id === graph.txid) {
      return {
        amount: this.rootInputAmount as bigint,
        script: p2trScript,
      };
    }

    const parentInput = tx.getInput(0);
    if (!parentInput?.txid) throw new Error("missing parent input txid");
    const parentTxid = bytesToHex(parentInput.txid);
    const parent = graph.find(parentTxid);
    if (!parent) throw new Error("parent tx not found");
    if (parentInput.index == null) throw new Error("missing parent input index");
    const parentOutput = parent.root.getOutput(parentInput.index);
    if (!parentOutput?.amount) throw new Error("parent output amount not found");

    return {
      amount: parentOutput.amount as bigint,
      script: p2trScript,
    };
  }

  private getCosignerPubkeys(node: TxNodeLike): Uint8Array[] {
    return getArkPsbtFields(node.root, 0, CosignerPublicKey)
      .map((c) => c.key)
      .filter((pk): pk is Uint8Array => pk instanceof Uint8Array && pk.length === 33);
  }

  private computeMsg32(node: TxNodeLike, cosigners: Uint8Array[]): Uint8Array {
    this.ensureInitialized();

    const sortedCosigners = musig2.sortKeys(cosigners);
    const preTweakedXonly32 = musig2.keyAggExport(musig2.keyAggregate(sortedCosigners));
    const tweak32 = computeTapTweak(preTweakedXonly32, this.scriptRoot as Uint8Array);
    const finalKeyXonly32 = musig2.keyAggExport(
      musig2.keyAggregate(sortedCosigners, [tweak32], [true]),
    );

    const prevoutAmounts: bigint[] = [];
    const prevoutScripts: Uint8Array[] = [];
    for (let inputIndex = 0; inputIndex < node.root.inputsLength; inputIndex += 1) {
      const prevout = this.getPrevOutput(finalKeyXonly32, node.root);
      prevoutAmounts.push(prevout.amount);
      prevoutScripts.push(prevout.script);
    }

    return node.root.preimageWitnessV1(0, prevoutScripts, btc.SigHash.DEFAULT, prevoutAmounts);
  }

  private async ensureTreeSession(clientPk33: string): Promise<string> {
    if (this.treeSessionId) {
      this.logTree("treeSession", {
        action: "reuse",
        session: shortRef(this.treeSessionId),
        txids: this.txNodes.length,
        approval: this.approvalToken ? 1 : 0,
      });
      return this.treeSessionId;
    }

    const txids = this.txNodes
      .map((n) =>
        String(n.txid || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
    this.logTree("treeSession", {
      action: "request",
      txids: txids.length,
      approval: this.approvalToken ? 1 : 0,
      expectedNext: "server_tree_session",
    });
    if (!this.approvalToken) {
      throw new Error("Arkade tree signing requires approval token");
    }
    // The cosigner re-derives every tree message from this material and binds it
    // to the approved intent, so the round is authorized by what the batch
    // actually is rather than by what this client claims it to be.
    const out = await this.identity.requestApprovedTreeSessionInit(this.approvalToken, {
      client_pk33: clientPk33,
      txids,
      commitment_tx_b64: getPendingBatchCommitmentTx() || undefined,
      script_root: this.scriptRoot ? bytesToHex(this.scriptRoot).toLowerCase() : undefined,
      tree_nodes: this.txNodes.map((node) => ({
        tx_b64: base64.encode(node.root.toPSBT()),
      })),
    });
    this.treeSessionId = String(out?.session_id || "").trim();
    if (!this.treeSessionId) {
      throw new Error("tree session init missing session_id");
    }
    this.logTree("treeSession", {
      action: "init",
      session: shortRef(this.treeSessionId),
      txids: txids.length,
      approval: this.approvalToken ? 1 : 0,
      clientPk: shortRef(clientPk33, 10, 6),
    });
    return this.treeSessionId;
  }

  async getPublicKey(): Promise<Uint8Array> {
    const pk = await this.identity.compressedPublicKey();
    console.log(
      `🔐 [${shortTime()} ArkadeRemoteSignerSession.getPublicKey] pk=${hex.encode(pk).slice(0, 16)}...`,
    );
    return pk;
  }

  async init(tree: TxTree, scriptRoot: Uint8Array, rootInputAmount: bigint): Promise<void> {
    this.initialized = true;
    this.graph = tree;
    this.scriptRoot = new Uint8Array(scriptRoot);
    this.traceTag =
      bytesToHex(this.scriptRoot.subarray(0, Math.min(4, this.scriptRoot.length))).toLowerCase() ||
      "n/a";
    this.rootInputAmount = rootInputAmount;
    this.treeSessionId = null;
    this.txNodes = [...tree.iterator()] as TxNodeLike[];
    this.treeTxCount = this.txNodes.length;
    this.txStates.clear();
    this.outerAggregateNonces.clear();
    this.partialSigCache = null;
    this.approvalToken = null;
    this.clearCachedPriv();
    this.logTree("init", {
      initialized: 1,
      txCount: this.treeTxCount,
    });
  }

  async getNonces(): Promise<TreeNonces> {
    this.ensureInitialized();
    if (this.txStates.size === this.treeTxCount) {
      this.logTree("getNonces", {
        action: "reuse",
        txCount: this.txStates.size,
        approval: this.approvalToken ? 1 : 0,
      });
      return new Map(
        [...this.txStates.entries()].map(([txid, st]) => [txid, { pubNonce: st.outerPubNonce66 }]),
      );
    }

    const pubCtx = await this.identity.getSigningPublicContext();
    const preparedStates: Array<{
      node: TxNodeLike;
      txid: string;
      cosignerPk33: string;
      outerCosignerPk33List: string[];
      msg32: Uint8Array;
      tweak32: Uint8Array;
    }> = [];

    for (const node of this.txNodes) {
      const txid = String(node.txid || "")
        .trim()
        .toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) {
        throw new Error(`invalid tree txid ${txid || "n/a"}`);
      }

      const cosigners = this.getCosignerPubkeys(node);
      if (cosigners.length === 0) {
        throw new Error(`missing tree cosigners for txid=${txid}`);
      }
      const outerCosignerPk33List = cosigners.map((pk) => bytesToHex(pk).toLowerCase());
      const cosignerPk33 = outerCosignerPk33List.find((pk) => pk === pubCtx.aggregatedPk33);
      if (!cosignerPk33) {
        const sample = outerCosignerPk33List.map((pk) => `${pk.slice(0, 12)}...`).join(",");
        throw new Error(
          `tree cosigner mismatch txid=${txid} count=${outerCosignerPk33List.length} sample=${sample || "n/a"}`,
        );
      }

      const sortedOuterCosigners = musig2.sortKeys(cosigners);
      const outerPreTweakedXonly32 = musig2.keyAggExport(musig2.keyAggregate(sortedOuterCosigners));
      const tweak32 = computeTapTweak(outerPreTweakedXonly32, this.scriptRoot as Uint8Array);
      const msg32 = this.computeMsg32(node, cosigners);

      preparedStates.push({
        node,
        txid,
        cosignerPk33,
        outerCosignerPk33List,
        msg32,
        tweak32,
      });
    }
    this.logTree("getNonces", {
      action: "prepared",
      txCount: preparedStates.length,
      expectedNext: "reuse_settle_approval_then_session",
    });

    const previousApprovalToken = this.approvalToken;
    this.approvalToken = await this.identity.ensureOutgoingSpendApproval(
      preparedStates.map((state) => ({
        kind: "tree",
        txid: state.txid,
        msg32: bytesToHex(state.msg32).toLowerCase(),
        clientPk33: pubCtx.clientPk33,
        tweak32: bytesToHex(state.tweak32).toLowerCase(),
      })),
    );
    const approvalAction = this.approvalToken
      ? previousApprovalToken
        ? previousApprovalToken === this.approvalToken
          ? "reused"
          : "refreshed"
        : "attached"
      : "skipped";
    this.logTree("approval", {
      action: approvalAction,
      txCount: preparedStates.length,
      hadToken: previousApprovalToken ? 1 : 0,
      approval: this.approvalToken ? 1 : 0,
      expectedNext: "tree_session_init",
    });
    if (!this.approvalToken) {
      throw new Error("Arkade tree signing requires approval token");
    }

    const sessionId = await this.ensureTreeSession(pubCtx.clientPk33);
    const priv = await this.getCachedPriv(pubCtx.clientPk33);
    try {
      const out: TreeNonces = new Map();
      for (const prepared of preparedStates) {
        const { txid, cosignerPk33, outerCosignerPk33List, msg32, tweak32 } = prepared;
        if (outerCosignerPk33List.length > 1) {
          const sample = outerCosignerPk33List.map((pk) => `${pk.slice(0, 12)}...`).join(",");
          console.log(
            `🔐 [${shortTime()} ArkadeRemoteSignerSession.getNonces] txid=${txid.slice(0, 12)}... cosigners=${outerCosignerPk33List.length} selected=${cosignerPk33.slice(0, 12)}... sample=${sample}`,
          );
        }
        const localNonces = musig2.nonceGen(
          hexToBytes(pubCtx.clientPk33),
          priv,
          hexToBytes(pubCtx.aggregatedXonly32),
          msg32,
        );
        const clientPubNonce66 = bytesToHex(localNonces.public).toLowerCase();

        this.logTree("treeNonce", {
          action: "request",
          session: shortRef(sessionId),
          txid: shortRef(txid, 12, 8),
          approval: this.approvalToken ? 1 : 0,
          expectedNext: "server_tree_nonce",
        });
        if (!this.approvalToken) {
          throw new Error("Arkade tree signing requires approval token");
        }
        const nonceResponse = await this.identity.requestApprovedTreeNonce(this.approvalToken, {
          session_id: sessionId,
          txid,
          msg32: bytesToHex(msg32).toLowerCase(),
          client_pk33: pubCtx.clientPk33,
          client_pub_nonce: clientPubNonce66,
          tweak32: bytesToHex(tweak32).toLowerCase(),
        });
        const serverPubNonce66 = String(nonceResponse?.server_pub_nonce66 || "").toLowerCase();
        const serverPk33 = String(nonceResponse?.server_pubkey || "").toLowerCase();
        if (!/^[0-9a-f]{132}$/.test(serverPubNonce66)) {
          throw new Error(`invalid server tree nonce for txid=${txid}`);
        }
        if (serverPk33 !== pubCtx.serverPk33) {
          throw new Error(`server pubkey mismatch in tree nonce for txid=${txid}`);
        }

        const outerPubNonce66 = musig2.nonceAggregate([
          hexToBytes(clientPubNonce66),
          hexToBytes(serverPubNonce66),
        ]);
        this.txStates.set(txid, {
          txid,
          cosignerPk33,
          msg32,
          tweak32,
          outerCosignerPk33List,
          clientPubNonce66,
          clientSecNonce97: localNonces.secret,
          serverPubNonce66,
          outerPubNonce66,
          outerNonceByPk33: new Map(),
        });
        out.set(txid, { pubNonce: outerPubNonce66 });
        this.logTree("treeNonce", {
          action: "stored",
          session: shortRef(sessionId),
          txid: shortRef(txid, 12, 8),
          cosigners: outerCosignerPk33List.length,
          approval: this.approvalToken ? 1 : 0,
        });
      }
      this.logTree("getNonces", {
        txCount: out.size,
        session: shortRef(sessionId),
        approval: this.approvalToken ? 1 : 0,
      });
      return out;
    } finally {
      this.clearCachedPriv();
    }
  }

  async aggregatedNonces(
    _txid: string,
    _noncesByPubkey: TreeNonces,
  ): Promise<{ hasAllNonces: boolean }> {
    this.ensureInitialized();
    if (this.txStates.size === 0) {
      await this.getNonces();
    }

    const txid = String(_txid || "")
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      throw new Error(`invalid txid ${txid || "n/a"}`);
    }
    if (this.outerAggregateNonces.has(txid)) {
      return { hasAllNonces: this.outerAggregateNonces.size === this.txStates.size };
    }

    const state = this.txStates.get(txid);
    if (!state) {
      throw new Error(`missing local nonce for txid ${txid}`);
    }

    const myXonlyKey = state.cosignerPk33.slice(2);
    _noncesByPubkey.set(myXonlyKey, { pubNonce: state.outerPubNonce66 });

    const node = this.txNodes.find((n) => String(n.txid || "").toLowerCase() === txid);
    if (!node) {
      throw new Error(`missing tree node for txid ${txid}`);
    }
    const cosigners = this.getCosignerPubkeys(node).map((pk) =>
      bytesToHex(pk.subarray(1)).toLowerCase(),
    );
    const providedNonceKeys = [..._noncesByPubkey.keys()]
      .map((key) =>
        String(key || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
    const unexpectedNonceKeys = providedNonceKeys.filter((key) => !cosigners.includes(key));

    const orderedPubNonces: Uint8Array[] = [];
    const outerNonceByPk33 = new Map<string, Uint8Array>();
    for (const cosigner of cosigners) {
      const nonce = _noncesByPubkey.get(cosigner);
      if (!nonce?.pubNonce) {
        throw new Error(`missing nonce for cosigner ${cosigner.slice(0, 12)}... txid=${txid}`);
      }
      orderedPubNonces.push(nonce.pubNonce);
      outerNonceByPk33.set(`02${cosigner}`.toLowerCase(), nonce.pubNonce);
      outerNonceByPk33.set(`03${cosigner}`.toLowerCase(), nonce.pubNonce);
    }
    const combined = musig2.nonceAggregate(orderedPubNonces);
    state.outerNonceByPk33 = outerNonceByPk33;
    this.outerAggregateNonces.set(txid, { pubNonce: combined });
    this.logTree("aggregatedNonces", {
      txid: shortRef(txid, 12, 8),
      cosigners: cosigners.length,
      usedNonces: orderedPubNonces.length,
      providedNonces: providedNonceKeys.length,
      unexpectedNonces: unexpectedNonceKeys.length,
      unexpectedSample: unexpectedNonceKeys
        .slice(0, 4)
        .map((key) => shortRef(key, 12, 4))
        .join(","),
      ready: this.outerAggregateNonces.size === this.txStates.size ? 1 : 0,
    });
    return { hasAllNonces: this.outerAggregateNonces.size === this.txStates.size };
  }

  async sign(): Promise<TreePartialSigs> {
    this.ensureInitialized();
    if (this.partialSigCache) {
      this.logTree("sign", {
        action: "reuse",
        txCount: this.partialSigCache.size,
      });
      return this.partialSigCache;
    }
    if (this.txStates.size === 0) {
      await this.getNonces();
    }
    if (this.outerAggregateNonces.size !== this.txStates.size) {
      throw new Error("tree nonces not fully aggregated yet");
    }

    const pubCtx = await this.identity.getSigningPublicContext();
    const sessionId = await this.ensureTreeSession(pubCtx.clientPk33);
    const priv = await this.getCachedPriv(pubCtx.clientPk33);
    this.logTree("sign", {
      action: "start",
      txCount: this.txStates.size,
      aggregatedNonces: this.outerAggregateNonces.size,
      session: shortRef(sessionId),
      approval: this.approvalToken ? 1 : 0,
      expectedNext: "server_tree_sign",
    });
    try {
      const partials: TreePartialSigs = new Map();
      for (const node of this.txNodes) {
        const txid = String(node.txid || "")
          .trim()
          .toLowerCase();
        const state = this.txStates.get(txid);
        if (!state) {
          throw new Error(`missing tx state for ${txid}`);
        }
        const outerAgg = this.outerAggregateNonces.get(txid)?.pubNonce;
        if (!outerAgg) {
          throw new Error(`missing outer aggregate nonce for txid=${txid}`);
        }
        const outerAggHex = bytesToHex(outerAgg).toLowerCase();

        this.logTree("treeSign", {
          action: "request",
          session: shortRef(sessionId),
          txid: shortRef(txid, 12, 8),
          outerPubkeys: state.outerCosignerPk33List.length,
          approval: this.approvalToken ? 1 : 0,
          expectedNext: "server_tree_partial",
        });
        if (!this.approvalToken) {
          throw new Error("Arkade tree signing requires approval token");
        }
        const signResponse = await this.identity.requestApprovedTreeSign(this.approvalToken, {
          session_id: sessionId,
          txid,
          msg32: bytesToHex(state.msg32).toLowerCase(),
          client_pk33: pubCtx.clientPk33,
          client_pub_nonce: state.clientPubNonce66,
          tweak32: bytesToHex(state.tweak32).toLowerCase(),
          outer_agg_nonce66: outerAggHex,
          outer_pubkeys33: state.outerCosignerPk33List,
        });

        const serverPubNonce66 = String(signResponse?.server_pub_nonce66 || "").toLowerCase();
        const serverPartial32 = String(signResponse?.server_partial32 || "").toLowerCase();
        const serverPk33 = String(signResponse?.server_pubkey || "").toLowerCase();
        if (!/^[0-9a-f]{132}$/.test(serverPubNonce66)) {
          throw new Error(`invalid server tree nonce (sign) for txid=${txid}`);
        }
        if (!/^[0-9a-f]{64}$/.test(serverPartial32)) {
          throw new Error(`invalid server tree partial for txid=${txid}`);
        }
        if (serverPk33 !== pubCtx.serverPk33) {
          throw new Error(`server pubkey mismatch in tree sign for txid=${txid}`);
        }
        if (serverPubNonce66 !== state.serverPubNonce66) {
          throw new Error(`server nonce mismatch between tree nonce/sign for txid=${txid}`);
        }

        const serverPubNonce = hexToBytes(serverPubNonce66);
        const serverPartialShare = hexToBytes(serverPartial32);
        const innerAgg = musig2.nonceAggregate([
          hexToBytes(state.clientPubNonce66),
          serverPubNonce,
        ]);
        const innerAggHex = bytesToHex(innerAgg).toLowerCase();
        if (outerAggHex !== innerAggHex) {
          console.log(
            `🔐 [${shortTime()} ArkadeRemoteSignerSession.sign] txid=${txid.slice(0, 12)}... nonce_domain_compare pairAgg=${innerAggHex.slice(0, 16)}... outerAgg=${outerAggHex.slice(0, 16)}... outerKeys=${state.outerCosignerPk33List.length}`,
          );
        }
        const clientOuterShare = computeNestedClientOuterPartial({
          clientPriv32: priv,
          clientSecNonce97: state.clientSecNonce97,
          clientPk33: pubCtx.clientPk33,
          serverPk33: pubCtx.serverPk33,
          cosignerPk33: state.cosignerPk33,
          outerCosignerPk33List: state.outerCosignerPk33List,
          outerAggregateNonce66: outerAgg,
          outerTweak32: state.tweak32,
          msg32: state.msg32,
        });
        const combinedOuterShare = addPartialSigs32(clientOuterShare, serverPartialShare);

        const outerKeys = musig2.sortKeys(
          state.outerCosignerPk33List.map((pk) => hexToBytes(pk.toLowerCase())),
        );
        // TODO(#414): pending Emin's input on whether to drop access to
        // musig2.Session private internals (Q, gAcc, e, b, R, getSessionKeyAggCoeff)
        // — either by switching to Arkade's TreeSignerSession or reimplementing the
        // math against @noble/secp256k1.
        const outerSession = new musig2.Session(
          outerAgg,
          outerKeys,
          state.msg32,
          state.tweak32.length > 0 ? [state.tweak32] : [],
          state.tweak32.length > 0 ? [true] : [],
        ) as unknown as Musig2Session;
        const signerIndex = outerKeys.findIndex(
          (pk) => bytesToHex(pk).toLowerCase() === state.cosignerPk33.toLowerCase(),
        );
        if (signerIndex < 0) {
          throw new Error(`outer signer key missing for txid=${txid}`);
        }
        const outerCoeff = outerSession.getSessionKeyAggCoeff(
          Point.fromBytes(hexToBytes(state.cosignerPk33)),
        );
        const innerKeysForDebug = musig2.sortKeys([
          hexToBytes(pubCtx.clientPk33),
          hexToBytes(pubCtx.serverPk33),
        ]);
        const innerSessionForDebug = new musig2.Session(
          outerAgg,
          innerKeysForDebug,
          state.msg32,
        ) as unknown as Musig2Session;
        const clientCoeff = innerSessionForDebug.getSessionKeyAggCoeff(
          Point.fromBytes(hexToBytes(pubCtx.clientPk33)),
        );
        const serverCoeff = innerSessionForDebug.getSessionKeyAggCoeff(
          Point.fromBytes(hexToBytes(pubCtx.serverPk33)),
        );
        const outerGlobal = modN(evenScalar(outerSession.Q, 1n) * BigInt(outerSession.gAcc));
        const innerGlobal = modN(
          evenScalar(innerSessionForDebug.Q, 1n) * BigInt(innerSessionForDebug.gAcc),
        );
        const stateOuterPubNonce66 = bytesToHex(state.outerPubNonce66).toLowerCase();
        const mappedSelfOuterNonce66 = bytesToHex(
          state.outerNonceByPk33.get(state.cosignerPk33) || new Uint8Array(),
        ).toLowerCase();
        const orderedOuterNonces = outerKeys.map((pk) => {
          const keyHex = bytesToHex(pk).toLowerCase();
          const nonce = state.outerNonceByPk33.get(keyHex);
          if (!nonce) {
            throw new Error(`missing outer nonce for key=${keyHex.slice(0, 12)}... txid=${txid}`);
          }
          return nonce;
        });
        const outerShareOk = outerSession.partialSigVerify(
          combinedOuterShare,
          orderedOuterNonces,
          signerIndex,
        );
        if (!outerShareOk) {
          this.logTree("treeSignVerify", {
            result: "failed",
            txid: shortRef(txid, 12, 8),
            cosignerPk33: state.cosignerPk33,
            outerPubkeys33: state.outerCosignerPk33List.join(","),
            outerKeys: outerKeys.length,
            verifyNonces: orderedOuterNonces.length,
            nonceMap: state.outerNonceByPk33.size,
            signerIndex,
            outerCoeff: outerCoeff.toString(16),
            clientCoeff: clientCoeff.toString(16),
            serverCoeff: serverCoeff.toString(16),
            outerE: BigInt(outerSession.e).toString(16),
            outerB: BigInt(outerSession.b).toString(16),
            outerGAcc: outerGlobal.toString(16),
            innerGAcc: innerGlobal.toString(16),
            clientPubNonce66: state.clientPubNonce66,
            serverPubNonce66,
            stateOuterPubNonce66,
            mappedSelfOuterNonce66: mappedSelfOuterNonce66 || "missing",
            orderedOuterNonce66s: formatNonceEntriesForLog(outerKeys, state.outerNonceByPk33),
            outerAgg: shortRef(outerAggHex, 16, 8),
            pairAgg: shortRef(innerAggHex, 16, 8),
          });
          throw new Error(`outer partial verification failed txid=${txid}`);
        }

        partials.set(txid, makeTreePartialSig(combinedOuterShare));
        this.logTree("treeSign", {
          action: "partial",
          session: shortRef(sessionId),
          txid: shortRef(txid, 12, 8),
          approval: this.approvalToken ? 1 : 0,
        });
      }

      for (const state of this.txStates.values()) {
        zeroize(state.clientSecNonce97);
      }
      this.partialSigCache = partials;
      this.logTree("sign", {
        txCount: partials.size,
        session: shortRef(sessionId),
        approval: this.approvalToken ? 1 : 0,
      });
      return partials;
    } catch (error) {
      this.logTree("sign", {
        action: "failed",
        txCount: this.txStates.size,
        session: shortRef(sessionId),
        approval: this.approvalToken ? 1 : 0,
        err: shortError(error),
      });
      throw error;
    } finally {
      this.clearCachedPriv();
    }
  }
}
