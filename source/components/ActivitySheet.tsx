import React, { useMemo } from "react";
import { StyleSheet } from "react-native";

import {
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailingText,
  ListActionTrailingTextMuted,
  ListSeparator,
  Text,
  Topbar,
  TopbarLeading,
  TopbarTrailing,
  View,
} from "@ds";
import type { IconName } from "@ds";

import DsSheetHost from "./DsSheetHost";
import { i18n, t } from "../lib/i18n";
import PullToRefresh from "./PullToRefresh";

/**
 * ActivitySheet — the DS activity layout: a full-mode modal of transaction
 * rows grouped into month sections ("Pending" first, then "This month", then
 * month names). Consumers pass a flat, newest-first item list; grouping is
 * done here. Icon convention: arrow-up = outgoing, plus = incoming,
 * transfer-horizontal = conversion/migration, cross = failed/rejected.
 *
 * TODO: add a per-transaction detail sheet as the uniform tap target later.
 * Today row taps differ per rail (bitcoin onchain → mempool.space in the
 * browser, bank rows → send-again prefill, card/arkade rows → nothing) with
 * no visual affordance difference; a detail sheet would host explorer /
 * send-again / details as explicit actions instead.
 */

export type ActivityItem = {
  key: string;
  icon: IconName;
  label: string;
  sublabel?: string;
  /** Trailing primary amount, already signed/formatted (e.g. "- 12.00 €"). */
  amount?: string;
  /** Trailing secondary line (e.g. the sats or ≈-EUR value). */
  amountSecondary?: string;
  onPress?: () => void;
  /** Pending rows sort into a leading "Pending" section. */
  pending?: boolean;
  /** ISO timestamp used for the month grouping. */
  createdAt?: string;
};

type Section = { key: string; label: string; items: ActivityItem[] };

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Optional title shown in the topbar. Defaults to no title (close button only). */
  title?: string;
  /** Flat list, pending-first then newest-first (the consumers' existing order). */
  items: ActivityItem[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  /** Renders the download button in the topbar. */
  onExport?: () => void;
  exportDisabled?: boolean;
  error?: string | null;
  emptyText?: string;
};

function sectionLabel(date: Date, now: Date): string {
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return t("common.thisMonth");
  }
  return date.toLocaleDateString(i18n.locale, {
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function buildSections(items: ActivityItem[]): Section[] {
  const sections: Section[] = [];
  const pendingItems = items.filter((item) => item.pending);
  if (pendingItems.length > 0) {
    sections.push({ key: "pending", label: t("common.pending"), items: pendingItems });
  }
  const now = new Date();
  let currentKey = "";
  for (const item of items) {
    if (item.pending) continue;
    const date = item.createdAt ? new Date(item.createdAt) : null;
    const valid = date !== null && !Number.isNaN(date.getTime());
    const monthKey = valid ? `${date.getFullYear()}-${date.getMonth()}` : "unknown";
    if (monthKey !== currentKey || sections.length === 0) {
      currentKey = monthKey;
      sections.push({
        key: `${monthKey}-${sections.length}`,
        label: valid ? sectionLabel(date, now) : "",
        items: [],
      });
    }
    sections[sections.length - 1].items.push(item);
  }
  return sections.filter((section) => section.items.length > 0);
}

const ActivitySheet: React.FC<Props> = ({
  visible,
  onClose,
  title,
  items,
  loading,
  refreshing,
  onRefresh,
  onExport,
  exportDisabled,
  error,
  emptyText,
}) => {
  const sections = useMemo(() => buildSections(items), [items]);

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          {title ? (
            <TopbarLeading>
              <Text size="lg" emphasis>
                {title}
              </Text>
            </TopbarLeading>
          ) : null}
          <TopbarTrailing>
            {onExport ? (
              <IconButton
                icon="download"
                variant="soft"
                disabled={exportDisabled}
                accessibilityLabel={t("common.exportCsv")}
                onPress={onExport}
              />
            ) : null}
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel={t("common.close")}
              onPress={onClose}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>

      {/* One cross-platform pull-to-refresh (native + web, DS spinner). It takes
          the box the header leaves over, so it scrolls inside it. */}
      <PullToRefresh
        refreshing={refreshing}
        onRefresh={onRefresh}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View direction="column" align="stretch" justify="start" gap="xl" paddingBottom="lg">
          {error ? (
            <View paddingX="lg">
              <Text size="md" emphasis align="center">
                {error}
              </Text>
            </View>
          ) : null}

          {/* Cached rows render immediately; the background fetch fills in
              silently. The loading state only exists for a truly empty feed. */}
          {loading && !refreshing && items.length === 0 ? (
            <View paddingX="lg" paddingY="md">
              <Text size="md" muted align="center">
                {t("common.loading")}
              </Text>
            </View>
          ) : null}

          {!loading && items.length === 0 && !error ? (
            <View paddingX="lg" paddingY="md">
              <Text size="md" muted align="center">
                {emptyText ?? t("screen.CardTransactionsModal.empty")}
              </Text>
            </View>
          ) : null}

          {sections.map((section) => (
            <View key={section.key} direction="column" align="stretch" justify="start" gap="md">
              {section.label ? (
                <View paddingX="lg">
                  <Text size="lg" emphasis>
                    {section.label}
                  </Text>
                </View>
              ) : null}
              <List>
                {section.items.map((item, index) => (
                  <React.Fragment key={item.key}>
                    {index > 0 ? <ListSeparator /> : null}
                    <ListAction accessibilityLabel={item.label} onPress={item.onPress}>
                      <ListActionLeadingAvatar
                        name={item.pending ? "spinner" : item.icon}
                        variant="outline"
                      />
                      <ListActionText>{item.label}</ListActionText>
                      {item.sublabel ? (
                        <ListActionTextMuted>{item.sublabel}</ListActionTextMuted>
                      ) : null}
                      {item.amount ? (
                        <ListActionTrailingText>{item.amount}</ListActionTrailingText>
                      ) : null}
                      {item.amountSecondary ? (
                        <ListActionTrailingTextMuted>
                          {item.amountSecondary}
                        </ListActionTrailingTextMuted>
                      ) : null}
                    </ListAction>
                  </React.Fragment>
                ))}
              </List>
            </View>
          ))}
        </View>
      </PullToRefresh>
    </DsSheetHost>
  );
};

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingBottom: 32,
  },
});

export default ActivitySheet;
