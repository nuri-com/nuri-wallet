// Where an Arkade history row can be looked up online (#1955). A deposit into
// Arkade and a send out to a Bitcoin address are Bitcoin transactions, so
// mempool.space shows them; a payment inside Arkade is only on the Arkade
// explorer, which reads the default Arkade server alone.
import { arkadeTxUrl, mempoolTxUrl } from "../../config/endpoints";

export type ArkadeRowIds = {
  boardingTxid?: string;
  exitTxid?: string;
  arkTxid?: string;
};

export type ArkadeRowExplorer = { site: "mempool" | "arkade"; url: string };

export function arkadeRowExplorer(
  row: ArkadeRowIds,
  onDefaultArkadeServer: boolean,
): ArkadeRowExplorer | null {
  const onchain = row.boardingTxid || row.exitTxid;
  if (onchain) return { site: "mempool", url: `${mempoolTxUrl(onchain)}?mode=details` };
  if (row.arkTxid && onDefaultArkadeServer)
    return { site: "arkade", url: arkadeTxUrl(row.arkTxid) };
  return null;
}
