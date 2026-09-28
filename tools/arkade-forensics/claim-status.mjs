// Read-only: for each ark tx, show whether the non-wallet (recipient) outputs
// became vtxos and whether they were claimed (spent) by the recipient. For a
// Boltz submarine swap, CLAIMED means Boltz paid the Lightning invoice.
// Usage: node tools/arkade-forensics/claim-status.mjs <ark1... address> <arkTxid> [arkTxid...]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sdk = require("@arkade-os/sdk");
const btc = require("@scure/btc-signer");

const [ADDRESS, ...TXIDS] = process.argv.slice(2);
if (!ADDRESS?.startsWith("ark1") || !TXIDS.length) {
  console.error(
    "usage: node tools/arkade-forensics/claim-status.mjs <ark1... address> <arkTxid> [arkTxid...]",
  );
  process.exit(1);
}
const hex = (u8) => Buffer.from(u8).toString("hex");
const walletScript = `5120${hex(sdk.ArkAddress.decode(ADDRESS).vtxoTaprootKey)}`;
const indexer = new sdk.RestIndexerProvider("https://arkade.computer");

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
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      const spk = hex(o.script ?? new Uint8Array());
      if (Number(o.amount) === 0) continue;
      const tag = spk === walletScript ? "WALLET_CHANGE" : "RECIPIENT";
      let state = "";
      if (tag === "RECIPIENT") {
        try {
          const { vtxos } = await indexer.getVtxos({ scripts: [spk] });
          const v = vtxos.find((x) => x.txid === txid);
          state = v
            ? v.isSpent
              ? " -> CLAIMED (spent by recipient)"
              : " -> UNSPENT (sitting in recipient script)"
            : " -> NO VTXO (tx not finalized?)";
        } catch (e) {
          state = ` -> lookup failed: ${e.message}`;
        }
      }
      console.log(`${txid.slice(0, 16)} out[${i}] sats=${o.amount} ${tag}${state}`);
    }
  } catch (e) {
    console.log(`${txid}: ${e.message}`);
  }
}
