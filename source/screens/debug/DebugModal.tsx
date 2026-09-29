import * as Application from "expo-application";
import * as Updates from "expo-updates";
import { Fragment } from "react";
import {
  Header,
  IconButton,
  List,
  ListAction,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailIcon,
  ListSeparator,
  Scroll,
  Text,
  Topbar,
  TopbarTrailing,
  View,
} from "@ds";
import DsSheetHost from "../../components/DsSheetHost";

export type { DebugTarget } from "../../types/debug";
import type { DebugActionItem, DebugModalProps } from "../../types/debug";
type Props = DebugModalProps;

const ACTIONS: DebugActionItem[] = [
  {
    target: "app",
    action: "dsReview",
    title: "Design System Review (new DS)",
    subtitle: "Browse vendored @ds components and states",
  },
  {
    target: "app",
    action: "notifications",
    title: "Notifications",
    subtitle: "Permission, push token, timed test, send to a dev device",
  },
  {
    target: "app",
    action: "webView",
    title: "v1-wallet-migration-screen",
    subtitle: "Open the Nuri web app in a full-screen WebView",
  },
  {
    target: "card",
    action: "wirexFullDebug",
    title: "Card: Wirex Full Debug",
    subtitle: "Open full Wirex lab and push tools",
  },
  {
    target: "card",
    action: "wirexWithdrawDebug",
    title: "Card: Withdraw Debug (raw)",
    subtitle: "Run the WEUR→EURC withdrawal with a full raw trace",
  },
  {
    target: "card",
    action: "dumpBankTransactions",
    title: "Card: Dump Bank Transactions",
    subtitle: "Show the raw bank/SEPA activity JSON",
  },
  {
    target: "wallet",
    action: "eoaKeyExport",
    title: "Wallet: EOA Key Export",
    subtitle: "Reveal address, public key, and private key",
  },
  {
    target: "bitcoin",
    action: "debugArkadeModal",
    title: "Bitcoin: Debug Arkade v4",
    subtitle: "Arkade wallet + recovery signer probes",
  },
  {
    target: "wallet",
    action: "satoraCollabRefund",
    title: "Wallet: Satora Collab Refund (temp)",
    subtitle: "Sign + relay the refund for the stuck EURC→BTC_ARKADE swap",
  },
  {
    target: "wallet",
    action: "factoryReset",
    title: "Factory Reset",
    subtitle: "Erase all local wallet data",
  },
];

export default function DebugModal({ visible, onClose, onRunAction }: Props) {
  const baseVersion = `v${Application.nativeApplicationVersion ?? "?"} (${
    Application.nativeBuildVersion ?? "?"
  })`;
  const otaSuffix = Updates.isEmbeddedLaunch
    ? " · embedded"
    : ` · OTA ${Updates.createdAt?.toISOString().slice(0, 10) ?? Updates.updateId?.slice(0, 8) ?? "unknown"}`;
  const versionLabel = `${baseVersion}${otaSuffix}`;

  // Not dismissible: the 8-tap logo gesture that opens this would otherwise
  // land its next tap on the scrim and immediately close it.
  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full" dismissible={false}>
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
            Debug
          </Text>
          <Text size="md" muted>
            {versionLabel}
          </Text>
          <List>
            {ACTIONS.map((item, index) => (
              <Fragment key={item.action}>
                {index > 0 ? <ListSeparator /> : null}
                <ListAction
                  accessibilityLabel={item.title}
                  onPress={() => onRunAction(item.target, item.action)}
                >
                  <ListActionText>{item.title}</ListActionText>
                  <ListActionTextMuted>{item.subtitle}</ListActionTextMuted>
                  <ListActionTrailIcon name="chevron-right" />
                </ListAction>
              </Fragment>
            ))}
          </List>
        </View>
      </Scroll>
    </DsSheetHost>
  );
}
