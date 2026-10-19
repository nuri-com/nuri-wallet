/**
 * PayWalletTokenPicker — the payer's own tokens, searchable, logo-illustrated.
 *
 * Same shape as CountryPicker (search field + avatar rows), fed by the LI.FI
 * balances of the connected wallet. Rows show the token logo, "SYMBOL · Chain"
 * and the exact balance as muted trailing text. Search matches symbol, name or
 * chain. Hosted in a full sheet by PayWalletSwapPanel.
 */

import type React from "react";
import { Fragment, useMemo, useState } from "react";

import {
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  ListSeparator,
  Scroll,
  TextField,
  TextFieldIconButton,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import DsSheetHost from "./DsSheetHost";
import { t } from "../lib/i18n";
import {
  payWalletLogoSource,
  type PayWalletHolding,
} from "../services/pay/PayWalletBalanceService";
import { displayDecimal } from "../services/pay/PayWalletSwapService";

const K = "screen.PayLink.wallet";

export const PAY_WALLET_CHAIN_NAME: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum",
  10: "Optimism",
  137: "Polygon",
  100: "Gnosis",
};

export const payWalletHoldingKey = (holding: PayWalletHolding) =>
  `${holding.chainId}:${holding.address.toLowerCase()}`;

type Props = {
  visible: boolean;
  holdings: PayWalletHolding[];
  onClose: () => void;
  onSelect: (key: string) => void;
};

const PayWalletTokenPicker: React.FC<Props> = ({ visible, holdings, onClose, onSelect }) => {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0) return holdings;
    return holdings.filter((holding) =>
      [holding.symbol, holding.name, PAY_WALLET_CHAIN_NAME[holding.chainId] ?? ""].some((field) =>
        field.toLocaleLowerCase().includes(needle),
      ),
    );
  }, [holdings, query]);

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t(`${K}.chooseToken`)}</TopbarTitle>
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
      <Scroll safeAreaBottom>
        <View direction="column" align="stretch" gap="md" paddingX="lg" paddingBottom="lg">
          <TextField
            value={query}
            onChangeText={setQuery}
            accessibilityLabel={t(`${K}.searchToken`)}
            placeholder={t(`${K}.searchToken`)}
          >
            {query.length > 0 ? (
              <TextFieldIconButton
                name="cross-circle"
                accessibilityLabel={t("component.CountryPicker.clearSearch")}
                onPress={() => setQuery("")}
              />
            ) : null}
          </TextField>
          <List>
            {filtered.map((holding, index) => {
              const chain = PAY_WALLET_CHAIN_NAME[holding.chainId] ?? String(holding.chainId);
              const balance = displayDecimal(holding.amount, 4);
              const logo = payWalletLogoSource(holding.logoURI);
              return (
                <Fragment key={payWalletHoldingKey(holding)}>
                  {index > 0 ? <ListSeparator /> : null}
                  <ListAction
                    accessibilityLabel={`${holding.symbol}, ${chain}, ${balance}`}
                    onPress={() => {
                      setQuery("");
                      onSelect(payWalletHoldingKey(holding));
                    }}
                  >
                    {logo ? (
                      <ListActionLeadingAvatar source={logo} />
                    ) : (
                      <ListActionLeadingAvatar name="wallet" variant="solid" accent="lilac" />
                    )}
                    <ListActionText>{`${holding.symbol} · ${chain}`}</ListActionText>
                    <ListActionTextMuted>{balance}</ListActionTextMuted>
                  </ListAction>
                </Fragment>
              );
            })}
          </List>
        </View>
      </Scroll>
    </DsSheetHost>
  );
};

export default PayWalletTokenPicker;
