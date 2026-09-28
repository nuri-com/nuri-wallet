import { useCallback, useState } from "react";
import * as Clipboard from "expo-clipboard";
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
import { wirexService } from "../../services/wirex/WirexService";
import type { DebugWirexWithdrawProps } from "../../types/debug";

type Props = DebugWirexWithdrawProps;

type RunState = "idle" | "running" | "done" | "failed";

export default function DebugWirexWithdrawModal({ visible, onClose }: Props) {
  const [amount, setAmount] = useState("0.10");
  const [runState, setRunState] = useState<RunState>("idle");
  const [trace, setTrace] = useState<string[]>([]);

  const appendTrace = useCallback((line: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    setTrace((prev) => [...prev, `[${ts}] ${line}`]);
  }, []);

  const run = useCallback(async () => {
    if (runState === "running") return;
    setTrace([]);
    setRunState("running");
    try {
      const result = await wirexService.withdrawToWallet(amount, { onTrace: appendTrace });
      appendTrace(`RESULT ${JSON.stringify(result)}`);
      setRunState("done");
    } catch (error) {
      const err = error as Error;
      appendTrace(
        `FATAL ${JSON.stringify({
          name: err?.name,
          message: err?.message,
          stack: err?.stack?.split("\n").slice(0, 12),
        })}`,
      );
      setRunState("failed");
    }
  }, [amount, appendTrace, runState]);

  const copyAll = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(trace.join("\n"));
      appendTrace("(trace copied to clipboard)");
    } catch {}
  }, [trace, appendTrace]);

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
            Withdraw Debug (raw)
          </Text>
          <Text size="md" muted>
            Runs the real withdrawal to this wallet's own EOA — two signed approvals, real funds.
            Every step below is the untruncated request/response/error.
          </Text>

          <TextField
            value={amount}
            onChangeText={setAmount}
            inputMode="decimal"
            placeholder="0.10"
            autoCapitalize="none"
            disabled={runState === "running"}
          >
            <TextFieldLabel>Amount (EUR)</TextFieldLabel>
          </TextField>

          <Button
            size="lg"
            variant="solid"
            accent="lilac"
            disabled={runState === "running"}
            onPress={() => void run()}
          >
            <ButtonText>
              {runState === "running" ? "Running…" : "Run real withdrawal (traced)"}
            </ButtonText>
          </Button>

          {trace.length > 0 ? (
            <>
              <Button size="sm" variant="soft" onPress={() => void copyAll()}>
                <ButtonText>Copy full trace</ButtonText>
              </Button>
              <View
                variant="soft"
                radius="lg"
                padding="lg"
                direction="column"
                align="stretch"
                gap="xs"
              >
                {trace.map((line, index) => (
                  <Text key={`${index}-${line.slice(0, 24)}`} size="xs" mono>
                    {line}
                  </Text>
                ))}
              </View>
            </>
          ) : null}

          {runState === "done" ? (
            <Text size="md" emphasis>
              Withdrawal completed.
            </Text>
          ) : null}
          {runState === "failed" ? (
            <Text size="md" emphasis>
              Withdrawal failed — see FATAL line above.
            </Text>
          ) : null}
        </View>
      </Scroll>
    </DsSheetHost>
  );
}
