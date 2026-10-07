// @screen app.settings
// Settings — opened from the home's bottom-right button (the slot support held).
// Every row is a thin caller of a capability that already exists; nothing here
// is a second implementation:
//
//   Profile       username, the public pay link, the account email — each row
//                 only when the account actually has it.
//   Verification  the Wirex status; when not verified, a tap starts (or
//                 resumes) the SAME onboarding the home's VISA/IBAN rows run.
//   Notifications on/off for the push registration the debug tools used to own.
//   Language      overrides the device language; the flag dropdown lists every
//                 shipped language.
//   Currency      the display (home) currency, EUR or USD, for every converted
//                 figure in the app.
//   Export        one CSV of every transaction across every account.
//   Address book  saved recipients (screens/addressBook), plus copying the
//                 address-book-only key for the desktop CLI/MCP.
//   eSIM          buy a travel data eSIM with Bitcoin over Lightning
//                 (screens/esim), and the eSIMs already bought.
//   Support       the support chat, with its unread count.
//   The version of the running bundle closes the page as plain text.
//
// Rendered as its own Layer so the home stays mounted behind it, like the
// asset screen. Pickers are ChoiceSheets stacked above it.
import type * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Header,
  IconButton,
  List,
  ListAction,
  ListActionText,
  ListActionTrailIcon,
  ListActionTrailingText,
  NuriSafeAreaProvider,
  Screen,
  Scroll,
  SelectField,
  SelectFieldAvatar,
  SelectFieldChevron,
  SelectFieldLabel,
  SelectFieldValue,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import ChoiceSheet from "../../components/ChoiceSheet";
import PayLinkCreateSheet from "../../components/PayLinkCreateSheet";
import { Layer } from "../../components/LayerHost";
import { PAY_LINK_ORIGIN } from "../../config/endpoints";
import { copyToClipboard } from "../../lib/copyToClipboard";
import {
  DISPLAY_CURRENCIES,
  type DisplayCurrency,
  homeCurrencyService,
} from "../../lib/currency/HomeCurrencyService";
import { useHomeCurrency } from "../../lib/currency/useHomeCurrency";
import { type AppLocale, SUPPORTED_LOCALES, t } from "../../lib/i18n";
import { LANGUAGE_OPTIONS } from "../../lib/i18n/languages";
import { useAppLocale } from "../../lib/i18n/useAppLocale";
import { getAppVersion } from "../../lib/loadedAppVersion";
import { useSupportUnreadCount } from "../../lib/nostr/useSupportUnreadCount";
import { payLinkUrl } from "../../lib/pay/payLinkPath";
import { setLanguagePreference } from "../../services/app/LanguagePreferenceService";
import { EventBus } from "../../services/events/AppEventBusService";
import { exportAllTransactionsCsv } from "../../services/export/AllTransactionsExport";
import type { ExportAccount } from "../../services/export/allTransactionsRows";
import {
  getActiveNotificationCategories,
  getNotificationPreferences,
  setNotificationCategory,
} from "../../services/notifications/NotificationRegistrationService";
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationPreferences,
} from "../../services/notifications/notificationPreferences";
import { getPermission } from "../../services/notifications/NotificationService";
import type { VerificationRowState } from "./settingsModel";

const K = "screen.Settings";

const CURRENCY_FLAGS: Record<DisplayCurrency, number> = {
  EUR: require("../../assets/flags/eur.png"),
  USD: require("../../assets/flags/usa.png"),
};

type Props = {
  visible: boolean;
  onClose: () => void;
  username: string | null;
  email: string | null;
  verification: { state: VerificationRowState; action: "start" | "resume" | null };
  onVerify: () => void;
  onOpenAddressBook: () => void;
  onOpenEsim: () => void;
  /** Logs out right away. */
  onLogout: () => void;
};

// What the notification rows show: the stored choice per category, which of
// them actually reach this device, whether the OS lets the app notify at all,
// and which category is being switched.
type NotificationsView = {
  preferences: NotificationPreferences;
  active: NotificationPreferences;
  blocked: boolean;
  busy: NotificationCategory | null;
} | null;

