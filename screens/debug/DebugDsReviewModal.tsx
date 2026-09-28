/**
 * DebugDsReviewModal — debug-only catalog of the vendored nuri design system (@ds).
 *
 * Renders every DS component family with its variants/states so the DS can be
 * reviewed visually on real builds. The modal is its own native window layer,
 * so the DS root mounts inside the Modal subtree (mirrors the probe App.tsx):
 * Modal > SafeAreaProvider > NuriRoot (theme + overlay outlet + canvas paint +
 * DS safe-area, fed plain inset numbers from the ONE useSafeAreaInsets read).
 */

import * as React from "react";
import { Modal } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import {
  Alert,
  AlertButton,
  AlertIcon,
  Button,
  ButtonIcon,
  ButtonText,
  Footer,
  Header,
  IconAvatar,
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
  Modal as DsModal,
  ModalPanel as DsModalPanel,
  NuriIcon,
  NuriRoot,
  Screen,
  Scroll,
  Separator,
  TabBar,
  TabBarItem,
  TabBarItemIcon,
  TabBarItemLabel,
  Text,
  TextField,
  TextFieldButton,
  TextFieldIconButton,
  TextFieldLabel,
  Topbar,
  TopbarCenter,
  TopbarLeading,
  TopbarTrailing,
  View,
} from "@ds";
import type { DebugDsReviewProps } from "../../types/debug";

const noop = () => {};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View direction="column" align="stretch" justify="start" gap="md">
      <Text size="lg" emphasis>
        {title}
      </Text>
      {children}
    </View>
  );
}

function ContentSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <DsModal open={open} mode="sheet" onOpenChange={(next) => !next && onClose()}>
      <DsModalPanel>
        <Header paddingTop="lg">
          <Topbar surface="transparent">
            <TopbarTrailing>
              <IconButton
                icon="cross"
                variant="soft"
                accessibilityLabel="Close sheet modal"
                onPress={onClose}
              />
            </TopbarTrailing>
          </Topbar>
        </Header>

        <Scroll safeAreaBottom>
          <View direction="column" align="stretch" justify="start" gap="xl" paddingBottom="lg">
            <View direction="column" align="stretch" justify="start" gap="sm" paddingX="lg">
              <Text size="lg" emphasis>
                Sheet-mode modal
              </Text>
              <Text size="md" muted>
                Sized to its content, dismissible via scrim or close
              </Text>
            </View>

            <List>
              <ListAction accessibilityLabel="Bitcoin wallet" onPress={onClose}>
                <ListActionLeadingAvatar name="wallet" variant="solid" accent="orange" />
                <ListActionText>Bitcoin wallet</ListActionText>
                <ListActionTrailIcon name="chevron-right" />
              </ListAction>
              <ListSeparator />
              <ListAction accessibilityLabel="Card" onPress={onClose}>
                <ListActionLeadingAvatar name="card" variant="solid" accent="lilac" />
                <ListActionText>Card</ListActionText>
                <ListActionTrailIcon name="chevron-right" />
              </ListAction>
            </List>
          </View>
        </Scroll>
      </DsModalPanel>
    </DsModal>
  );
}

function FullSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = React.useState("");
  return (
    <DsModal open={open} mode="full" onOpenChange={(next) => !next && onClose()}>
      <DsModalPanel>
        <Header chrome="canvas">
          <Topbar surface="transparent">
            <TopbarTrailing>
              <IconButton
                icon="cross"
                variant="soft"
                accessibilityLabel="Close full modal"
                onPress={onClose}
              />
            </TopbarTrailing>
          </Topbar>
        </Header>

        <Scroll>
          <View direction="column" align="stretch" justify="start" gap="xl" paddingX="lg">
            <View direction="column" align="stretch" justify="start" gap="sm">
              <Text size="lg" emphasis>
                Full-mode modal
              </Text>
              <Text size="md" muted>
                Header, scroll, and footer — the form-sheet pattern
              </Text>
            </View>

            <TextField value={name} onChangeText={setName} placeholder="eg. Satoshi">
              <TextFieldLabel>First name*</TextFieldLabel>
            </TextField>
          </View>
        </Scroll>

        <Footer
          safeAreaBottom
          chrome="canvas"
          direction="column"
          align="stretch"
          paddingBottom="sm"
          paddingX="lg"
        >
          <Button size="lg" variant="solid" accent="lilac" onPress={onClose}>
            Done
          </Button>
        </Footer>
      </DsModalPanel>
    </DsModal>
  );
}

