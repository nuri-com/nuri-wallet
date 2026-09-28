// Read-only: fetch checkpoint txs from the arkade.computer indexer and verify
// every tapScriptSig against the locally computed sighash. Proves whether the
// stored signatures are valid and which key (client aggregate vs operator)
// actually signed — this is how the 2026-07-05 checkpoint-order bug was
// pinned down (see SESSION_LOG.md).
// Usage: node tools/arkade-forensics/verify-checkpoints.mjs <txid> [txid...]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sdk = require("@arkade-os/sdk");
const btc = require("@scure/btc-signer");
const { schnorr } = require("@noble/curves/secp256k1");
const { sha256 } = require("@noble/hashes/sha2.js");

const TXIDS = process.argv.slice(2);
if (!TXIDS.length) {
  console.error("usage: node tools/arkade-forensics/verify-checkpoints.mjs <txid> [txid...]");
  process.exit(1);
}
const hex = (u8) => Buffer.from(u8).toString("hex");
const indexer = new sdk.RestIndexerProvider("https://arkade.computer");

function tapLeafHash(script, version = 0xc0) {
  const tag = sha256(new TextEncoder().encode("TapLeaf"));
  const data = new Uint8Array([version, script.length, ...script]);
  return sha256(new Uint8Array([...tag, ...tag, ...data]));
}

for (const txid of TXIDS) {
  try {
    const { txs } = await indexer.getVirtualTxs([txid]);
    if (!txs.length) {
      console.log(`${txid}: not found`);
      continue;
    }
    const tx = btc.Transaction.fromPSBT(Buffer.from(txs[0], "base64"), {
      allowUnknown: true,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    console.log(`\n=== tx ${txid} inputs=${tx.inputsLength} ===`);
    const prevScripts = [];
    const prevAmounts = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      prevScripts.push(inp.witnessUtxo?.script ?? new Uint8Array());
      prevAmounts.push(inp.witnessUtxo?.amount ?? 0n);
    }
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      const leaves = inp.tapLeafScript || [];
      const sigs = inp.tapScriptSig || [];
      console.log(
        ` input[${i}] prevScript=${hex(prevScripts[i])} sats=${prevAmounts[i]} leaves=${leaves.length} sigs=${sigs.length}`,
      );
      for (const [entry, sig] of sigs) {
        const sighashType = sig.length === 65 ? sig[64] : 0;
        const sig64 = sig.subarray(0, 64);
        for (const [, scriptWithVer] of leaves) {
          const leafScript = scriptWithVer.subarray(0, -1);
          const ver = scriptWithVer[scriptWithVer.length - 1];
          if (hex(tapLeafHash(leafScript, ver)) !== hex(entry.leafHash)) continue;
          const msg = tx.preimageWitnessV1(
            i,
            prevScripts,
            sighashType,
            prevAmounts,
            undefined,
            leafScript,
            ver,
          );
          const ok = schnorr.verify(sig64, msg, entry.pubKey);
          console.log(
            `  sig pubKey=${hex(entry.pubKey)} sighash=${hex(msg).slice(0, 16)}... -> ${ok ? "VALID" : "INVALID!!!"}`,
          );
        }
      }
    }
  } catch (e) {
    console.log(`${txid}: ${e.message}`);
  }
}
