import { SwapKitV2OrderStore } from "../../services/swapkit/SwapKitV2OrderStore";
import { statusSheetAmountLine, storedOrderIdFor } from "./swapStatusAmount";
import { errMsg } from "../../lib/errorMessage";
import type { FC } from "react";
import { Fragment, useEffect, useState } from "react";

import {
  Alert,
  AlertIcon,
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailingText,
  ListSeparator,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import DsSheetHost from "../../components/DsSheetHost";
import { formatSwapProviders } from "../../lib/formatting";
import { t } from "../../lib/i18n";
import { EventBus } from "../../services/events/AppEventBusService";
import { getSwapKitV2LastView } from "../../services/swapkit/SwapKitV2PendingTracker";
import { getSwapKitV2RecoveryKey } from "../../services/swapkit/SwapKitV2RecoveryKey";
import {
  asSwapKitV2OrderId,
  getSwapKitV2Status,
  isSwapKitV2Terminal,
  type SwapKitV2OrderView,
} from "../../services/swapkit/SwapKitV2Service";

const assetLabel = (asset: string): string => {
  const code = asset.toUpperCase();
  if (code === "BTC_ARKADE") return "Bitcoin (Arkade)";
  if (code === "BTC_LN") return "Bitcoin (Lightning)";
  if (code.startsWith("BTC")) return "Bitcoin";
  const [symbol, chain] = code.split("_");
  return chain ? `${symbol} ${chain.charAt(0)}${chain.slice(1).toLowerCase()}` : symbol;
};

// SwapKit provider names (CoW, Satora …) — same labels as the route
// cards, no domains (Emin).
const providerLabel = (provider: unknown): string =>
  formatSwapProviders([provider == null ? null : String(provider)]) ?? "";

type V2Leg = { leg?: string; provider?: string; terminal?: boolean };

/** What the wallet recorded when the user accepted, for an order the server
 * has not described yet: the route and its provider, still running. */
type LocalOrder = { from?: string; to?: string; optionId?: string } | null;

function v2Legs(view: SwapKitV2OrderView | null, local: LocalOrder): V2Leg[] {
  if (Array.isArray(view?.legs)) return view.legs as V2Leg[];
  const accepted = view?.accepted as { provider?: string } | undefined;
  if (accepted?.provider && view) {
    return [{ provider: accepted.provider, terminal: isSwapKitV2Terminal(view) }];
  }
  const provider = local?.optionId?.split(":")[0];
  return !view && local?.from && local.to ? [{ provider, terminal: false }] : [];
}

function routePath(view: SwapKitV2OrderView | null, local: LocalOrder): string[] {
  if (Array.isArray(view?.path)) return view.path as string[];
  const accepted = view?.accepted as { from?: string; to?: string } | undefined;
  if (accepted?.from && accepted.to) return [accepted.from, accepted.to];
  return local?.from && local.to ? [local.from, local.to] : [];
}

// The outcome in words, never the server's status code.
const terminalLabel = (status: string | undefined): string => {
  const code = String(status || "").toUpperCase();
  if (code === "COMPLETED") return t("swap.move.completed");
  if (code === "REFUNDED") return t("swap.move.refunded");
  return t("swap.move.failed");
};

type Props = { visible: boolean; onClose: () => void; orderId: string };

/** V2-only status sheet: all reads carry the order's durable recovery capability. */
const SwapStatusDetailSheet: FC<Props> = ({ visible, onClose, orderId }) => {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SwapKitV2OrderView | null>(null);

  useEffect(() => {
    setStatus(null);
    setError(null);
    if (!visible || !orderId.startsWith("ord_")) return;
    let cancelled = false;
    const load = async () => {
      await SwapKitV2OrderStore.hydrate();
      // What the tracker already saw goes up first: deriving a recovery key
      // can fail, and must not hide a view the app already holds.
      const initial = getSwapKitV2LastView(orderId);
      if (initial && !cancelled) setStatus(initial);
      const recoveryKey =
        SwapKitV2OrderStore.get(orderId)?.recoveryKey ?? (await getSwapKitV2RecoveryKey());
      const fresh = await getSwapKitV2Status(asSwapKitV2OrderId(orderId), { recoveryKey });
      if (!cancelled) {
        setStatus(fresh);
      }
    };
    void load().catch((error) => {
      if (!cancelled) setError(errMsg(error));
    });
    const off = EventBus.on("transactions:refresh", () => {
      const latest = getSwapKitV2LastView(orderId);
      if (latest && !cancelled) setStatus(latest);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [visible, orderId]);

  const local = SwapKitV2OrderStore.get(storedOrderIdFor(orderId));
  const path = routePath(status, local);
  const legs = v2Legs(status, local);
  const activeIndex = legs.findIndex((leg) => !leg.terminal);
  // The accepted quote from the moment the sheet opens: this wallet's own
  // committed bounds until the server's view (the same strings) arrives.
  const amountLine = statusSheetAmountLine(orderId, status, (id) => SwapKitV2OrderStore.get(id));
  const terminal = status ? isSwapKitV2Terminal(status) : false;
  // Only human-facing failure text; raw provider states stay in the support report.
  const explanation = error ?? status?.failure?.message ?? null;

  const contactSupport = () => {
    EventBus.emit("support:report", {
      message: [
        "Swap support request",
        `Order: ${orderId}`,
        `Status: ${status?.status ?? "unknown"}`,
        `Route: ${path.join(" -> ") || "unknown"}`,
        ...(explanation ? [`Explanation: ${explanation}`] : []),
        ...(status?.rawProviderState ? [`Provider state: ${status.rawProviderState}`] : []),
      ].join("\n"),
    });
    onClose();
  };

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t("screen.SwapStatusSheet.title")}</TopbarTitle>
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
      <Scroll>
        <View direction="column" align="stretch" gap="lg" paddingBottom="lg">
          {amountLine ? (
            <View paddingX="lg">
              <Text size="md" emphasis>
                {amountLine}
              </Text>
            </View>
          ) : null}
          <View paddingX="lg">
            <Alert variant="soft" accent="lilac">
              <AlertIcon name="wallet" />
              {terminal ? terminalLabel(status?.status) : t("swap.status.exchanging")}
            </Alert>
          </View>
          {explanation ? (
            <View paddingX="lg">
              <Text size="sm" muted>
                {explanation}
              </Text>
            </View>
          ) : null}
          {legs.length > 0 ? (
            <List>
              {legs.map((leg, index) => {
                const done = leg.terminal === true;
                const label =
                  path.length > index + 1
                    ? `${assetLabel(path[index])} → ${assetLabel(path[index + 1])}`
                    : String(leg.leg || "");
                const provider = providerLabel(leg.provider);
                return (
                  <Fragment key={leg.leg ?? index}>
                    {index > 0 ? <ListSeparator /> : null}
                    <ListAction accessibilityLabel={label}>
                      <ListActionLeadingAvatar
                        name={done ? "check-circle" : "transfer-horizontal"}
                        variant="outline"
                      />
                      <ListActionText>{label}</ListActionText>
                      {provider ? <ListActionTextMuted>{provider}</ListActionTextMuted> : null}
                      <ListActionTrailingText>
                        {done
                          ? t("screen.SwapStatusSheet.stepDone")
                          : index === activeIndex
                            ? t("screen.SwapStatusSheet.stepRunning")
                            : t("screen.SwapStatusSheet.stepWaiting")}
                      </ListActionTrailingText>
                    </ListAction>
                  </Fragment>
                );
              })}
            </List>
          ) : null}
          <View paddingX="lg">
            <Text size="sm" muted>
              {t("screen.SwapStatusSheet.autoNote")}
            </Text>
          </View>
        </View>
      </Scroll>
      <Footer
        safeAreaBottom
        chrome="canvas"
        direction="column"
        align="stretch"
        gap="sm"
        paddingBottom="lg"
        paddingX="lg"
      >
        <Button
          size="lg"
          variant="soft"
          onPress={contactSupport}
          accessibilityLabel={t("screen.SwapStatusSheet.contactSupport")}
        >
          <ButtonText>{t("screen.SwapStatusSheet.contactSupport")}</ButtonText>
        </Button>
      </Footer>
    </DsSheetHost>
  );
};

export default SwapStatusDetailSheet;
