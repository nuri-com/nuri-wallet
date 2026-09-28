import type { FC } from "react";
import { Linking, View as RNView, StyleSheet } from "react-native";
import { Button, ButtonText, Text, View } from "@ds";
import { EventBus } from "../services/events/AppEventBusService";
import { NURI_INTERNAL_LINK_PATTERN } from "../lib/internalLinks";

type DeliveryState = "pending" | "sent" | "failed";

type Props = {
  children: string;
  outgoing: boolean;
  /** Highlight incoming message (e.g. support team) */
  highlight?: boolean;
  /** Timestamp string */
  timestamp?: string;
  /** Delivery state for outgoing messages */
  deliveryState?: DeliveryState;
};

const CHAT_URL_PATTERN = /\b(?:(?:nuri|nuriwallet)(?:-[a-z0-9]+)?:\/\/|https?:\/\/|www\.)[^\s<]+/gi;
const TRAILING_URL_PUNCTUATION = /[.,!?;:)\]}]$/;

function splitTrailingPunctuation(value: string): { link: string; trailing: string } {
  let link = value;
  let trailing = "";
  while (link && TRAILING_URL_PUNCTUATION.test(link)) {
    trailing = `${link.slice(-1)}${trailing}`;
    link = link.slice(0, -1);
  }
  return { link, trailing };
}

function openChatLink(value: string): void {
  const url = /^www\./i.test(value) ? `https://${value}` : value;
  if (NURI_INTERNAL_LINK_PATTERN.test(url)) {
    EventBus.emit("app:openInternalLink", url);
    return;
  }
  void Linking.openURL(url).catch(() => {});
}

function normalizeInternalLink(url: string): string {
  if (!NURI_INTERNAL_LINK_PATTERN.test(url) || url.includes("?")) return url;
  return url.replace("&name=", "?name=");
}

function parseChatContent(content: string): {
  actions: Array<{ label: string; url: string }>;
  text: string;
} {
  const actions: Array<{ label: string; url: string }> = [];
  const text: string[] = [];
  let cursor = 0;

  for (const match of content.matchAll(CHAT_URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) text.push(content.slice(cursor, index));
    const raw = match[0];
    const { link } = splitTrailingPunctuation(raw);
    if (link) {
      const url = normalizeInternalLink(link);
      const query = url.split("?")[1] ?? "";
      const name = new URLSearchParams(query).get("name")?.trim();
      actions.push({ label: name?.slice(0, 64) || "Open Link", url });
    }
    cursor = index + raw.length;
  }

  if (cursor < content.length) text.push(content.slice(cursor));
  return { actions, text: text.join("").trim() };
}

const DELIVERY_CHECKS: Record<DeliveryState, string> = {
  pending: "✓",
  sent: "✓✓",
  failed: "!",
};

// DS cards in two colors: support messages solid lilac (the accent-taking
// variant — soft ignores accent, it maps to chrome), own messages soft neutral.
const ChatBubble: FC<Props> = ({
  children,
  outgoing,
  highlight = false,
  timestamp,
  deliveryState,
}) => {
  const { actions, text } = parseChatContent(children);
  const actionButtons = actions.map((action, index) => (
    <Button
      key={`${action.url}-${index}`}
      size="lg"
      variant="solid"
      accent="lilac"
      onPress={() => openChatLink(action.url)}
    >
      <ButtonText>{action.label}</ButtonText>
    </Button>
  ));
  const meta =
    timestamp || (outgoing && deliveryState) ? (
      <View direction="row" justify="end" align="center" gap="xs">
        {timestamp ? (
          <Text size="xs" muted>
            {timestamp}
          </Text>
        ) : null}
        {outgoing && deliveryState ? (
          <Text size="xs" emphasis muted={deliveryState !== "sent"}>
            {DELIVERY_CHECKS[deliveryState]}
          </Text>
        ) : null}
      </View>
    ) : null;

  if (!text && actions.length > 0) {
    return (
      <View direction="column" align="stretch" gap="xs">
        {actionButtons}
        {meta}
      </View>
    );
  }

  return (
    // Structural: chat alignment (own right / counterparty left) and the 75%
    // width cap need alignSelf + a percentage width, which DS boxes don't model.
    <RNView style={[styles.wrap, outgoing ? styles.outgoing : styles.incoming]}>
      <View
        variant={!outgoing && highlight ? "solid" : "soft"}
        accent={!outgoing && highlight ? "lilac" : "neutral"}
        radius="lg"
        padding="md"
        direction="column"
        align="stretch"
        gap="xs"
      >
        {text ? <Text size="md">{text}</Text> : null}
        {actionButtons}
        {meta}
      </View>
    </RNView>
  );
};

const styles = StyleSheet.create({
  wrap: {
    maxWidth: "75%",
    marginBottom: 12,
  },
  incoming: {
    alignSelf: "flex-start",
  },
  outgoing: {
    alignSelf: "flex-end",
  },
});

export default ChatBubble;
