// The single derivation of the MuSig2 + CSV on-chain address: the aggregated
// key is the taproot internal key, the user's key sits in the CSV recovery leaf.
import { hexToBytes } from "../bytes";
import { makeP2TRWithCSV, toXOnly } from "./BitcoinTaprootCheckSequenceVerifyCSV";

export type Musig2CsvAddressParams = {
  aggregatedXonly32: string;
  userCompressed: string;
  csvSequence: number;
  network?: "main" | "testnet" | "regtest";
};

export type Musig2CsvAddress = {
  address: string;
  scriptPubKey: Uint8Array;
  tapInternalKey: Uint8Array;
  // Carried out because a key-path spend has to tweak the aggregated key with
  // it — the PSBT builder cannot recompute the tree on its own.
  tapMerkleRoot: Uint8Array;
};

export function deriveMusig2CsvAddress(params: Musig2CsvAddressParams): Musig2CsvAddress {
  const tapInternalKey = hexToBytes(params.aggregatedXonly32);
  const userXOnly = toXOnly(hexToBytes(params.userCompressed));
  const p2tr = makeP2TRWithCSV(
    tapInternalKey,
    userXOnly,
    params.csvSequence,
    params.network ?? "main",
  );

  if (!p2tr.address) throw new Error("Failed to derive P2TR address");
  if (!p2tr.tapMerkleRoot) throw new Error("Failed to derive tap merkle root");

  return {
    address: p2tr.address,
    scriptPubKey: p2tr.script,
    tapInternalKey,
    tapMerkleRoot: p2tr.tapMerkleRoot,
  };
}
