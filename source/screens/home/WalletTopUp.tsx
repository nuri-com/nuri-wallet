// @component wallet-top-up
// Add money → From another wallet: pay into one of the user's own balances from
// any wallet they hold elsewhere. Choosing it opens the wallet picker straight
// away; the sheet appears only once a wallet is connected, to pick the token
// and amount. Closing the picker without connecting ends the flow.
//
// The same wallet flow the pay page uses (the connection from lib/pay/payWallet,
// the token picker and swap in PayWalletSwapPanel, bound and persisted by
// usePayWalletSwap), on native (Reown AppKit) and on the PWA (RainbowKit)
// alike. Any token the wallet holds is swapped into the balance's own asset and
// settles at its address.
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View as RNView } from "react-native";
import { Footer, Header, IconButton, Topbar, TopbarTitle, TopbarTrailing, View } from "@ds";
import DsSheetHost from "../../components/DsSheetHost";
import PayWalletSwapPanel from "../../components/PayWalletSwapPanel";
import { t } from "../../lib/i18n";
import { toSatsFromBtcAmount } from "../../lib/amounts";
import { PayWalletProvider, usePayWalletConnection } from "../../lib/pay/payWallet";
import type { MoneyRail } from "../../services/money/MoneyInFlightStore";
import {
  type PayWalletProgress,
  type PayWalletSettle,
  payWalletRecordKey,
} from "../../services/pay/PayWalletSwapService";
import { runWalletTopUp } from "../../services/pay/PayWalletTopUp";
import { usePayWalletSwap } from "../pay/hooks/usePayWalletSwap";

/** How long a closed picker may wait for the wallet's connection to arrive. */
const CONNECT_SETTLE_MS = 5_000;

type Props = {
  onClose: () => void;
  /** What the balance holds: its stable, or bitcoin. */
  settle: PayWalletSettle;
  /** Where it lands: the balance's own address (the card's deposit address for Visa). */
  payoutAddress: string;
  /** The balance it lands on, which shows it as incoming meanwhile. */
  rail: MoneyRail;
  /** The balance, as the home names it ("Euro"). */
  label: string;
  /** What arrives, as the home writes that balance ("€ 22.24"). */
  formatReceive: (amount: string) => string;
};

const Flow: React.FC<Props> = ({ onClose, settle, payoutAddress, rail, label, formatReceive }) => {
  const connection = usePayWalletConnection();
  const connected = connection.account !== null;
  const wallet = usePayWalletSwap(payoutAddress, settle, null, false);
  // Accepting is the last thing done here: the sheet goes and the status pill
  // carries the payment. It comes back only when nothing left the wallet.
  const [handedOff, setHandedOff] = useState(false);
  const carry = (
    receive: string,
    resume: boolean,
    run: (observe: (progress: PayWalletProgress) => void) => Promise<PayWalletProgress | null>,
  ) => {
    setHandedOff(true);
    void runWalletTopUp({
      recordKey: payWalletRecordKey(payoutAddress, settle),
      rail,
      amount: settle === "BTC" ? toSatsFromBtcAmount(receive) : Number(receive),
      resume,
      pay: run,
    }).then((next) => (next === "reopen" ? setHandedOff(false) : onClose()));
  };
  const pay = () => {
    if (wallet.state.step === "quoted") {
      carry(wallet.state.quote.option.settleAmount, false, wallet.pay);
    }
  };
  const resume = () => {
    if (wallet.state.step === "pending" && !wallet.state.otherAccount) {
      carry(wallet.state.pending.option.settleAmount, true, wallet.resume);
    } else void wallet.resume();
  };
  // Not connected yet: the picker is the first thing on screen.
  const opened = useRef(false);
  const pickerSeen = useRef(false);
  useEffect(() => {
    if (!connection.available) return onClose();
    if (connected || opened.current) return;
    opened.current = true;
    connection.openConnect();
  }, [connection.available, connection.openConnect, connected, onClose]);
  // The picker closed without a wallet: nothing to add money from. Returning
  // from the wallet app closes the picker a moment BEFORE the connection is
  // reported, so wait for it before calling the flow abandoned.
  useEffect(() => {
    if (connection.pickerOpen) {
      pickerSeen.current = true;
      return;
    }
    if (!pickerSeen.current || connected || handedOff) return;
    const timer = setTimeout(onClose, CONNECT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [connection.pickerOpen, connected, handedOff, onClose]);
  // A status screen (pricing, didn't work) carries its own title: the topbar
  // keeps only the close button.
  const status = wallet.state.step === "busy" || wallet.state.step === "done";

  return (
    <DsSheetHost visible={connected && !handedOff} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          {status ? null : <TopbarTitle>{t("screen.HomeScreen.addFromWallet")}</TopbarTitle>}
          <TopbarTrailing>
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel={t("common.close")}
              onPress={onClose}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>
      {/* No scroll, as on the Move sheet: the card takes the height the
          keypad and the button leave. */}
      <View direction="column" align="stretch" fill="grow" paddingX="lg" paddingTop="lg">
        {/* The sheet renders at the app root, outside the provider below;
              a nested one shares its clients and its connection. */}
        <PayWalletProvider modal={false}>
          {/* On web RainbowKit wraps this in a flex row (index.html keeps its
                div in the flex chain); without a growing, shrinkable child the
                panel sizes to its text and runs off the screen. */}
          <RNView style={styles.fill}>
            <PayWalletSwapPanel
              state={wallet.state}
              holdings={wallet.holdings}
              settleLabel={label}
              formatSettle={formatReceive}
              onConnect={() => void wallet.connect()}
              onRefreshHoldings={wallet.refreshHoldings}
              onQuote={(holding, typed) => void wallet.quote(holding, typed)}
              onSelectOption={wallet.selectOption}
              onPay={pay}
              onResume={resume}
              onReset={wallet.reset}
            />
          </RNView>
        </PayWalletProvider>
      </View>
      <Footer safeAreaBottom paddingBottom="sm" />
    </DsSheetHost>
  );
};

/**
 * Mount it to start the flow; it calls onClose when the user leaves it.
 *
 * It mounts beside the home screen, and everything it shows (the sheet, the
 * wallet picker) renders elsewhere. On web RainbowKit's wrapper is a flex
 * child (index.html), so in the home's column it took half the screen until
 * the flow ended; a zero-size layer keeps it out of the layout.
 */
const WalletTopUp: React.FC<Props> = (props) => (
  <RNView style={styles.outOfLayout} pointerEvents="box-none">
    <PayWalletProvider>
      <Flow {...props} />
    </PayWalletProvider>
  </RNView>
);

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0, alignSelf: "stretch" },
  outOfLayout: { position: "absolute", width: 0, height: 0 },
});

export default WalletTopUp;
