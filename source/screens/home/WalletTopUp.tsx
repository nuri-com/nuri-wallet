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
import { useEffect, useRef } from "react";
import { StyleSheet, View as RNView } from "react-native";
import { Footer, Header, IconButton, Topbar, TopbarTitle, TopbarTrailing, View } from "@ds";
import DsSheetHost from "../../components/DsSheetHost";
import PayWalletSwapPanel from "../../components/PayWalletSwapPanel";
import { t } from "../../lib/i18n";
import { PayWalletProvider, usePayWalletConnection } from "../../lib/pay/payWallet";
import type { PayWalletSettle } from "../../services/pay/PayWalletSwapService";
import { usePayWalletSwap } from "../pay/hooks/usePayWalletSwap";

/** How long a closed picker may wait for the wallet's connection to arrive. */
const CONNECT_SETTLE_MS = 5_000;

type Props = {
  onClose: () => void;
  /** What the balance holds: its stable, or bitcoin. */
  settle: PayWalletSettle;
  /** Where it lands: the balance's own address (the card's deposit address for Visa). */
  payoutAddress: string;
  /** The balance, as the home names it ("Euro"). */
  label: string;
  /** What arrives, as the home writes that balance ("€ 22.24"). */
  formatReceive: (amount: string) => string;
};

const TopUp: React.FC<Omit<Props, "onClose">> = ({
  settle,
  payoutAddress,
  label,
  formatReceive,
}) => {
  const wallet = usePayWalletSwap(payoutAddress, settle);
  return (
    <PayWalletSwapPanel
      state={wallet.state}
      holdings={wallet.holdings}
      settleLabel={label}
      formatSettle={formatReceive}
      onConnect={() => void wallet.connect()}
      onRefreshHoldings={wallet.refreshHoldings}
      onQuote={(holding, typed) => void wallet.quote(holding, typed)}
      onSelectOption={wallet.selectOption}
      onPay={() => void wallet.pay()}
      onResume={() => void wallet.resume()}
      onReset={wallet.reset}
    />
  );
};

const Flow: React.FC<Props> = ({ onClose, ...topUp }) => {
  const connection = usePayWalletConnection();
  const connected = connection.account !== null;
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
    if (!pickerSeen.current || connected) return;
    const timer = setTimeout(onClose, CONNECT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [connection.pickerOpen, connected, onClose]);

  return (
    <DsSheetHost visible={connected} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          <TopbarTitle>{t("screen.HomeScreen.addFromWallet")}</TopbarTitle>
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
            <TopUp {...topUp} />
          </RNView>
        </PayWalletProvider>
      </View>
      <Footer safeAreaBottom paddingBottom="sm" />
    </DsSheetHost>
  );
};

/** Mount it to start the flow; it calls onClose when the user leaves it. */
const WalletTopUp: React.FC<Props> = (props) => (
  <PayWalletProvider>
    <Flow {...props} />
  </PayWalletProvider>
);

const styles = StyleSheet.create({ fill: { flex: 1, minWidth: 0, alignSelf: "stretch" } });

export default WalletTopUp;