async function readNotificationsView(): Promise<NonNullable<NotificationsView>> {
  const [preferences, active, permission] = await Promise.all([
    getNotificationPreferences(),
    getActiveNotificationCategories(),
    getPermission(),
  ]);
  return { preferences, active, blocked: permission === "denied", busy: null };
}

// The row's On/Off. Blocked by the OS: the stored choice (nothing can reach the
// device either way, and the row above says why). Otherwise: whether it really
// reaches this device.
function categoryOn(view: NonNullable<NotificationsView>, category: NotificationCategory): boolean {
  return view.blocked ? view.preferences[category] : view.active[category];
}

// What a tap asks for. Always derived from the stored choice, so a category
// the user switched off can never be left opted in. The one exception: chosen
// but not reaching the device (Face ID cancelled, server unreachable) — a tap
// on that "Off" row retries turning it on.
function categoryTarget(
  view: NonNullable<NotificationsView>,
  category: NotificationCategory,
): boolean {
  if (!view.preferences[category]) return true;
  return !view.blocked && !view.active[category];
}
type ExportState =
  | { kind: "idle" | "busy" | "empty" | "failed" }
  | { kind: "incomplete"; missing: ExportAccount[] };

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <View direction="column" align="stretch" gap="sm">
    <View paddingX="lg">
      <Text size="sm" emphasis muted>
        {title}
      </Text>
    </View>
    <List>{children}</List>
  </View>
);

