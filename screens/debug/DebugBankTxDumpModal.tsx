// Debug-only viewer for the RAW Wirex bank/SEPA activity payload. Exists to
// pin the undocumented counterparty field names (holder/IBAN/BIC) against real
// payloads — console logging truncates, so the full JSON renders in-app,
// selectable, with a copy button. Thin caller of the prod WirexService.
import type React from "react";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text as RNText } from "react-native";
import * as Clipboard from "expo-clipboard";

import { Button, ButtonText, Header, IconButton, Topbar, TopbarTrailing, View } from "@ds";
import DsSheetHost from "../../components/DsSheetHost";
import type { DebugBankTxDumpProps } from "../../types/debug";
import { wirexService } from "../../services/wirex/WirexService";

type Props = DebugBankTxDumpProps;

const DebugBankTxDumpModal: React.FC<Props> = ({ visible, onClose, walletAddress }) => {
  const [dump, setDump] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setDump("");
    setStatus("loading…");
    void (async () => {
      try {
        if (!walletAddress) {
          if (!cancelled) setStatus("no wallet");
          return;
        }
        const items = await wirexService.getBankTransactions(walletAddress);
        if (cancelled) return;
        setStatus(`${items.length} item(s)`);
        setDump(JSON.stringify(items, null, 2));
      } catch (e) {
        if (!cancelled) setStatus(`failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, walletAddress]);

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          <TopbarTrailing>
            <IconButton icon="cross" variant="soft" accessibilityLabel="Close" onPress={onClose} />
          </TopbarTrailing>
        </Topbar>
      </Header>
      <View direction="column" align="stretch" gap="md" paddingX="lg" fill="grow">
        <RNText style={styles.status}>{`raw /bank/transactions — ${status}`}</RNText>
        <Button
          size="sm"
          variant="soft"
          disabled={!dump}
          accessibilityLabel="Copy JSON"
          onPress={() => {
            void Clipboard.setStringAsync(dump).catch(() => {});
          }}
        >
          <ButtonText>Copy JSON</ButtonText>
        </Button>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <RNText selectable style={styles.json}>
            {dump || "(empty)"}
          </RNText>
        </ScrollView>
      </View>
    </DsSheetHost>
  );
};

const styles = StyleSheet.create({
  status: {
    fontSize: 14,
    opacity: 0.6,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 48,
  },
  json: {
    fontFamily: "Menlo",
    fontSize: 11,
  },
});

export default DebugBankTxDumpModal;
