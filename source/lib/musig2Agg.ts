import * as musig2 from "@scure/btc-signer/musig2.js";
import { bytesToHex } from "./bytes";

// Compute MuSig2 aggregated P (x-only 32-byte hex) from two 33-byte compressed pubkeys
export function aggregatedPXOnlyHex(
  clientCompressed: Uint8Array,
  serverCompressed: Uint8Array,
): string {
  if (
    !(
      clientCompressed?.length === 33 &&
      (clientCompressed[0] === 0x02 || clientCompressed[0] === 0x03)
    )
  ) {
    throw new Error("Invalid client compressed key");
  }
  if (
    !(
      serverCompressed?.length === 33 &&
      (serverCompressed[0] === 0x02 || serverCompressed[0] === 0x03)
    )
  ) {
    throw new Error("Invalid server compressed key");
  }
  const ks = musig2.sortKeys([clientCompressed, serverCompressed]);
  const P_comp = musig2.keyAggExport(musig2.keyAggregate(ks));
  const P_x = P_comp.length === 33 ? P_comp.slice(1) : P_comp;
  if (P_x.length !== 32) throw new Error(`Bad aggregated P length: ${P_x.length}`);
  return bytesToHex(P_x);
}
