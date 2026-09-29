// @screen app.support-dump
import React, { useState } from "react";
import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  Scroll,
  Text,
  Topbar,
  TopbarTrailing,
  View,
} from "@ds";
import DsSheetHost from "./DsSheetHost";
import { t } from "../lib/i18n";
import {
  sendSupportDump,
  type SupportDumpAppSnapshot,
  type SupportDumpSendResult,
} from "../services/support/SupportDumpService";

type Props = {
  visible: boolean;
  onClose: () => void;
  supportPubkey: string;
  appSnapshot?: SupportDumpAppSnapshot;
};

const SupportDumpModal: React.FC<Props> = ({ visible, onClose, supportPubkey, appSnapshot }) => {
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [result, setResult] = useState<SupportDumpSendResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canClose = !sending;

  const statusLine = (() => {
    if (sending && progress) {
      return `Sending ${Math.min(progress.sent + 1, progress.total)}/${progress.total}…`;
    }
    if (sending) return "Sending…";
    if (result) return `Sent. Dump id: ${result.dumpId}`;
    if (error) return error;
    return null;
  })();

  const handleClose = () => {
    if (!canClose) return;
    setError(null);
    setProgress(null);
    setResult(null);
    onClose();
  };

  const handleSend = async () => {
    if (sending) return;
    setError(null);
    setResult(null);
    setProgress(null);
    setSending(true);
    try {
      const res = await sendSupportDump({
        supportPubkey,
        appSnapshot,
        includePersonalData: true,
        onProgress: (p) => setProgress(p),
      });
      if (res.relaysAckedOk <= 0) {
        throw new Error(
          "Could not confirm relay acceptance. Please try again on a stable connection.",
        );
      }
      setResult(res);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Send failed";
      setError(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <DsSheetHost visible={visible} onClose={handleClose} mode="sheet">
      <Header paddingTop="lg">
        <Topbar surface="transparent">
          <TopbarTrailing>
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel={t("common.close")}
              onPress={handleClose}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>

      <Scroll>
        <View
          direction="column"
          align="stretch"
          justify="start"
          gap="sm"
          paddingX="lg"
          paddingBottom="lg"
        >
          <Text size="lg" emphasis>
            Support Dump
          </Text>
          <Text size="md" muted>
            Encrypted debug dump to CTO via Nostr.
          </Text>
          <Text size="md" muted>
            No private keys or auth tokens.
          </Text>
          {statusLine ? (
            <Text size="md" emphasis>
              {statusLine}
            </Text>
          ) : null}
        </View>
      </Scroll>

      <Footer safeAreaBottom direction="column" align="stretch" paddingBottom="lg" paddingX="lg">
        <View direction="column" align="stretch" gap="sm">
          <Button
            size="lg"
            variant="solid"
            accent="lilac"
            disabled={sending}
            onPress={() => void handleSend()}
          >
            <ButtonText>{sending ? "Sending…" : "Send dump to CTO"}</ButtonText>
          </Button>
          <Button size="lg" variant="soft" disabled={sending} onPress={handleClose}>
            <ButtonText>{result ? "Close" : "Cancel"}</ButtonText>
          </Button>
        </View>
      </Footer>
    </DsSheetHost>
  );
};

export default SupportDumpModal;
