// Read-only: list ALL vtxos (spent + unspent) of an ark address on the
// arkade.computer indexer, then decode each spending (checkpoint) tx.
// Usage: node tools/arkade-forensics/vtxos.mjs ark1q...
// Born during the 2026-07-05 stranded-tx incident (see SESSION_LOG.md).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sdk = require("@arkade-os/sdk");
const btc = require("@scure/btc-signer");

const ADDRESS = process.argv[2];
if (!ADDRESS?.startsWith("ark1")) {
  console.error("usage: node tools/arkade-forensics/vtxos.mjs <ark1... address>");
  process.exit(1);
}
const hex = (u8) => Buffer.from(u8).toString("hex");
const addr = sdk.ArkAddress.decode(ADDRESS);
const script = `5120${hex(addr.vtxoTaprootKey)}`;
console.log("wallet script:", script);

const indexer = new sdk.RestIndexerProvider("https://arkade.computer");
const { vtxos } = await indexer.getVtxos({ scripts: [script] });
console.log(`\n=== vtxos (${vtxos.length}) ===`);
for (const v of vtxos.sort((a, b) => Number(a.createdAt) - Number(b.createdAt))) {
  console.log(
    `  ${v.txid}:${v.vout} sats=${v.value} ${v.isSpent ? "SPENT" : "unspent"}` +
      `${v.spentBy ? ` spentBy=${v.spentBy}` : ""}${v.arkTxId ? ` arkTx=${v.arkTxId}` : ""}`,
  );
}

const spenders = [...new Set(vtxos.filter((v) => v.spentBy).map((v) => v.spentBy))];
console.log(`\n=== spending txs (${spenders.length}) ===`);
for (const txid of spenders) {
  try {
    const { txs } = await indexer.getVirtualTxs([txid]);
    for (const raw of txs) {
      const tx = btc.Transaction.fromPSBT(Buffer.from(raw, "base64"), {
        allowUnknown: true,
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      });
      console.log(`tx ${txid} outputs:`);
      for (let i = 0; i < tx.outputsLength; i++) {
        const o = tx.getOutput(i);
        const spk = o.script ? hex(o.script) : "?";
        console.log(
          `  [${i}] sats=${o.amount} script=${spk}${spk === script ? "  <-- WALLET" : ""}`,
        );
      }
    }
  } catch (e) {
    console.log(`tx ${txid}: fetch failed: ${e.message}`);
  }
}
