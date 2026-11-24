import type React from "react";
import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";

import {
  Header,
  IconButton,
  Text,
  TextField,
  TextFieldIconButton,
  Topbar,
  TopbarLeading,
  TopbarTrailing,
  View,
} from "@ds";

import DsSheetHost from "./DsSheetHost";
import ActivityList, { type ActivityItem } from "./ActivityList";
import { searchWords } from "../lib/activitySearch";
import { t } from "../lib/i18n";
import PullToRefresh from "./PullToRefresh";

export type { ActivityItem } from "./ActivityList";

/**
 * ActivitySheet: a full-mode modal of an account's activity, drawn by
 * ActivityList (month sections, row details, Send again, contact names).
 * With `searchable`, a search field above the list narrows the rows
 * (lib/activitySearch); clearing it, or closing the sheet, shows them all.
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
  /** Shows a search field that narrows the list (#1675). */
  searchable?: boolean;
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
  searchable = false,
}) => {
  const [query, setQuery] = useState("");
  // A closed sheet opens again on the whole list.
  useEffect(() => {
    if (!visible) setQuery("");
  }, [visible]);
  const searching = searchable && searchWords(query).length > 0;

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
        {searchable ? (
          <View paddingX="lg" paddingBottom="lg">
            <TextField
              value={query}
              onChangeText={setQuery}
              inputMode="search"
              accessibilityLabel={t("component.ActivitySheet.searchLabel")}
              placeholder={t("component.ActivitySheet.searchPlaceholder")}
            >
              {query.length > 0 ? (
                <TextFieldIconButton
                  name="cross-circle"
                  accessibilityLabel={t("component.ActivitySheet.clearSearch")}
                  onPress={() => setQuery("")}
                />
              ) : null}
            </TextField>
          </View>
        ) : null}
        <ActivityList
          active={visible}
          items={items}
          query={searching ? query : ""}
          loading={loading}
          refreshing={refreshing}
          error={error}
          emptyText={searching ? t("component.ActivitySheet.noMatches") : emptyText}
        />
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
