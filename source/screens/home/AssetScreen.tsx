// @screen app.asset
// The per-asset detail behind a row of the unified home — the designer's
// "bitcoin" / "euro" boards. Same layout for every rail, only the figures and
// the Send accent change (orange in a bitcoin context, lilac in a euro one).
//
// Layout, straight off the design: header with the asset name and a close
// cross, the balance region (this rail's amount big, its converted value muted
// underneath, the currency-swap control on the left), the Receive/Send pair,
// then the list — in-flight transfers, then "Transaction history".
//
// Rendered as its own Layer so the home stays mounted behind it: closing this
// returns to the home, it does not tear the flow down.
import type * as React from "react";
import { Fragment } from "react";
import {
  Button,
  ButtonText,
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailIcon,
  ListActionTrailingText,
  ListActionTrailingTextMuted,
  ListSeparator,
  Screen,
  Scroll,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import BalanceRegion from "../../components/BalanceRegion";
import { Layer } from "../../components/LayerHost";
import type { Accent, IconName } from "@ds";
import { t } from "../../lib/i18n";

/** One in-flight transfer on this rail — the board's spinner row. */
export type WealthPendingRow = {
  key: string;
  /** Where the money is going, e.g. "To Wallet". */
  label: string;
  /** Signed amount in this rail's unit, e.g. "\u2212 6240 \u20BF". */
  amount: string;
  /** The same amount converted, muted underneath. */
  converted: string;
  /** Opens the history of the rail this row belongs to; else the list's own. */
  onPress?: () => void;
};

/**
 * One currency this rail holds, written the way the home writes a rail row:
 * logo, name, figure.
 */
export type WealthBalanceRow = {
  key: string;
  /** The currency's name, e.g. "Dollar". */
  label: string;
  /** The currency's logo — the same flag the home row carries. */
  image: number;
  /** The holding, e.g. "USD 74.60 | EUR 68.20". */
  figure: string;
  /** Opens this row's own history; omitted = not pressable. */
  onPress?: () => void;
};

export type WealthAssetView = {
  label: string;
  /** Send's accent: the context colour of this asset. */
  accent: Accent;
  /** This rail's own balance, formatted (e.g. "₿ 86969"). */
  primary: string;
  /** The same balance in the other currency (e.g. "€ 41.82"). */
  secondary: string;
};

type Props = {
  visible: boolean;
  asset: WealthAssetView | null;
  onClose: () => void;
  /** Opens the swap sheet with this rail preselected as the source. */
  onSwap: () => void;
  /** In-flight transfers, newest first. Empty renders nothing. */
  pending?: WealthPendingRow[];
  /** What the rail holds per currency, above the in-flight rows. */
  balances?: WealthBalanceRow[];
  onReceive: () => void;
  onSend: () => void;
  onHistory: () => void;
  /** Rail-specific rows between the Receive/Send pair and the list. */
  extra?: React.ReactNode;
};

type AssetDetailAction = {
  icon: IconName;
  label: string;
  subtitle?: string;
  onPress: () => void;
};

type AssetActivityListProps = {
  assetLabel: string;
  pending?: WealthPendingRow[];
  balances?: WealthBalanceRow[];
  onHistory: () => void;
  extra?: React.ReactNode;
  detail?: AssetDetailAction;
  /** False when each balance row opens its own history instead. */
  showHistory?: boolean;
};

/** Shared account rows for the full detail layer and the home-carousel canary. */
export const AssetActivityList: React.FC<AssetActivityListProps> = ({
  assetLabel,
  pending = [],
  balances = [],
  onHistory,
  extra,
  detail,
  showHistory = true,
}) => (
  <>
    {extra}
    <List>
      {balances.map((row) => (
        <Fragment key={row.key}>
          <ListAction accessibilityLabel={`${row.label}, ${row.figure}`} onPress={row.onPress}>
            <ListActionLeadingAvatar source={row.image} />
            <ListActionText>{row.label}</ListActionText>
            <ListActionTextMuted>{row.figure}</ListActionTextMuted>
            {row.onPress ? <ListActionTrailIcon name="chevron-right" /> : null}
          </ListAction>
          <ListSeparator />
        </Fragment>
      ))}
      {pending.map((row) => (
        <Fragment key={row.key}>
          <ListAction
            accessibilityLabel={t("screen.AssetScreen.pendingA11yLabel", {
              label: row.label,
            })}
            onPress={row.onPress ?? onHistory}
          >
            <ListActionLeadingAvatar name="spinner" variant="outline" />
            <ListActionText>{row.label}</ListActionText>
            <ListActionTextMuted>{t("screen.AssetScreen.pendingStatus")}</ListActionTextMuted>
            <ListActionTrailingText>{row.amount}</ListActionTrailingText>
            <ListActionTrailingTextMuted>{row.converted}</ListActionTrailingTextMuted>
          </ListAction>
          <ListSeparator />
        </Fragment>
      ))}
      {showHistory ? (
        <ListAction
          accessibilityLabel={t("screen.AssetScreen.transactionHistory")}
          onPress={onHistory}
        >
          <ListActionLeadingAvatar name="list-bullets" variant="outline" />
          <ListActionText>{t("screen.AssetScreen.transactionHistory")}</ListActionText>
          <ListActionTextMuted>
            {t("screen.AssetScreen.transactionHistorySubtitle", { asset: assetLabel })}
          </ListActionTextMuted>
          <ListActionTrailIcon name="chevron-right" />
        </ListAction>
      ) : null}
      {detail ? (
        <>
          {showHistory ? <ListSeparator /> : null}
          <ListAction accessibilityLabel={detail.label} onPress={detail.onPress}>
            <ListActionLeadingAvatar name={detail.icon} variant="outline" />
            <ListActionText>{detail.label}</ListActionText>
            {detail.subtitle ? <ListActionTextMuted>{detail.subtitle}</ListActionTextMuted> : null}
            <ListActionTrailIcon name="chevron-right" />
          </ListAction>
        </>
      ) : null}
    </List>
  </>
);

const AssetScreen: React.FC<Props> = ({
  visible,
  asset,
  onClose,
  onSwap,
  pending = [],
  balances = [],
  onReceive,
  onSend,
  onHistory,
  extra,
}) => {
  if (!asset) return null;

  return (
    <Layer visible={visible} onRequestClose={onClose}>
      <Screen>
        {/* grow-SHRINK: a flexShrink:0 box grows to its content in a browser
              rather than being capped by the screen, leaving the Scroll below
              with no bounded height and nothing to scroll. */}
        <View chrome="canvas" direction="column" align="stretch" fill="grow-shrink">
          <Header safeAreaTop chrome="canvas">
            <Topbar layout="fluid" surface="transparent">
              <TopbarTitle>{asset.label}</TopbarTitle>
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
            <View direction="column" align="stretch" gap="lg" paddingY="md">
              <BalanceRegion
                amount={asset.primary}
                converted={asset.secondary}
                onSwap={onSwap}
                swapA11yLabel={t("screen.AssetScreen.swapA11yLabel")}
              />

              <View direction="row" align="center" gap="sm" distribute="even" paddingX="lg">
                <Button size="lg" variant="soft" onPress={onReceive}>
                  <ButtonText>{t("actions.receive")}</ButtonText>
                </Button>
                <Button size="lg" variant="solid" accent={asset.accent} onPress={onSend}>
                  <ButtonText>{t("actions.send")}</ButtonText>
                </Button>
              </View>

              <AssetActivityList
                assetLabel={asset.label}
                pending={pending}
                balances={balances}
                onHistory={onHistory}
                extra={extra}
              />
            </View>
          </Scroll>
        </View>
      </Screen>
    </Layer>
  );
};

export default AssetScreen;
