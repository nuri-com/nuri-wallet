import type React from "react";
import { StyleSheet } from "react-native";

import { Header, IconButton, Text, Topbar, TopbarLeading, TopbarTrailing } from "@ds";

import DsSheetHost from "./DsSheetHost";
import ActivityList, { type ActivityItem } from "./ActivityList";
import { t } from "../lib/i18n";
import PullToRefresh from "./PullToRefresh";

export type { ActivityItem } from "./ActivityList";

/**
 * ActivitySheet: a full-mode modal of an account's activity, drawn by
 * ActivityList (month sections, row details, Send again, contact names).
 */

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
}) => (
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
      <ActivityList
        active={visible}
        items={items}
        loading={loading}
        refreshing={refreshing}
        error={error}
        emptyText={emptyText}
      />
    </PullToRefresh>
  </DsSheetHost>
);

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
