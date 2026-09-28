import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import {
  Button,
  ButtonIcon,
  ButtonText,
  Header,
  IconButton,
  Scroll,
  Text,
  TextField,
  TextFieldLabel,
  Topbar,
  TopbarTrailing,
  View,
} from "@ds";
import DsSheetHost from "../../components/DsSheetHost";
import { NOTIFICATION_TEST_DELAY_OPTIONS_SECONDS } from "../../config/constants";
import { NOTIFICATIONS_API_BASE_URL } from "../../config/network";
import {
  INTERNAL_LINK_DESTINATIONS,
  internalLinkFor,
  type InternalLinkScreen,
} from "../../lib/internalLinks";
import {
  bindSubscriptionWithArkade,
  bindSubscriptionWithWirex,
  clearPushNotificationStorage,
  enablePushNotifications,
  getSubscriptionId,
  unregisterPushDevice,
} from "../../services/notifications/NotificationRegistrationService";
import {
  listDevDevices,
  removeDevDevice,
  saveDevDevice,
  saveThisDevice,
} from "../../services/notifications/DevDeviceRegistry";
import { sendExpoPush } from "../../services/notifications/ExpoPushClient";
import type {
  DevDevice,
  PushToken,
  ScheduledNotification,
} from "../../services/notifications/notificationTypes";
import {
  cancelScheduled,
  getPermission,
  getPushToken,
  listScheduled,
  requestPermission,
  scheduleLocal,
  startNotifications,
} from "../../services/notifications/NotificationService";
import type { DebugNotificationsProps } from "../../types/debug";

type Props = DebugNotificationsProps;

const COUNTDOWN_TICK_MS = 1000;
// Long enough to background the app before it fires, short enough to iterate.
const DESTINATION_TEST_DELAY_SECONDS = 8;

function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

