// @screen app.update-required
//
// The version gate reports the JS BUNDLE version (App.tsx), which moves with
// OTA — so "must update" is usually satisfiable by a bundle that is already
// downloaded and waiting for a restart. Sending the user to the App Store there
// is a dead end: nothing newer to install, back to this same blocking screen.
// Support has the tickets. So this asks expo-updates first and restarts into
// the update if there is one; the store link is the fallback for the case that
// genuinely needs a new binary (a changed runtime version). Blocking here while
// it checks is fine — the user is already blocked.
import { useCallback, useEffect, useState } from "react";
import { Linking, Platform } from "react-native";
import { Button, ButtonText, Text, View } from "@ds";
import Spinner from "./Spinner";
import { Layer } from "./LayerHost";
import { t } from "../lib/i18n";
import { applyPendingUpdate, fetchPendingUpdate } from "../services/app/OtaUpdateService";

type Props = {
  visible: boolean;
  storeUrl: string;
  headline?: string;
  description?: string;
};

export default function PleaseUpdateAppModal({
  visible,
  storeUrl,
  headline = t("modal.PleaseUpdateAppModal.headline"),
  description = t("modal.PleaseUpdateAppModal.description"),
}: Props) {
  const [checking, setChecking] = useState(false);
  const [otaReady, setOtaReady] = useState(false);

  // Look for a bundle as soon as the screen appears, so the button is already
  // the right one by the time the user reaches for it.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setChecking(true);
    void fetchPendingUpdate()
      .then((ready) => {
        if (!cancelled) setOtaReady(ready);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const openStore = useCallback(async () => {
    let url = String(storeUrl || "").trim();
    if (!url) return;
    if (Platform.OS === "ios" && url.startsWith("https://apps.apple.com/")) {
      url = url.replace(/^https:\/\//, "itms-apps://");
    }
    try {
      await Linking.openURL(url);
    } catch {}
  }, [storeUrl]);

  const handleUpdatePress = useCallback(async () => {
    // Re-check rather than trusting the mount-time result: the download may
    // have finished while the user was reading.
    if (otaReady || (await fetchPendingUpdate())) {
      await applyPendingUpdate();
      return;
    }
    await openStore();
  }, [otaReady, openStore]);

  return (
    <Layer visible={visible}>
      <View
        chrome="canvas"
        direction="column"
        align="stretch"
        justify="center"
        padding="lg"
        fill="grow"
      >
        <View variant="soft" radius="lg" padding="xl" direction="column" align="stretch" gap="sm">
          <Text size="md" emphasis align="center">
            {headline}
          </Text>
          <Text size="md" muted align="center">
            {description}
          </Text>
          <View direction="column" align="stretch" paddingTop="md">
            <Button
              size="lg"
              variant="solid"
              accent="lilac"
              disabled={checking}
              onPress={() => void handleUpdatePress()}
            >
              {checking ? (
                <Spinner />
              ) : (
                <ButtonText>{t("modal.PleaseUpdateAppModal.updateNow")}</ButtonText>
              )}
            </Button>
          </View>
        </View>
      </View>
    </Layer>
  );
}
