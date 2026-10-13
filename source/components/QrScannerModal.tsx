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
  TopbarTrailing,
  View,
} from "@ds";

import DsSheetHost from "./DsSheetHost";
import QrUploadButton from "./QrUploadButton";
import { createScanHold } from "./qrScanHold";
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
  const [mismatchMessage, setMismatchMessage] = useState<string | null>(null);
  const permissionRequestedRef = useRef(false);
  const holdRef = useRef<ReturnType<typeof createScanHold> | null>(null);
  holdRef.current ??= createScanHold(setMismatchMessage);
  const hold = holdRef.current;

  const resolvedTitle = title ?? t("screen.QrScannerModal.title");
  const resolvedPasteLabel = pasteLabel ?? t("screen.QrScannerModal.pasteLabel");

  const [topHeight, setTopHeight] = useState(0);

  // Opening the sheet starts the camera free, with no message. Closing keeps
  // it held: the camera stays mounted through the exit animation and must not
  // read the same code again.
  useEffect(() => {
    if (visible) hold.reset();
    else hold.close();
    return () => hold.close();
  }, [visible, hold]);

  useEffect(() => {
    if (!visible) {
      permissionRequestedRef.current = false;
      return;
    }
    if (!permission) return;
    if (!permission.granted && permission.canAskAgain && !permissionRequestedRef.current) {
      permissionRequestedRef.current = true;
      void requestPermission();
    }
  }, [visible, permission, requestPermission]);

  const showTransientMessage = hold.flash;

  const handleInput = useCallback(
    async (raw: string, source: "scan" | "paste" | "upload") => {
      // A rejected scan or upload blames the QR. A rejected paste falls back to manual
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
        } else if (source === "upload") {
          showTransientMessage(rejectMessage);
        } else {
          hold.release();
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
      hold,
    ],
  );

  const handleBarcode = useCallback(
    (res: BarcodeScanningResult) => {
      if (!hold.take()) return;
      void handleInput(String(res.data ?? ""), "scan").catch(() => {
        showTransientMessage(t("common.invalidQrTryAgain"));
      });
    },
    [hold, handleInput, showTransientMessage],
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

  const onUploadDecoded = useCallback(
    (data: string | null, token: number) => {
      // Only the upload still pending counts: a late photo from an earlier
      // upload, or from before the sheet closed, is dropped.
      if (!hold.uploadDone(token)) {
        console.log("[QrScannerModal] Dropped a stale upload result");
        return;
      }
      if (!data) {
        console.log("[QrScannerModal] No QR code in uploaded image");
        showTransientMessage(t("screen.QrScannerModal.noQrInImage"));
        return;
      }
      void handleInput(data, "upload").catch(() => {
        showTransientMessage(t("common.invalidQrTryAgain"));
      });
    },
    [hold, handleInput, showTransientMessage],
  );

  const cameraGranted = Boolean(permission?.granted);

  // The sheet works without camera access: the camera area stays dark with the
  // permission status inside, and Paste and Upload keep working.
  const renderCameraArea = () => {
    if (cameraGranted) return null;
    return (
      <NuriScope mode="dark">
        <View direction="column" align="center" justify="center" gap="lg" fill="grow" paddingX="xl">
          <Text size="md" muted align="center">
            {!permission
              ? t("screen.QrScannerModal.preparingCamera")
              : permission.canAskAgain
                ? t("screen.QrScannerModal.permissionNeeded")
                : t("screen.QrScannerModal.permissionDenied")}
          </Text>
          {permission ? (
            permission.canAskAgain ? (
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
            )
          ) : null}
        </View>
      </NuriScope>
    );
  };

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <RNView style={styles.root}>
        {/* Structural: the camera sits behind the header and the open area,
            reaching only far enough under the card for its rounded corners to
            show the preview. It stops there so it cannot read a code hidden
            behind the card. A DS box models no absolute layer or measurement. */}
        <RNView style={[styles.cameraLayer, { height: topHeight + CARD_CORNER }]}>
          {cameraGranted ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              onBarcodeScanned={handleBarcode}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            />
          ) : (
            <NuriScope mode="dark">
              <View chrome="canvas" fill="grow" />
            </NuriScope>
          )}
        </RNView>

        <RNView
          style={styles.top}
          onLayout={(event) => {
            const next = Math.round(event.nativeEvent.layout.height);
            setTopHeight((current) => (current === next ? current : next));
          }}
        >
          <Header safeAreaTop chrome="transparent">
            <Topbar surface="transparent">
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

          <RNView style={styles.cameraArea}>{renderCameraArea()}</RNView>
        </RNView>

        {/* Structural: the card takes the bottom 40% of the page (the camera
            the top 60%), with the buttons pinned to its bottom. A DS box
            models no flex ratio. */}
        <RNView style={styles.bottom}>
          <View
            chrome="canvas"
            radiusTop="lg"
            direction="column"
            align="stretch"
            gap="sm"
            paddingX="lg"
            paddingTop="xl"
            fill="grow"
          >
            <Text size="lg" emphasis>
              {resolvedTitle}
            </Text>
            <Text size="md" muted>
              {t("screen.QrScannerModal.subtitle")}
            </Text>
            {/* Always mounted, one line: the card keeps its height with or
              without a message, so showing one never moves the buttons. */}
            <Text size="md" emphasis flow="truncate" lines={1}>
              {mismatchMessage ?? "\u00A0"}
            </Text>
          </View>

          <Footer
            safeAreaBottom
            chrome="canvas"
            direction="column"
            align="stretch"
            paddingBottom="lg"
            paddingX="lg"
          >
            {/* Paste and Upload are the only actions: the scanner accepts what it
              can act on, and anything typed by hand belongs on the rail's own
              send screen, which knows the currency. */}
            <View direction="row" distribute="even" gap="sm">
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
              <QrUploadButton
                label={t("screen.QrScannerModal.uploadLabel")}
                onOpen={hold.uploadOpen}
                onCancel={hold.uploadCancel}
                onDecoded={onUploadDecoded}
              />
            </View>
          </Footer>
        </RNView>
      </RNView>
    </DsSheetHost>
  );
};

// The card's radiusTop="lg" (18 px): how far the camera reaches under it.
const CARD_CORNER = 18;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
  cameraLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  top: {
    flex: 3,
    minHeight: 0,
  },
  bottom: {
    flex: 2,
    minHeight: 0,
  },
  cameraArea: {
    flex: 1,
    minHeight: 0,
  },
});

export default QrScannerModal;
