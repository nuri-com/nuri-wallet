/**
 * ChoiceSheet — generic DS "choice sheet" recipe (new nuri design system, @ds).
 *
 * A stateless bottom sheet presenting a titled list of choices plus an optional
 * footer action button. Hosted via DsSheetHost, which owns the modal/provider
 * machinery and exit-animation teardown.
 */

import * as React from "react";

import {
  Button,
  ButtonIcon,
  ButtonText,
  Footer,
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailIcon,
  ListSeparator,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import type { ImageSourcePropType } from "react-native";

import type { Accent, IconName, ModalMode } from "@ds";

import DsSheetHost from "./DsSheetHost";
import { t } from "../lib/i18n";

export type ChoiceSheetItem<K extends string> = {
  key: K;
  icon?: IconName;
  /**
   * The rail's own logo, drawn instead of an icon. Preferred wherever the rail
   * has one: the home board already identifies every rail by its mark, and a
   * sheet that offers the same rails must not re-identify them with a different
   * set of symbols.
   */
  image?: ImageSourcePropType;
  /** Avatar accent. Convention: orange = bitcoin, lilac = EVM wallet/cash/bank, neutral = card. */
  accent?: Accent;
  label: string;
  sublabel?: string;
  disabled?: boolean;
};

export type ChoiceSheetProps<K extends string> = {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  items: ChoiceSheetItem<K>[];
  onSelect: (key: K) => void;
  footerAction?: { key: K; label: string; icon?: IconName };
  /**
   * `"full"` to show the list as a full page. A sheet is content-height up to
   * the DS cap and scrolls past it.
   */
  mode?: ModalMode;
};

export default function ChoiceSheet<K extends string>({
  visible,
  onClose,
  title,
  subtitle,
  items,
  onSelect,
  footerAction,
  mode = "sheet",
}: ChoiceSheetProps<K>) {
  return (
    <DsSheetHost visible={visible} onClose={onClose} mode={mode}>
      {/* A full page starts under the status bar like every other page; a
          bottom sheet has no inset and keeps its own top step. */}
      <Header
        {...(mode === "full"
          ? { safeAreaTop: true, chrome: "canvas" as const }
          : { paddingTop: "lg" as const })}
      >
        <Topbar surface="transparent" layout="fluid">
          {/* The title belongs in the topbar row, next to the ✕ — not one row
              below it. TopbarTitle is the DS slot for it (lg/emphasis/one-line). */}
          <TopbarTitle>{title}</TopbarTitle>
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

      <Scroll safeAreaBottom={!footerAction}>
        <View direction="column" align="stretch" justify="start" gap="xl" paddingBottom="lg">
          {subtitle ? (
            <View direction="column" align="stretch" justify="start" paddingX="lg">
              <Text size="md" muted>
                {subtitle}
              </Text>
            </View>
          ) : null}

          <List>
            {items.map((item, index) => (
              <React.Fragment key={item.key}>
                {index > 0 ? <ListSeparator /> : null}
                <ListAction
                  accessibilityLabel={item.label}
                  disabled={item.disabled}
                  onPress={() => onSelect(item.key)}
                >
                  {item.image ? (
                    <ListActionLeadingAvatar source={item.image} />
                  ) : item.icon ? (
                    <ListActionLeadingAvatar
                      name={item.icon}
                      variant="solid"
                      accent={item.accent}
                    />
                  ) : null}
                  <ListActionText>{item.label}</ListActionText>
                  {item.sublabel ? (
                    <ListActionTextMuted>{item.sublabel}</ListActionTextMuted>
                  ) : null}
                  {item.disabled ? null : <ListActionTrailIcon name="chevron-right" />}
                </ListAction>
              </React.Fragment>
            ))}
          </List>
        </View>
      </Scroll>

      {footerAction ? (
        <Footer
          safeAreaBottom
          chrome="canvas"
          direction="column"
          align="stretch"
          paddingBottom="sm"
          paddingX="lg"
        >
          <Button
            size="lg"
            variant="solid"
            accent="lilac"
            onPress={() => onSelect(footerAction.key)}
          >
            <ButtonText>{footerAction.label}</ButtonText>
            {footerAction.icon ? <ButtonIcon name={footerAction.icon} /> : null}
          </Button>
        </Footer>
      ) : null}
    </DsSheetHost>
  );
}
