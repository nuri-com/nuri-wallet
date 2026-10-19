/**
 * PayLinkCreateSheet — a pay link that asks for a set amount in a set currency.
 *
 * The recipient picks what they receive (EURC, USDC or bitcoin) and, optionally,
 * how much. The link carries both (`?to=`, `?amount=`); the pay page then offers
 * only the ways to pay that land in that currency, and with an amount it quotes
 * each swap on the recipient's side so they get exactly that figure.
 *
 * Presentational over `prefilledPayLinkUrl`: an amount the currency cannot say
 * exactly (e.g. more than 6 decimals for EURC) produces no link, so nothing is
 * copied that the page would refuse.
 */

import type React from "react";
import { useState } from "react";

import {
  Button,
  ButtonIcon,
  ButtonText,
  Footer,
  Header,
  IconButton,
  Scroll,
  Text,
  TextField,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import DsSheetHost from "./DsSheetHost";
import { copyToClipboard } from "../lib/copyToClipboard";
import { t } from "../lib/i18n";
import { type PaySettleCurrency, prefilledPayLinkUrl } from "../lib/pay/payLinkPath";

const K = "screen.PayLinkCreate";

/** What the recipient can receive, with the unit the amount is typed in. */
export const PAY_LINK_CURRENCIES: ReadonlyArray<{ key: PaySettleCurrency; unit: string }> = [
  { key: "EURC_BASE", unit: "EURC" },
  { key: "USDC_BASE", unit: "USDC" },
  { key: "BTC", unit: "BTC" },
];

type Props = {
  visible: boolean;
  onClose: () => void;
  origin: string;
  username: string;
};

const PayLinkCreateSheet: React.FC<Props> = ({ visible, onClose, origin, username }) => {
  const [currency, setCurrency] = useState<PaySettleCurrency>("EURC_BASE");
  const [amount, setAmount] = useState("");
  const [copied, setCopied] = useState(false);

  const typed = amount.replace(",", ".").trim();
  const link = prefilledPayLinkUrl(origin, username, currency, typed || null);
  const unit = PAY_LINK_CURRENCIES.find((c) => c.key === currency)?.unit ?? "";

  const close = () => {
    setCopied(false);
    onClose();
  };

  return (
    // Full mode: the DS forbids inputs in a sheet; only a full page moves the
    // field and the Copy footer above the keyboard.
    <DsSheetHost visible={visible} onClose={close} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t(`${K}.title`)}</TopbarTitle>
          <TopbarTrailing>
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel={t("common.close")}
              onPress={close}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>

      <Scroll>
        <View direction="column" align="stretch" gap="md" paddingX="lg" paddingBottom="lg">
          <Text size="md" muted>
            {t(`${K}.currency`)}
          </Text>
          <View direction="row" gap="sm" distribute="even">
            {PAY_LINK_CURRENCIES.map((option) => (
              <Button
                key={option.key}
                size="sm"
                variant={currency === option.key ? "solid" : "soft"}
                {...(currency === option.key ? { accent: "lilac" as const } : {})}
                onPress={() => {
                  setCurrency(option.key);
                  setCopied(false);
                }}
                accessibilityLabel={t(`${K}.asset.${option.key}`)}
              >
                <ButtonText>{t(`${K}.asset.${option.key}`)}</ButtonText>
              </Button>
            ))}
          </View>

          <TextField
            value={amount}
            onChangeText={(next) => {
              setAmount(next);
              setCopied(false);
            }}
            inputMode="decimal"
            placeholder={t(`${K}.amountPlaceholder`, { unit })}
            accessibilityLabel={t(`${K}.amountLabel`, { unit })}
          />
          <Text size="sm" muted>
            {typed && !link ? t(`${K}.amountInvalid`, { unit }) : t(`${K}.hint`)}
          </Text>
          {link ? <Text size="sm">{link.replace(/^https?:\/\//, "")}</Text> : null}
        </View>
      </Scroll>

      <Footer
        safeAreaBottom
        chrome="canvas"
        direction="column"
        align="stretch"
        gap="sm"
        paddingBottom="sm"
        paddingX="lg"
      >
        <Button
          size="lg"
          variant="solid"
          accent="lilac"
          disabled={!link}
          onPress={async () => {
            if (!link) return;
            // "Copied" only when the clipboard actually took it.
            setCopied(await copyToClipboard(link));
          }}
        >
          <ButtonIcon name="copy" />
          <ButtonText>{copied ? t(`${K}.copied`) : t(`${K}.copy`)}</ButtonText>
        </Button>
      </Footer>
    </DsSheetHost>
  );
};

export default PayLinkCreateSheet;
