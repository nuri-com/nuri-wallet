import { useCallback, useEffect, useState } from "react";
import {
  Button,
  ButtonText,
  Header,
  IconButton,
  Scroll,
  Text,
  TextField,
  TextFieldLabel,
  Topbar,
  TopbarTrailing,
  View,
} from "@ds";
import DsSheetHost from "../../components/DsSheetHost";
import Spinner from "../../components/Spinner";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { scanClaimBlocker, scanSwapKitSweep } from "../../services/swapkit/SwapKitV2SweepService";
import {
  DEFAULT_RECOVERY_CHAIN_ID,
  formatRecoveryProgress,
  getRecoverableUsdcBalance,
  recoverStrandedUsdc,
  recoverySources,
} from "../../services/swapkit/SwapKitUsdcRecoveryService";
import type { DebugUsdcRecoveryProps, DebugUsdcRecoveryRunState } from "../../types/debug";

type Props = DebugUsdcRecoveryProps;

export default function DebugUsdcRecoveryModal({ visible, onClose }: Props) {
  const [chainId, setChainId] = useState<number>(DEFAULT_RECOVERY_CHAIN_ID);
  const [balance, setBalance] = useState<number | null>(null);
  const [settleTarget, setSettleTarget] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
  const [minEurcText, setMinEurcText] = useState("");
  const [run, setRun] = useState<DebugUsdcRecoveryRunState>({ kind: "idle" });
  const [trace, setTrace] = useState<string[]>([]);
  const [scanLines, setScanLines] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);

  useEffect(() => {
    if (!visible) {
      setRun({ kind: "idle" });
      setAmountText("");
      setMinEurcText("");
      setLoadError(null);
      return;
    }
    setTrace([]);
    setLoadError(null);
    let cancelled = false;
    void (async () => {
      try {
        const eoa = await getEthereumAddress();
        if (!eoa) throw new Error("Ethereum wallet address not available.");
        const usdc = await getRecoverableUsdcBalance(chainId, eoa);
        if (cancelled) return;
        setSettleTarget(eoa);
        setBalance(usdc);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, loadNonce, chainId]);

  const recover = useCallback(
    (usdcAmount: number, minEurc: number) => {
      if (!settleTarget) return;
      void (async () => {
        setRun({ kind: "running", status: "creating order" });
        setTrace([]);
        try {
          const result = await recoverStrandedUsdc({
            settleTarget,
            usdcAmount,
            minEurc,
            chainId,
            onProgress: (progress) => {
              setTrace((prev) => [...prev, formatRecoveryProgress(progress)]);
              if (progress.step === "status") {
                setRun({ kind: "running", status: progress.status || "tracking" });
              } else {
                setRun({ kind: "running", status: progress.step });
              }
            },
          });
          setRun({ kind: "done", swappedUsdc: result.swappedUsdc, txId: result.txId });
        } catch (e) {
          setRun({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      })();
    },
    [settleTarget, chainId],
  );

  // The recovery swap above only knows the chains in RECOVERY_SOURCES. This runs
  // the same read-only swap_sweep the Wallet screen runs, which scans every chain
  // the server covers, and prints per balance whether the claim would carry it —
  // those refusals are console-only in the claim path, which is why a sweep that
  // finds money can still do nothing.
  const runSweepScan = useCallback(() => {
    void (async () => {
      setScanning(true);
      setScanLines([]);
      try {
        const result = await scanSwapKitSweep();
        const lines = [
          `found=${result.found ?? 0} sweepable=${result.sweepable ?? 0} usd=${result.totalUsd ?? 0}`,
        ];
        for (const item of result.items ?? []) {
          const label = `${String(item.chain ?? "?")}:${String(item.symbol ?? item.asset ?? "?")}`;
          lines.push(`${label} chain=${item.chainId ?? "?"} amount=${item.amount ?? "?"}`);
          lines.push(`  token=${String(item.address ?? "none")}`);
          // Scan-time verdict only: the deposit address and stated amount that
          // the funding guard also checks arrive with confirm:true, so "nothing
          // blocks it" is not the same as "the claim will carry it".
          lines.push(
            `  claim: ${(await scanClaimBlocker(item)) ?? "nothing blocks it at scan time"}`,
          );
          if (item.error) lines.push(`  server: ${String(item.error)}`);
        }
        setScanLines(lines.length > 1 ? lines : [...lines, "no balances returned"]);
      } catch (e) {
        setScanLines([`scan failed: ${e instanceof Error ? e.message : String(e)}`]);
      } finally {
        setScanning(false);
      }
    })();
  }, []);

  const typedAmount = Number(amountText.replace(",", "."));
  const typedMinEurc = Number(minEurcText.replace(",", "."));
  const typedValid =
    Number.isFinite(typedAmount) &&
    typedAmount > 0 &&
    Number.isFinite(typedMinEurc) &&
    typedMinEurc > 0;
  const busy = run.kind === "running";
  const ready = balance !== null && settleTarget !== null;

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          <TopbarTrailing>
            <IconButton icon="cross" variant="soft" accessibilityLabel="Close" onPress={onClose} />
          </TopbarTrailing>
        </Topbar>
      </Header>
      <Scroll safeAreaBottom>
        <View direction="column" align="stretch" gap="lg" paddingX="lg" paddingBottom="lg">
          <Text size="lg" emphasis>
            Recover USDC
          </Text>

          <Text size="md">
            Swaps USDC to Euro via SwapKit, settling to this wallet's own EOA. Pick the chain the
            USDC is stranded on — the payout is EURC on Base either way.
          </Text>

          <View direction="row" align="stretch" gap="sm">
            {recoverySources().map((source) => (
              <Button
                key={source.chainId}
                size="sm"
                variant={source.chainId === chainId ? "solid" : "soft"}
                accent={source.chainId === chainId ? "lilac" : undefined}
                disabled={busy}
                onPress={() => {
                  setBalance(null);
                  setChainId(source.chainId);
                }}
              >
                <ButtonText>{source.asset}</ButtonText>
              </Button>
            ))}
          </View>

          <View direction="row" align="center" justify="between" gap="sm">
            <Text size="md">Balance</Text>
            <Text size="md" emphasis>
              {balance === null ? "—" : `${balance} USDC`}
            </Text>
          </View>

          {!ready ? (
            <View
              variant="soft"
              radius="lg"
              padding="lg"
              direction="column"
              align="stretch"
              gap="sm"
            >
              <Text size="md" emphasis>
                {loadError ? "Balance load failed" : "Loading balance…"}
              </Text>
              {loadError ? (
                <Text size="sm" mono>
                  {loadError}
                </Text>
              ) : null}
              {loadError ? (
                <Button size="lg" variant="soft" onPress={() => setLoadNonce((n) => n + 1)}>
                  <ButtonText>Retry</ButtonText>
                </Button>
              ) : null}
            </View>
          ) : null}

          <TextField
            value={amountText}
            onChangeText={setAmountText}
            inputMode="decimal"
            placeholder="0.00"
            autoCapitalize="none"
          >
            <TextFieldLabel>Amount (USDC)</TextFieldLabel>
          </TextField>

          <TextField
            value={minEurcText}
            onChangeText={setMinEurcText}
            inputMode="decimal"
            placeholder="0.00"
            autoCapitalize="none"
          >
            <TextFieldLabel>Minimum output (Euro) — required, enables both buttons</TextFieldLabel>
          </TextField>

          <Button
            size="lg"
            variant="solid"
            accent="lilac"
            onPress={() => recover(typedAmount, typedMinEurc)}
            disabled={!ready || busy || !typedValid}
          >
            <ButtonText>Recover amount</ButtonText>
          </Button>
          <Button
            size="lg"
            variant="soft"
            onPress={() => recover(balance ?? 0, typedMinEurc)}
            disabled={
              !ready ||
              busy ||
              (balance ?? 0) <= 0 ||
              !Number.isFinite(typedMinEurc) ||
              typedMinEurc <= 0
            }
          >
            <ButtonText>
              {balance === null ? "Recover all" : `Recover all (${balance} USDC)`}
            </ButtonText>
          </Button>

          {busy ? (
            <View direction="row" align="center" gap="sm">
              <Spinner />
              <Text size="md">{run.status}</Text>
            </View>
          ) : null}

          <Text size="md" emphasis>
            Other chains
          </Text>
          <Text size="md" muted>
            Read-only swap_sweep scan — what the Wallet screen sees, plus whether the claim would
            carry each balance.
          </Text>
          <Button size="lg" variant="soft" onPress={runSweepScan} disabled={scanning || busy}>
            <ButtonText>{scanning ? "Scanning…" : "Scan other chains"}</ButtonText>
          </Button>

          {scanLines.length > 0 ? (
            <View
              variant="soft"
              radius="lg"
              padding="lg"
              direction="column"
              align="stretch"
              gap="xs"
            >
              {scanLines.map((line, index) => (
                // Scan output repeats lines across items (same reason twice) —
                // index is the only stable key here.
                <Text key={`${index}-${line}`} size="sm" mono>
                  {line}
                </Text>
              ))}
            </View>
          ) : null}

          {trace.length > 0 ? (
            <View
              variant="soft"
              radius="lg"
              padding="lg"
              direction="column"
              align="stretch"
              gap="xs"
            >
              {trace.map((line) => (
                <Text key={line} size="sm" mono>
                  {line}
                </Text>
              ))}
            </View>
          ) : null}

          {run.kind === "done" ? (
            <Text size="md" emphasis>
              {run.swappedUsdc > 0
                ? `Swapped ${run.swappedUsdc} USDC · ${run.txId ?? "no id"}`
                : "Nothing to recover."}
            </Text>
          ) : null}
          {run.kind === "error" ? (
            <View
              variant="soft"
              radius="lg"
              padding="lg"
              direction="column"
              align="stretch"
              gap="xs"
            >
              <Text size="md" emphasis>
                Failed
              </Text>
              <Text size="md" muted>
                {run.message}
              </Text>
            </View>
          ) : null}
        </View>
      </Scroll>
    </DsSheetHost>
  );
}
