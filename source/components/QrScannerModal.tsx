// @screen app.qr-scanner
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Platform, StyleSheet, View as RNView } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Clipboard from "expo-clipboard";

import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  NuriScope,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import DsSheetHost from "./DsSheetHost";
import type { QrScannerProps } from "../types/debug";
import { extractAddressFromQR, parseQr } from "../lib/qr";
import { t } from "../lib/i18n";

type Props = QrScannerProps;

const QrScannerModal: React.FC<Props> = ({
  visible,
  onClose,
  onResult,
  onUnknown,
  acceptTypes,
  onParsedResult,
  title,
  pasteLabel,
  onManualEntry,
}) => {
  const [permission, requestPermission] = useCameraPermissions();
  // Diameter the circle is allowed to take: the smaller of the slot's width and
  // whatever height is left once the header and the paste CTA have theirs.
  const [circleSize, setCircleSize] = useState(0);
  const [scanned, setScanned] = useState(false);
  const [mismatchMessage, setMismatchMessage] = useState<string | null>(null);
  const permissionRequestedRef = useRef(false);

  const resolvedTitle = title ?? t("screen.QrScannerModal.title");
  const resolvedPasteLabel = pasteLabel ?? t("screen.QrScannerModal.pasteLabel");

  useEffect(() => {
    if (!visible) {
      permissionRequestedRef.current = false;
      return;
    }
    setScanned(false);
    setMismatchMessage(null);
    if (!permission) return;
    if (!permission.granted && permission.canAskAgain && !permissionRequestedRef.current) {
      permissionRequestedRef.current = true;
      void requestPermission();
    }
  }, [visible, permission, requestPermission]);

  const showTransientMessage = useCallback((message: string) => {
    setMismatchMessage(message);
    setTimeout(() => {
      setMismatchMessage(null);
      setScanned(false);
    }, 2500);
  }, []);

  const handleInput = useCallback(
    async (raw: string, source: "scan" | "paste") => {
      // A rejected scan blames the QR. A rejected paste falls back to manual
      // entry when the caller supports it (the recipient field has its own
      // paste button), otherwise it blames the clipboard.
      const rejectPaste = () => {
        if (onManualEntry) {
          onManualEntry();
        } else {
          showTransientMessage(t("screen.QrScannerModal.pasteInvalid"));
        }
      };
      const rejectMessage = t("common.invalidQrTryAgain");
      const value = extractAddressFromQR(raw);
      if (!value) {
        console.log("[QrScannerModal] Input not recognized: no data found");
        if (source === "paste") {
          rejectPaste();
        } else {
          setScanned(false);
        }
        return;
      }

      if (!acceptTypes) {
        onResult(value);
        onClose();
        return;
      }

      const parsed = parseQr(value);
      if (parsed.type === "unknown") {
        // Give the caller one shot at raw formats parseQr does not model
        // (chain-prefixed URIs, bare base58) before the invalid toast.
        if (onUnknown && (await onUnknown(value)) == null) {
          onClose();
          return;
        }
        console.log("[QrScannerModal] Rejected: unrecognized format", { raw: value.slice(0, 60) });
        if (source === "paste") {
          rejectPaste();
        } else {
          showTransientMessage(rejectMessage);
        }
        return;
      }

      if (!acceptTypes.includes(parsed.type)) {
        console.log("[QrScannerModal] Rejected: type not accepted", {
          type: parsed.type,
          acceptTypes,
        });
        if (source === "paste") {
          rejectPaste();
        } else {
          showTransientMessage(rejectMessage);
        }
        return;
      }

      if (onParsedResult) {
        const errorMsg = onParsedResult(parsed);
        if (errorMsg) {
          console.log("[QrScannerModal] Rejected by caller", {
            type: parsed.type,
            reason: errorMsg,
          });
          if (source === "paste") {
            rejectPaste();
          } else {
            showTransientMessage(rejectMessage);
          }
          return;
        }
        onClose();
      } else {
        onResult(value);
        onClose();
      }
    },
    [
      acceptTypes,
      onResult,
      onParsedResult,
      onUnknown,
      onClose,
      showTransientMessage,
      onManualEntry,
    ],
  );

  const handleBarcode = useCallback(
    (res: BarcodeScanningResult) => {
      if (scanned) return;
      setScanned(true);
      void handleInput(String(res.data ?? ""), "scan").catch(() => {
        showTransientMessage(t("common.invalidQrTryAgain"));
      });
    },
    [scanned, handleInput, showTransientMessage],
  );

  const onPaste = useCallback(async () => {
    // On web, iOS forces a clipboard-authorization callout ("Paste"/"Speak") on
    // every programmatic clipboard read, so a tap can't paste silently the way
    // the native app does. Go straight to the recipient field instead — the
    // user pastes/types there with the normal keyboard, no OS callout. Native
    // keeps the one-tap clipboard paste.
    if (Platform.OS === "web" && onManualEntry) {
      onManualEntry();
      return;
    }
    try {
      const text = await Clipboard.getStringAsync();
      if (!text?.trim()) {
        console.log("[QrScannerModal] Clipboard empty");
        if (onManualEntry) {
          onManualEntry();
        } else {
          showTransientMessage(t("screen.QrScannerModal.clipboardEmpty"));
        }
        return;
      }
      await handleInput(text.trim(), "paste");
    } catch {
      showTransientMessage(t("common.invalidQrTryAgain"));
    }
  }, [handleInput, showTransientMessage, onManualEntry]);

  const cameraGranted = Boolean(permission?.granted);

  // The sheet works without camera access: the circle stays a dark placeholder
  // (with the permission status inside) and the paste footer keeps working.
  const renderCircle = () => {
    if (cameraGranted) {
      return (
        // Circular camera preview per the DS send-address layout. The DS View
        // can't clip a native child to a radius, so a structural RN wrapper
        // does the clipping — same stopgap category as the QR lib.
        <RNView style={styles.cameraClip}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            onBarcodeScanned={handleBarcode}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          />
        </RNView>
      );
    }
    return (
      <NuriScope mode="dark">
        <View
          chrome="canvas"
          radius="full"
          fill="grow"
          align="center"
          justify="center"
          paddingX="xl"
        >
          <Text size="md" muted align="center">
            {!permission
              ? t("screen.QrScannerModal.preparingCamera")
              : permission.canAskAgain
                ? t("screen.QrScannerModal.permissionNeeded")
                : t("screen.QrScannerModal.permissionDenied")}
          </Text>
        </View>
      </NuriScope>
    );
  };

  const renderPermissionAction = () => {
    if (cameraGranted || !permission) return null;
    return permission.canAskAgain ? (
      <Button
        size="lg"
        variant="soft"
        onPress={() => {
          void requestPermission();
        }}
      >
        <ButtonText>{t("screen.QrScannerModal.allowCamera")}</ButtonText>
      </Button>
    ) : (
      <Button size="lg" variant="soft" onPress={() => Linking.openSettings()}>
        <ButtonText>{t("screen.QrScannerModal.openSettings")}</ButtonText>
      </Button>
    );
  };

  const renderBody = () => (
    <View direction="column" align="stretch" justify="center" gap="lg" fill="grow">
      {/* Structural: the circle is width-driven (aspectRatio 1), so on a short
          screen it would push the paste CTA off the bottom — the sheet does not
          scroll. Measure what is left and cap the diameter with it. A DS box
          models no measurement. */}
      <RNView
        style={styles.circleSlot}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          const next = Math.floor(Math.min(width, height));
          setCircleSize((current) => (current === next ? current : next));
        }}
      >
        {circleSize > 0 ? (
          <RNView style={{ width: circleSize, height: circleSize }}>{renderCircle()}</RNView>
        ) : null}
      </RNView>
      {renderPermissionAction()}
      {/* Always mounted, one line: the row keeps its height with or without a
          message, so showing one never shrinks the circle (it made the camera
          jump on every rejected scan). */}
      <Text size="md" emphasis align="center" flow="truncate" lines={1}>
        {mismatchMessage ?? "\u00A0"}
      </Text>
    </View>
  );

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          {/* The title belongs in the topbar row, next to the ✕ — not one row
              below it. TopbarTitle is the DS slot for it (lg/emphasis/one-line). */}
          <TopbarTitle>{resolvedTitle}</TopbarTitle>
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

      {/* The sheet never scrolls — the circle shrinks into what the header and
          the footer leave over. */}
      <RNView style={styles.body}>
        <View
          direction="column"
          align="stretch"
          justify="start"
          gap="sm"
          paddingX="lg"
          paddingBottom="sm"
          fill="grow"
        >
          {renderBody()}
        </View>
      </RNView>

      <Footer safeAreaBottom direction="column" align="stretch" paddingBottom="lg" paddingX="lg">
        {/* Paste is the only thing under the circle: the scanner accepts what it
            can act on, and anything typed by hand belongs on the rail's own send
            screen, which knows the currency. */}
        <View direction="row" distribute="even">
          <Button
            size="lg"
            variant="soft"
            onPress={() => {
              void onPaste();
            }}
            accessibilityLabel={resolvedPasteLabel}
          >
            <ButtonText>{resolvedPasteLabel}</ButtonText>
          </Button>
        </View>
      </Footer>
    </DsSheetHost>
  );
};

const styles = StyleSheet.create({
  body: {
    flex: 1,
    minHeight: 0,
  },
  circleSlot: {
    // flex (not flexShrink): the slot has no children until it has been
    // measured, so it must claim the leftover space on its own — otherwise it
    // measures 0, the circle never renders, and the sheet stays empty.
    flex: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraClip: {
    flex: 1,
    borderRadius: 9999,
    overflow: "hidden",
  },
});

export default QrScannerModal;
