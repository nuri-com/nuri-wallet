// @component receive
// One receive sheet for every rail (DS surface): a read-only address field with
// a transfer-vertical accessory to flip between two addresses, the QR below,
// Request + Share. Bitcoin flips lightning <-> on-chain; Wallet flips the ENS
// name <-> EVM address. Emin's UX, DS components.
import React, { useEffect, useState } from "react";
import { Share } from "react-native";
import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  Pressable,
  Scroll,
  Text,
  Topbar,
  TopbarLeading,
  TopbarTrailing,
  View,
} from "@ds";
import AddressQrTile from "./AddressQrTile";
import DsSheetHost from "./DsSheetHost";
import { copyToClipboard } from "../lib/copyToClipboard";
import { t } from "../lib/i18n";

/** One selectable address. `value` may be absent while it is still loading. */
export type ReceiveAddress = {
  label: string;
  value?: string | null;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  title: string;
  /** Pre-selected. Falls back to `secondary` while its value is missing. */
  primary: ReceiveAddress;
  /** Omit on rails that expose a single address — the flip accessory hides. */
  secondary?: ReceiveAddress;
  isGenerating?: boolean;
  emptyText: string;
  /**
   * Shown instead of `emptyText` when the address could not be derived, next to
   * the retry action. Omit while nothing has failed.
   */
  errorText?: string;
  /** Retries deriving the address. Rendered only alongside `errorText`. */
  onRetry?: () => void;
  /** Opens the request-amount sheet. Omit to render Request disabled. */
  onRequest?: () => void;
};

const ReceiveModal: React.FC<Props> = ({
  visible,
  onClose,
  title,
  primary,
  secondary,
  isGenerating = false,
  emptyText,
  errorText,
  onRetry,
  onRequest,
}) => {
  const [showSecondary, setShowSecondary] = useState(false);

  useEffect(() => {
    if (!visible) setShowSecondary(false);
  }, [visible]);

  // Fall back to the other address when the selected one does not exist yet
  // (no username registered). Single-address rails pass no `secondary`, so the
  // fallback and the flip accessory both collapse to the primary.
  const effectiveSecondary = Boolean(secondary) && (showSecondary || !primary.value);
  const selected = effectiveSecondary && secondary ? secondary : primary;
  const qrValue = selected.value ?? "";
  const canSwitch = Boolean(primary.value && secondary?.value);
  // A failed derivation is not the same as "no address yet": it says so, and it
  // offers the retry, because nothing else in the app re-runs the derivation.
  const showRetry = !qrValue && !isGenerating && Boolean(errorText) && Boolean(onRetry);
  const placeholderText = !qrValue && errorText ? errorText : emptyText;

  const handleCopy = async () => {
    if (!qrValue) return;
    await copyToClipboard(qrValue);
  };

  const handleShare = async () => {
    if (!qrValue) return;
    try {
      await Share.share({ message: qrValue });
    } catch {}
  };

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          <TopbarLeading>
            <Text size="lg" emphasis>
              {title}
            </Text>
          </TopbarLeading>
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
        <View
          direction="column"
          align="stretch"
          justify="start"
          gap="md"
          paddingX="lg"
          paddingTop="xl"
          paddingBottom="sm"
          fill="grow"
        >
          <View direction="row" align="center" gap="sm">
            <Pressable
              fill="grow-shrink"
              disabled={!qrValue}
              onPress={() => void handleCopy()}
              accessibilityLabel={t("common.copy")}
            >
              <View
                variant="soft"
                radius="md"
                paddingX="lg"
                paddingY="md"
                direction="column"
                align="stretch"
                gap="xs"
                fill="grow-shrink"
              >
                <Text size="sm" muted>
                  {selected.label}
                </Text>
                <Text size="sm" mono flow="truncate" lines={1}>
                  {qrValue || placeholderText}
                </Text>
              </View>
            </Pressable>
            {canSwitch ? (
              <IconButton
                icon="transfer-vertical"
                variant="soft"
                accessibilityLabel={t("component.ReceiveModal.switchAddressType")}
                onPress={() => setShowSecondary(!effectiveSecondary)}
              />
            ) : null}
          </View>

          <View direction="column" align="stretch" justify="center" fill="grow">
            {qrValue ? (
              <Pressable onPress={() => void handleCopy()} accessibilityLabel={t("common.copy")}>
                <AddressQrTile value={qrValue} />
              </Pressable>
            ) : (
              <View direction="column" align="center" justify="center" gap="md">
                <Text size="md" muted align="center">
                  {placeholderText}
                </Text>
                {showRetry ? (
                  <Button size="sm" variant="soft" onPress={onRetry ?? (() => undefined)}>
                    <ButtonText>{t("common.tryAgain")}</ButtonText>
                  </Button>
                ) : null}
              </View>
            )}
          </View>
        </View>
      </Scroll>

      <Footer safeAreaBottom direction="column" align="stretch" paddingBottom="lg" paddingX="lg">
        <View direction="row" gap="sm" distribute="even">
          <Button
            size="lg"
            variant="soft"
            disabled={!onRequest}
            onPress={onRequest ?? (() => undefined)}
          >
            <ButtonText>{t("component.ReceiveModal.request")}</ButtonText>
          </Button>
          <Button
            size="lg"
            variant="solid"
            accent="lilac"
            disabled={!qrValue || isGenerating}
            onPress={() => void handleShare()}
          >
            <ButtonText>{t("common.share")}</ButtonText>
          </Button>
        </View>
      </Footer>
    </DsSheetHost>
  );
};

export default ReceiveModal;