function Catalog({
  mode,
  onToggleTheme,
  onClose,
}: {
  mode: "light" | "dark";
  onToggleTheme: () => void;
  onClose: () => void;
}) {
  const [selectedTab, setSelectedTab] = React.useState<"bitcoin" | "bank" | "euro">("bitcoin");
  const [contentSheetOpen, setContentSheetOpen] = React.useState(false);
  const [fullSheetOpen, setFullSheetOpen] = React.useState(false);
  const [plainValue, setPlainValue] = React.useState("");
  const [buttonValue, setButtonValue] = React.useState("");
  const [iconValue, setIconValue] = React.useState("");

  return (
    <>
      <Screen>
        <Header safeAreaTop chrome="canvas">
          <Topbar>
            <TopbarLeading>
              <NuriIcon name="nuri" />
            </TopbarLeading>
            <TopbarTrailing>
              <IconButton
                icon={mode === "light" ? "eye" : "eye-hidden"}
                variant="soft"
                accessibilityLabel="Toggle light and dark theme"
                onPress={onToggleTheme}
              />
              <IconButton
                icon="cross"
                variant="soft"
                accessibilityLabel="Close design system review"
                onPress={onClose}
              />
            </TopbarTrailing>
          </Topbar>
        </Header>

        <Scroll safeAreaBottom>
          <View
            direction="column"
            align="stretch"
            justify="start"
            gap="xl"
            paddingX="lg"
            paddingY="md"
          >
            <Section title="Button">
              <View direction="row" align="center" gap="sm">
                <Button variant="solid" size="sm" onPress={noop}>
                  Solid sm
                </Button>
                <Button variant="soft" size="sm" onPress={noop}>
                  Soft sm
                </Button>
              </View>
              <View direction="row" align="center" gap="sm">
                <Button variant="solid" size="lg" onPress={noop}>
                  Solid lg
                </Button>
                <Button variant="soft" size="lg" onPress={noop}>
                  Soft lg
                </Button>
              </View>
              <View direction="row" align="center" gap="sm">
                <Button variant="solid" size="sm" onPress={noop}>
                  Default
                </Button>
                <Button variant="solid" size="sm" accent="lilac" onPress={noop}>
                  Lilac
                </Button>
                <Button variant="solid" size="sm" accent="orange" onPress={noop}>
                  Orange
                </Button>
              </View>
              <View direction="row" align="center" gap="sm">
                <Button variant="solid" size="sm" disabled onPress={noop}>
                  Solid disabled
                </Button>
                <Button variant="soft" size="sm" disabled onPress={noop}>
                  Soft disabled
                </Button>
              </View>
              <View direction="row" align="center" gap="sm">
                <Button variant="solid" size="lg" accent="orange" onPress={noop}>
                  <ButtonText>Buy bitcoin</ButtonText>
                  <ButtonIcon name="bitcoin" />
                </Button>
              </View>
              <View direction="row" align="center" gap="sm" distribute="even">
                <Button size="lg" variant="soft" onPress={noop}>
                  Receive
                </Button>
                <Button size="lg" variant="solid" accent="lilac" onPress={noop}>
                  Send
                </Button>
              </View>
            </Section>

            <Section title="IconButton">
              <View direction="row" align="center" gap="sm">
                <IconButton
                  icon="plus"
                  variant="solid"
                  accessibilityLabel="Solid icon button"
                  onPress={noop}
                />
                <IconButton
                  icon="qr-scan"
                  variant="soft"
                  accessibilityLabel="Soft icon button"
                  onPress={noop}
                />
                <IconButton
                  icon="settings"
                  variant="ghost"
                  accessibilityLabel="Ghost icon button"
                  onPress={noop}
                />
                <IconButton
                  icon="minus"
                  variant="soft"
                  disabled
                  accessibilityLabel="Disabled icon button"
                  onPress={noop}
                />
              </View>
            </Section>

            <Section title="IconAvatar">
              <View direction="row" align="center" gap="sm">
                <IconAvatar variant="solid" icon="wallet" accent="orange" />
                <IconAvatar variant="soft" icon="card" accent="lilac" />
                <IconAvatar variant="ghost" icon="bank" />
                <IconAvatar variant="subtle" icon="euro" accent="lilac" />
                <IconAvatar variant="outline" icon="transfer-horizontal" accent="orange" />
              </View>
            </Section>

            <Section title="Text">
              <Text size="xs">Size xs — the smallest step</Text>
              <Text size="sm">Size sm — small copy</Text>
              <Text size="md">Size md — body copy</Text>
              <Text size="lg">Size lg — section titles</Text>
              <Text size="xl">Size xl — prominent</Text>
              <Text size="3xl">3xl — € 1 240.00</Text>
              <Text size="md" emphasis>
                Emphasis — semibold body
              </Text>
              <Text size="md" muted>
                Muted — secondary tone
              </Text>
              <Text size="md" align="center">
                Center aligned
              </Text>
            </Section>

            <Section title="TextField">
              <TextField value={plainValue} onChangeText={setPlainValue} placeholder="eg. Satoshi">
                <TextFieldLabel>First name*</TextFieldLabel>
              </TextField>
              <TextField value={buttonValue} onChangeText={setButtonValue} placeholder="IBAN">
                <TextFieldLabel>IBAN*</TextFieldLabel>
                <TextFieldButton accessibilityLabel="Paste IBAN" onPress={noop}>
                  Paste
                </TextFieldButton>
              </TextField>
              <TextField value={iconValue} onChangeText={setIconValue} placeholder="Address">
                <TextFieldLabel>Address</TextFieldLabel>
                <TextFieldIconButton
                  name="qr-scan"
                  accessibilityLabel="Scan QR code"
                  onPress={noop}
                />
              </TextField>
            </Section>

            <Section title="Alert">
              <Alert variant="soft" accent="orange">
                <AlertIcon name="warning-circle" />
                Your card is frozen
                <AlertButton accessibilityLabel="Unfreeze card" onPress={noop}>
                  Unfreeze
                </AlertButton>
              </Alert>
              <Alert variant="ghost" accent="lilac">
                <AlertIcon name="check-circle" />
                Transfer completed
              </Alert>
            </Section>

            <Section title="List / ListAction">
              <List>
                <ListAction accessibilityLabel="To Wallet" onPress={noop}>
                  <ListActionLeadingAvatar name="arrow-up" variant="outline" />
                  <ListActionText>To Wallet</ListActionText>
                  <ListActionTextMuted>Sent · 10:24 am</ListActionTextMuted>
                  <ListActionTrailingText>- 12.00 €</ListActionTrailingText>
                  <ListActionTrailingTextMuted>3433 Sats</ListActionTrailingTextMuted>
                </ListAction>
                <ListSeparator />
                <ListAction accessibilityLabel="Euro to Bitcoin" onPress={noop}>
                  <ListActionLeadingAvatar name="transfer-horizontal" variant="outline" />
                  <ListActionText>Euro to Bitcoin</ListActionText>
                  <ListActionTextMuted>Converted · Yesterday</ListActionTextMuted>
                  <ListActionTrailingText>12.00 €</ListActionTrailingText>
                  <ListActionTrailingTextMuted>3433 Sats</ListActionTrailingTextMuted>
                </ListAction>
                <ListSeparator />
                <ListAction accessibilityLabel="Card" onPress={noop}>
                  <ListActionLeadingAvatar name="card" variant="solid" accent="lilac" />
                  <ListActionText>Card</ListActionText>
                  <ListActionTrailIcon name="chevron-right" />
                </ListAction>
              </List>
            </Section>

            <Section title="Topbar">
              <Topbar>
                <TopbarLeading>
                  <IconButton
                    icon="chevron-left"
                    variant="soft"
                    accessibilityLabel="Back"
                    onPress={noop}
                  />
                </TopbarLeading>
                <TopbarCenter>
                  <Text size="md" emphasis>
                    Title
                  </Text>
                </TopbarCenter>
                <TopbarTrailing>
                  <IconButton
                    icon="share"
                    variant="soft"
                    accessibilityLabel="Share"
                    onPress={noop}
                  />
                  <IconButton
                    icon="settings"
                    variant="soft"
                    accessibilityLabel="Settings"
                    onPress={noop}
                  />
                </TopbarTrailing>
              </Topbar>
            </Section>

            <Section title="TabBar">
              <TabBar>
                <TabBarItem
                  selected={selectedTab === "bitcoin"}
                  onPress={() => setSelectedTab("bitcoin")}
                  accessibilityLabel="Bitcoin wallet"
                >
                  <TabBarItemIcon name="bitcoin-wallet" />
                  <TabBarItemLabel>€ 36.50</TabBarItemLabel>
                </TabBarItem>
                <TabBarItem
                  selected={selectedTab === "bank"}
                  onPress={() => setSelectedTab("bank")}
                  accessibilityLabel="Bank account"
                >
                  <TabBarItemIcon name="bank" />
                  <TabBarItemLabel>€ 18.90</TabBarItemLabel>
                </TabBarItem>
                <TabBarItem
                  selected={selectedTab === "euro"}
                  onPress={() => setSelectedTab("euro")}
                  accessibilityLabel="Euro wallet"
                >
                  <TabBarItemIcon name="euro-wallet" />
                  <TabBarItemLabel>€ 25.70</TabBarItemLabel>
                </TabBarItem>
              </TabBar>
            </Section>

            <Section title="Separator">
              <Text size="sm" muted>
                Default (ySpace sm)
              </Text>
              <Separator />
              <Text size="sm" muted>
                ySpace lg
              </Text>
              <Separator ySpace="lg" />
              <Text size="sm" muted>
                ListSeparator
              </Text>
              <ListSeparator />
            </Section>

            <Section title="Modal">
              <View direction="row" align="center" gap="sm" distribute="even">
                <Button size="lg" variant="soft" onPress={() => setContentSheetOpen(true)}>
                  Sheet modal
                </Button>
                <Button
                  size="lg"
                  variant="solid"
                  accent="lilac"
                  onPress={() => setFullSheetOpen(true)}
                >
                  Full modal
                </Button>
              </View>
            </Section>
          </View>
        </Scroll>
      </Screen>

      <ContentSheet open={contentSheetOpen} onClose={() => setContentSheetOpen(false)} />
      <FullSheet open={fullSheetOpen} onClose={() => setFullSheetOpen(false)} />
    </>
  );
}

function Shell({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = React.useState<"light" | "dark">("light");
  const toggleTheme = React.useCallback(
    () => setMode((m) => (m === "light" ? "dark" : "light")),
    [],
  );
  // The ONE native safe-area read; NuriRoot takes plain numbers.
  const insets = useSafeAreaInsets();

  return (
    <NuriRoot mode={mode} accent="neutral" safeArea={insets}>
      <Catalog mode={mode} onToggleTheme={toggleTheme} onClose={onClose} />
    </NuriRoot>
  );
}

export default function DebugDsReviewModal({ visible, onClose }: DebugDsReviewProps) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaProvider>
        <Shell onClose={onClose} />
      </SafeAreaProvider>
    </Modal>
  );
}