function formatCountdown(fireAtMs: number | null, nowMs: number): string {
  if (fireAtMs === null) return "scheduled";
  const remaining = Math.max(0, Math.round((fireAtMs - nowMs) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function truncateToken(token: string): string {
  if (token.length <= 42) return token;
  return `${token.slice(0, 24)}…${token.slice(-12)}`;
}

export default function DebugNotificationsModal({ visible, onClose }: Props) {
  const [permission, setPermission] = useState<string>("unknown");
  const [pushToken, setPushToken] = useState<PushToken | null>(null);
  const [devices, setDevices] = useState<DevDevice[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledNotification[]>([]);
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const [status, setStatus] = useState<string | null>(null);
  const [thisDeviceLabel, setThisDeviceLabel] = useState<string>("");
  const [newDeviceLabel, setNewDeviceLabel] = useState<string>("");
  const [newDeviceToken, setNewDeviceToken] = useState<string>("");
  const [subscriptionId, setSubscriptionId] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    const [nextPermission, nextDevices, nextScheduled] = await Promise.all([
      getPermission(),
      listDevDevices(),
      listScheduled(),
    ]);
    setPermission(nextPermission);
    setDevices(nextDevices);
    setScheduled(nextScheduled);
    setSubscriptionId(await getSubscriptionId());
  }, []);

  useEffect(() => {
    if (!visible) return;
    setStatus(null);
    void (async () => {
      await startNotifications();
      await refresh();
    })();
  }, [visible, refresh]);

  // Drives the pending-notification countdown. Only runs while the sheet is up.
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [visible]);

  const handleRequestPermission = useCallback(() => {
    void (async () => {
      const next = await requestPermission();
      setPermission(next);
      setStatus(`permission: ${next}`);
    })();
  }, []);

  const handleLoadToken = useCallback(() => {
    setBusy(true);
    void (async () => {
      const token = await getPushToken();
      setPushToken(token);
      setStatus(
        token
          ? `token acquired (${token.kind})`
          : "no token — needs granted permission and a build with push credentials",
      );
      setBusy(false);
    })();
  }, []);

  const handleRegisterThisDevice = useCallback(() => {
    if (!pushToken) return;
    void (async () => {
      const next = await saveThisDevice(
        thisDeviceLabel || `${Platform.OS} (this device)`,
        pushToken,
      );
      setDevices(next);
      setThisDeviceLabel("");
      setStatus("this device registered");
    })();
  }, [pushToken, thisDeviceLabel]);

  const handleAddDevice = useCallback(() => {
    const token = newDeviceToken.trim();
    if (!token) return;
    void (async () => {
      const kind = token.startsWith("ExponentPushToken") ? "expo" : "web";
      const next = await saveDevDevice({
        label: newDeviceLabel,
        token,
        kind,
        platform: kind === "expo" ? "unknown" : "web",
      });
      setDevices(next);
      setNewDeviceLabel("");
      setNewDeviceToken("");
      setStatus("device added");
    })();
  }, [newDeviceLabel, newDeviceToken]);

  const handleRemoveDevice = useCallback((token: string) => {
    void (async () => {
      setDevices(await removeDevDevice(token));
      setStatus("device removed");
    })();
  }, []);

  const handleSendTo = useCallback((device: DevDevice) => {
    setBusy(true);
    void (async () => {
      const results = await sendExpoPush([device], {
        title: "Nuri debug",
        body: `Test push to ${device.label}`,
        data: { source: "debug" },
      });
      const result = results[0];
      setStatus(result ? `${device.label}: ${result.detail}` : "no result");
      setBusy(false);
    })();
  }, []);

  const handleSchedule = useCallback((seconds: number) => {
    void (async () => {
      await scheduleLocal(
        {
          title: "Nuri debug",
          body: `Scheduled ${formatDelay(seconds)} ago from the debug tools`,
          data: { source: "debug-scheduled" },
        },
        seconds,
      );
      setScheduled(await listScheduled());
      setStatus(`scheduled in ${formatDelay(seconds)} — you can close the app`);
    })();
  }, []);

  const handleScheduleDestination = useCallback((screen: InternalLinkScreen, label: string) => {
    void (async () => {
      const url = internalLinkFor(screen);
      await scheduleLocal(
        {
          title: "Nuri debug",
          body: `Tap to open: ${label}`,
          // Same field a real push carries, so this exercises the production
          // routing path rather than a debug-only shortcut.
          data: { url, source: "debug-destination" },
        },
        DESTINATION_TEST_DELAY_SECONDS,
      );
      setScheduled(await listScheduled());
      setStatus(`${label} in ${DESTINATION_TEST_DELAY_SECONDS}s — close the app, then tap it`);
    })();
  }, []);

  const handleCancelScheduled = useCallback((id: string) => {
    void (async () => {
      await cancelScheduled(id);
      setScheduled(await listScheduled());
      setStatus("cancelled");
    })();
  }, []);

  const handleEnableNotifications = useCallback(() => {
    setBusy(true);
    void (async () => {
      const state = await enablePushNotifications();
      setStatus(
        state.kind === "registered"
          ? `enabled · subscription ${state.subscriptionId}`
          : state.kind === "error"
            ? `server: ${state.message}`
            : `not enabled (${state.reason})`,
      );
      setSubscriptionId(await getSubscriptionId());
      setBusy(false);
    })();
  }, []);

  const handleUnregister = useCallback(() => {
    setBusy(true);
    void (async () => {
      // Server first, then local — same order as a factory reset, so this
      // exercises the real path rather than a debug-only shortcut.
      const result = await unregisterPushDevice();
      await clearPushNotificationStorage();
      setPushToken(null);
      setSubscriptionId(await getSubscriptionId());
      setStatus(
        result.ok
          ? `${result.detail} · local state cleared, new subscription minted`
          : `server: ${result.detail} · local state cleared anyway`,
      );
      setBusy(false);
    })();
  }, []);

  // One subscription, one binding per rail — and they succeed independently, so
  // each gets its own trigger. Thin callers of the prod functions: whatever
  // happens here is exactly what sign-in does.
  const handleBindArkade = useCallback(() => {
    setBusy(true);
    void (async () => {
      const bound = await bindSubscriptionWithArkade({ allowPrompt: true });
      setStatus(bound ? "arkade bound (Lightning)" : "arkade bind failed — no assertion or server");
      setBusy(false);
    })();
  }, []);

  const handleBindWirex = useCallback(() => {
    setBusy(true);
    void (async () => {
      const bound = await bindSubscriptionWithWirex();
      setStatus(
        bound
          ? "wirex bound (card, SEPA, limit, 3DS)"
          : "wirex bind failed — needs a registered device and a cached Wirex read session (open the Card tab)",
      );
      setBusy(false);
    })();
  }, []);

  const handleCopyToken = useCallback(() => {
    if (!pushToken) return;
    void (async () => {
      try {
        await Clipboard.setStringAsync(pushToken.value);
        setStatus("token copied — paste it on another dev's device");
      } catch {
        setStatus("copy failed");
      }
    })();
  }, [pushToken]);

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent">
          <TopbarTrailing>
            <IconButton icon="cross" variant="soft" accessibilityLabel="Close" onPress={onClose} />
          </TopbarTrailing>
        </Topbar>
      </Header>
      <Scroll safeAreaBottom>
        <View direction="column" align="stretch" gap="lg" paddingX="lg" paddingBottom="lg">
          <Text size="lg" emphasis>
            Notifications
          </Text>

          <Section title="This device">
            <ValueRow label="Platform" value={Platform.OS} />
            <ValueRow label="Permission" value={permission} />
            <ValueRow
              label="Push token"
              value={pushToken ? truncateToken(pushToken.value) : "not loaded"}
            />
            {permission !== "granted" ? (
              <Button variant="solid" accent="lilac" size="sm" onPress={handleRequestPermission}>
                <ButtonText>Grant permission</ButtonText>
              </Button>
            ) : null}
            <Button variant="soft" size="sm" onPress={handleLoadToken} disabled={busy}>
              <ButtonText>{busy ? "Working…" : "Load push token"}</ButtonText>
            </Button>
            <Button variant="soft" size="sm" onPress={handleCopyToken} disabled={!pushToken}>
              <ButtonIcon name="copy" />
              <ButtonText>Copy token</ButtonText>
            </Button>
            <TextField
              onChangeText={setThisDeviceLabel}
              autoCapitalize="none"
              placeholder="e.g. Lennard iPhone"
            >
              <TextFieldLabel>Label</TextFieldLabel>
            </TextField>
            <Button
              variant="soft"
              size="sm"
              onPress={handleRegisterThisDevice}
              disabled={!pushToken}
            >
              <ButtonIcon name="plus" />
              <ButtonText>Register this device (local list)</ButtonText>
            </Button>
            <Button
              variant="solid"
              accent="lilac"
              size="sm"
              onPress={handleEnableNotifications}
              disabled={busy}
            >
              <ButtonIcon name="lightning" />
              <ButtonText>Turn notifications on</ButtonText>
            </Button>
            <Button variant="soft" size="sm" onPress={handleUnregister} disabled={busy}>
              <ButtonIcon name="minus" />
              <ButtonText>Turn notifications off (unregister)</ButtonText>
            </Button>
            <ValueRow label="Subscription" value={subscriptionId || "not minted"} />
            <ValueRow label="Server" value={NOTIFICATIONS_API_BASE_URL || "not configured"} />
          </Section>

          <Section title="Bindings">
            <Text size="sm" muted>
              Both rails share the subscription above, but each needs its own vouch. Turning
              notifications on does both; these run them one at a time.
            </Text>
            <Button variant="soft" size="sm" onPress={handleBindArkade} disabled={busy}>
              <ButtonIcon name="lightning" />
              <ButtonText>Bind arkade (Lightning)</ButtonText>
            </Button>
            <Button variant="soft" size="sm" onPress={handleBindWirex} disabled={busy}>
              <ButtonIcon name="card" />
              <ButtonText>Bind wirex (card, SEPA, 3DS)</ButtonText>
            </Button>
          </Section>

          <Section title="Timed test">
            <Text size="sm" muted>
              Schedules a local notification through the OS. It fires even if you close the app —
              this proves permission, channel and presentation, not the APNs/FCM transport.
            </Text>
            {Platform.OS === "web" ? (
              <Text size="sm" muted>
                On web the timer lives in the page: closing the tab cancels it.
              </Text>
            ) : null}
            <View direction="row" align="stretch" gap="sm">
              {NOTIFICATION_TEST_DELAY_OPTIONS_SECONDS.map((seconds) => (
                <Button
                  key={seconds}
                  variant="soft"
                  size="sm"
                  onPress={() => handleSchedule(seconds)}
                >
                  <ButtonText>{formatDelay(seconds)}</ButtonText>
                </Button>
              ))}
            </View>
            {scheduled.length === 0 ? (
              <Text size="sm" muted>
                Nothing pending.
              </Text>
            ) : (
              scheduled.map((entry) => (
                <View key={entry.id} direction="row" align="center" gap="sm" justify="between">
                  <Text size="sm" mono>
                    {formatCountdown(entry.fireAtMs, nowMs)} · {entry.body}
                  </Text>
                  <Button variant="soft" size="sm" onPress={() => handleCancelScheduled(entry.id)}>
                    <ButtonText>Cancel</ButtonText>
                  </Button>
                </View>
              ))
            )}
          </Section>

          <Section title="Open a screen">
            <Text size="sm" muted>
              Schedules a notification carrying a `nuri://` link. Tapping it routes through the same
              deep-link handler a real push uses, so this tests production routing — not a debug
              shortcut. Close the app after tapping, then tap the notification.
            </Text>
            {INTERNAL_LINK_DESTINATIONS.map((destination) => (
              <Button
                key={destination.screen}
                variant="soft"
                size="sm"
                onPress={() => handleScheduleDestination(destination.screen, destination.label)}
              >
                <ButtonText>{destination.label}</ButtonText>
              </Button>
            ))}
          </Section>

          <Section title="Remote push to a dev device">
            <Text size="sm" muted>
              Goes through Expo's push service to APNs/FCM — the real transport. Web subscriptions
              are listed but cannot be sent to from the app: that needs the VAPID private key.
            </Text>
            {devices.length === 0 ? (
              <Text size="sm" muted>
                No devices registered yet.
              </Text>
            ) : (
              devices.map((device) => (
                <View key={device.token} direction="column" align="stretch" gap="xs">
                  <Text size="sm" emphasis>
                    {device.label} · {device.platform} · {device.kind}
                  </Text>
                  <Text size="xs" muted mono>
                    {truncateToken(device.token)}
                  </Text>
                  <View direction="row" align="stretch" gap="sm">
                    <Button
                      variant="solid"
                      accent="lilac"
                      size="sm"
                      onPress={() => handleSendTo(device)}
                      disabled={busy || device.kind !== "expo"}
                    >
                      <ButtonIcon name="lightning" />
                      <ButtonText>Send now</ButtonText>
                    </Button>
                    <Button
                      variant="soft"
                      size="sm"
                      onPress={() => handleRemoveDevice(device.token)}
                    >
                      <ButtonIcon name="minus" />
                      <ButtonText>Remove</ButtonText>
                    </Button>
                  </View>
                </View>
              ))
            )}
          </Section>

          <Section title="Add another dev's device">
            <TextField
              onChangeText={setNewDeviceLabel}
              autoCapitalize="none"
              placeholder="e.g. Taner Pixel"
            >
              <TextFieldLabel>Label</TextFieldLabel>
            </TextField>
            <TextField
              onChangeText={setNewDeviceToken}
              autoCapitalize="none"
              placeholder="ExponentPushToken[…]"
            >
              <TextFieldLabel>Token</TextFieldLabel>
            </TextField>
            <Button variant="soft" size="sm" onPress={handleAddDevice}>
              <ButtonIcon name="plus" />
              <ButtonText>Add device</ButtonText>
            </Button>
          </Section>

          {status ? (
            <Text size="sm" muted>
              {status}
            </Text>
          ) : null}
        </View>
      </Scroll>
    </DsSheetHost>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View variant="soft" radius="lg" padding="lg" direction="column" align="stretch" gap="sm">
      <Text size="md" emphasis>
        {title}
      </Text>
      {children}
    </View>
  );
}

function ValueRow({ label, value }: { label: string; value: string }) {
  return (
    <View direction="column" align="stretch" gap="xs">
      <Text size="xs" muted>
        {label}
      </Text>
      <Text size="sm" mono>
        {value}
      </Text>
    </View>
  );
}