const SettingsScreen: React.FC<Props> = ({
  visible,
  onClose,
  username,
  email,
  verification,
  onVerify,
  onOpenAddressBook,
  onOpenEsim,
  onLogout,
}) => {
  const insets = useSafeAreaInsets();
  const locale = useAppLocale();
  const currency = useHomeCurrency();
  const supportUnread = useSupportUnreadCount();
  const [picker, setPicker] = useState<"language" | "currency" | null>(null);
  const [creatingPayLink, setCreatingPayLink] = useState(false);
  const [notifications, setNotifications] = useState<NotificationsView>(null);
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });

  // Read fresh on every open: the OS permission can change while away.
  useEffect(() => {
    if (!visible) {
      setPicker(null);
      setCreatingPayLink(false);
      setExportState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setNotifications(null);
    void readNotificationsView().then((view) => {
      if (!cancelled) setNotifications(view);
    });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const toggleCategory = useCallback(
    (category: NotificationCategory) => {
      if (!notifications || notifications.busy) return;
      const enabled = categoryTarget(notifications, category);
      setNotifications({ ...notifications, busy: category });
      void (async () => {
        await setNotificationCategory(category, enabled);
        setNotifications(await readNotificationsView());
      })();
    },
    [notifications],
  );

  const runExport = useCallback(() => {
    if (exportState.kind === "busy") return;
    setExportState({ kind: "busy" });
    void exportAllTransactionsCsv().then((result) => {
      if (result.ok === true) setExportState({ kind: "idle" });
      else if (result.reason === "incomplete") {
        setExportState({ kind: "incomplete", missing: result.missing });
      } else setExportState({ kind: result.reason });
    });
  }, [exportState]);

  const openSupport = useCallback(() => {
    try {
      EventBus.emit("support:openNostrChat");
    } catch {}
  }, []);

  const origin =
    Platform.OS === "web" && typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : PAY_LINK_ORIGIN;
  const payLink = payLinkUrl(origin, username);
  const hasProfile = Boolean(username || email);

  const exportLabel =
    exportState.kind === "busy"
      ? t(`${K}.exportBusy`)
      : exportState.kind === "empty"
        ? t(`${K}.exportEmpty`)
        : exportState.kind === "failed"
          ? t(`${K}.exportFailed`)
          : exportState.kind === "incomplete"
            ? t(`${K}.exportIncomplete`, {
                accounts: exportState.missing.map((a) => t(`${K}.exportAccount_${a}`)).join(", "),
              })
            : null;

  return (
    <>
      <Layer visible={visible} onRequestClose={onClose}>
        {/* A Layer renders outside DsOverlayRoot's NuriSafeAreaProvider, so DS
            `safeArea*` would see inset 0 without this. */}
        <NuriSafeAreaProvider top={insets.top} bottom={insets.bottom}>
          <Screen>
            <View chrome="canvas" direction="column" align="stretch" fill="grow-shrink">
              <Header safeAreaTop chrome="canvas">
                <Topbar layout="fluid" surface="transparent">
                  <TopbarTitle>{t(`${K}.title`)}</TopbarTitle>
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

              <Scroll safeAreaBottom>
                <View direction="column" align="stretch" gap="xl" paddingY="md">
                  {hasProfile ? (
                    <Section title={t(`${K}.profile`)}>
                      {username ? (
                        <ListAction accessibilityLabel={`@${username}`}>
                          <ListActionText>{`@${username}`}</ListActionText>
                        </ListAction>
                      ) : null}
                      {payLink ? (
                        <ListAction
                          accessibilityLabel={t(`${K}.payLinkA11yLabel`)}
                          onPress={() => void copyToClipboard(payLink)}
                        >
                          <ListActionText>{payLink.replace(/^https?:\/\//, "")}</ListActionText>
                          <ListActionTrailIcon name="copy" />
                        </ListAction>
                      ) : null}
                      {payLink && username ? (
                        <ListAction
                          accessibilityLabel={t(`${K}.createPayLink`)}
                          onPress={() => setCreatingPayLink(true)}
                        >
                          <ListActionText>{t(`${K}.createPayLink`)}</ListActionText>
                          <ListActionTrailIcon name="chevron-right" />
                        </ListAction>
                      ) : null}
                      {email ? (
                        <ListAction accessibilityLabel={email}>
                          <ListActionText>{email}</ListActionText>
                        </ListAction>
                      ) : null}
                    </Section>
                  ) : null}

                  <Section title={t(`${K}.verification`)}>
                    <ListAction
                      accessibilityLabel={`${t(`${K}.verificationRow`)}, ${t(`${K}.verification_${verification.state}`)}`}
                      onPress={verification.action ? onVerify : undefined}
                    >
                      <ListActionText>{t(`${K}.verificationRow`)}</ListActionText>
                      <ListActionTrailingText>
                        {t(`${K}.verification_${verification.state}`)}
                      </ListActionTrailingText>
                      {verification.state === "verified" ? (
                        <ListActionTrailIcon name="check-circle" />
                      ) : verification.action ? (
                        <ListActionTrailIcon name="chevron-right" />
                      ) : null}
                    </ListAction>
                  </Section>

                  <Section title={t(`${K}.notifications`)}>
                    {notifications?.blocked ? (
                      // The OS refuses the prompt once it was declined; only its
                      // settings can allow notifications again.
                      <ListAction
                        accessibilityLabel={t(`${K}.notificationsBlocked`)}
                        onPress={
                          Platform.OS === "web" ? undefined : () => void Linking.openSettings()
                        }
                      >
                        <ListActionText>{t(`${K}.notificationsBlocked`)}</ListActionText>
                        {Platform.OS === "web" ? null : (
                          <ListActionTrailIcon name="chevron-right" />
                        )}
                      </ListAction>
                    ) : null}
                    {NOTIFICATION_CATEGORIES.map((category) => {
                      const on = notifications ? categoryOn(notifications, category) : false;
                      const status =
                        !notifications || notifications.busy === category
                          ? t("common.loading")
                          : t(on ? `${K}.notificationsOn` : `${K}.notificationsOff`);
                      return (
                        <ListAction
                          key={category}
                          accessibilityLabel={`${t(`${K}.notify_${category}`)}, ${status}`}
                          onPress={() => toggleCategory(category)}
                        >
                          <ListActionText>{t(`${K}.notify_${category}`)}</ListActionText>
                          <ListActionTrailingText>{status}</ListActionTrailingText>
                        </ListAction>
                      );
                    })}
                  </Section>

                  <View direction="column" align="stretch" gap="lg" paddingX="lg">
                    <SelectField
                      onPress={() => setPicker("language")}
                      accessibilityLabel={t(`${K}.language`)}
                      accessibilityValue={LANGUAGE_OPTIONS[locale].label}
                    >
                      <SelectFieldLabel>{t(`${K}.language`)}</SelectFieldLabel>
                      <SelectFieldAvatar source={LANGUAGE_OPTIONS[locale].flag} />
                      <SelectFieldValue>{LANGUAGE_OPTIONS[locale].label}</SelectFieldValue>
                      <SelectFieldChevron name="caret-down" />
                    </SelectField>
                    <SelectField
                      onPress={() => setPicker("currency")}
                      accessibilityLabel={t(`${K}.currency`)}
                      accessibilityValue={t(`${K}.currency_${currency}`)}
                    >
                      <SelectFieldLabel>{t(`${K}.currency`)}</SelectFieldLabel>
                      <SelectFieldAvatar source={CURRENCY_FLAGS[currency]} />
                      <SelectFieldValue>{t(`${K}.currency_${currency}`)}</SelectFieldValue>
                      <SelectFieldChevron name="caret-down" />
                    </SelectField>
                  </View>

                  <Section title={t(`${K}.data`)}>
                    <ListAction
                      accessibilityLabel={t(`${K}.addressBook`)}
                      onPress={onOpenAddressBook}
                    >
                      <ListActionText>{t(`${K}.addressBook`)}</ListActionText>
                      <ListActionTrailIcon name="chevron-right" />
                    </ListAction>
                    <ListAction accessibilityLabel={t(`${K}.export`)} onPress={runExport}>
                      <ListActionText>{t(`${K}.export`)}</ListActionText>
                      {exportLabel ? (
                        <ListActionTrailingText>{exportLabel}</ListActionTrailingText>
                      ) : null}
                    </ListAction>
                  </Section>

                  <Section title={t(`${K}.shop`)}>
                    <ListAction accessibilityLabel={t(`${K}.esim`)} onPress={onOpenEsim}>
                      <ListActionText>{t(`${K}.esim`)}</ListActionText>
                      <ListActionTrailIcon name="chevron-right" />
                    </ListAction>
                  </Section>

                  <Section title={t(`${K}.help`)}>
                    <ListAction accessibilityLabel={t(`${K}.support`)} onPress={openSupport}>
                      <ListActionText>{t(`${K}.support`)}</ListActionText>
                      {supportUnread > 0 ? (
                        <ListActionTrailingText>
                          {t(`${K}.supportUnread`, { count: supportUnread })}
                        </ListActionTrailingText>
                      ) : null}
                      <ListActionTrailIcon name="chevron-right" />
                    </ListAction>
                  </Section>

                  <List>
                    <ListAction accessibilityLabel={t(`${K}.logout`)} onPress={onLogout}>
                      <ListActionText>{t(`${K}.logout`)}</ListActionText>
                    </ListAction>
                  </List>

                  <View paddingX="lg">
                    <Text size="sm" emphasis muted align="center">
                      {t(`${K}.version`, { version: getAppVersion() })}
                    </Text>
                  </View>
                </View>
              </Scroll>
            </View>
          </Screen>
        </NuriSafeAreaProvider>
      </Layer>

      {username ? (
        <PayLinkCreateSheet
          visible={visible && creatingPayLink}
          onClose={() => setCreatingPayLink(false)}
          origin={origin}
          username={username}
        />
      ) : null}
      <ChoiceSheet<AppLocale>
        visible={visible && picker === "language"}
        onClose={() => setPicker(null)}
        title={t(`${K}.language`)}
        items={SUPPORTED_LOCALES.map((code) => ({
          key: code,
          label: LANGUAGE_OPTIONS[code].label,
          image: LANGUAGE_OPTIONS[code].flag,
          ...(code === locale ? { sublabel: t(`${K}.selected`) } : {}),
        }))}
        onSelect={(code) => {
          setPicker(null);
          void setLanguagePreference(code);
        }}
      />

      <ChoiceSheet<DisplayCurrency>
        visible={visible && picker === "currency"}
        onClose={() => setPicker(null)}
        title={t(`${K}.currency`)}
        subtitle={t(`${K}.currencySubtitle`)}
        items={DISPLAY_CURRENCIES.map((code) => ({
          key: code,
          label: t(`${K}.currency_${code}`),
          image: CURRENCY_FLAGS[code],
          ...(code === currency ? { sublabel: t(`${K}.selected`) } : {}),
        }))}
        onSelect={(code) => {
          setPicker(null);
          void homeCurrencyService.setHomeCurrency(code);
        }}
      />
    </>
  );
};

export default SettingsScreen;
