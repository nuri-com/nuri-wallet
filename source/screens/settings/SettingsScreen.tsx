// @screen app.settings
// Settings: the DS profile page (rn/v0.1.0-alpha.15, playground pages/profile.html),
// built 1:1 from it. Opened from the home's bottom-right button; every row is a
// thin caller of a capability that already exists. While the account is not
// verified and a tap can move verification forward, the Bank and Cards card takes
// the place of the first hairline (the design's second board); once verified the
// handle carries the check badge (its first board).
//
// Rendered as its own Layer so the home stays mounted behind it, like the
// asset screen. Pickers are ChoiceSheets stacked above it.
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import {
  Button,
  ButtonText,
  Dock,
  Header,
  IconButton,
  Image,
  List,
  ListAction,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailIcon,
  ListSwitch,
  ListSwitchText,
  NuriIcon,
  Screen,
  Scroll,
  Separator,
  Text,
  Topbar,
  TopbarTrailing,
  View,
} from "@ds";
import ChoiceSheet from "../../components/ChoiceSheet";
import PayLinkCreateSheet from "../../components/PayLinkCreateSheet";
import { Layer } from "../../components/LayerHost";
import { PAY_LINK_ORIGIN } from "../../config/endpoints";
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
import { payLinkUrl } from "../../lib/pay/payLinkPath";
import {
  PAY_WALLET_AVAILABLE,
  PayWalletProvider,
  usePayWalletConnection,
} from "../../lib/pay/payWallet";
import { setLanguagePreference } from "../../services/app/LanguagePreferenceService";
import { EventBus } from "../../services/events/AppEventBusService";
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

const BANK_AND_CARDS = require("../../assets/photos/bank-and-cards.png");

const CURRENCY_FLAGS: Record<DisplayCurrency, number> = {
  EUR: require("../../assets/flags/eur.png"),
  USD: require("../../assets/flags/usa.png"),
};

type Props = {
  visible: boolean;
  onClose: () => void;
  username: string | null;
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

const Heading: React.FC<{ title: string; hairline?: boolean }> = ({ title, hairline = true }) => (
  <>
    {hairline ? (
      <View paddingX="lg">
        <Separator ySpace="none" />
      </View>
    ) : null}
    <View paddingX="lg" paddingTop="xl">
      <Text size="lg" emphasis>
        {title}
      </Text>
    </View>
  </>
);

/**
 * The wallet Add money → From another wallet pays from: connect one ahead of
 * time, or see and end the current connection. Mounted only while Settings is
 * open, inside its own PayWalletProvider, so the wallet clients are not built
 * for a session that never looks at them.
 */
const CryptoWalletRow: React.FC = () => {
  const wallet = usePayWalletConnection();
  const [confirming, setConfirming] = useState(false);
  if (!wallet.available) return null;
  const name = wallet.walletName ?? t(`${K}.walletFallback`);
  const short = wallet.account ? `${wallet.account.slice(0, 6)}…${wallet.account.slice(-4)}` : "";
  const value = wallet.account ? `${name}, ${short}` : t(`${K}.connectWalletHint`);
  return (
    <>
      <ListAction
        accessibilityLabel={`${t(`${K}.cryptoWallet`)}, ${value}`}
        onPress={wallet.account ? () => setConfirming(true) : wallet.openConnect}
      >
        <ListActionText>{t(`${K}.cryptoWallet`)}</ListActionText>
        <ListActionTextMuted>{value}</ListActionTextMuted>
        <ListActionTrailIcon name="chevron-right" />
      </ListAction>
      <ChoiceSheet<"disconnect">
        visible={confirming && wallet.account !== null}
        onClose={() => setConfirming(false)}
        title={name}
        subtitle={short}
        items={[{ key: "disconnect", label: t(`${K}.walletDisconnect`) }]}
        onSelect={() => {
          setConfirming(false);
          void wallet.disconnect();
        }}
      />
    </>
  );
};

const SettingsScreen: React.FC<Props> = ({
  visible,
  onClose,
  username,
  verification,
  onVerify,
  onOpenAddressBook,
  onOpenEsim,
  onLogout,
}) => {
  const locale = useAppLocale();
  const currency = useHomeCurrency();
  const [picker, setPicker] = useState<"language" | "currency" | null>(null);
  const [creatingPayLink, setCreatingPayLink] = useState(false);
  const [notifications, setNotifications] = useState<NotificationsView>(null);

  // Read fresh on every open: the OS permission can change while away.
  useEffect(() => {
    if (!visible) {
      setPicker(null);
      setCreatingPayLink(false);
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

  const chooseCategory = useCallback(
    (category: NotificationCategory, enabled: boolean) => {
      if (!notifications || notifications.busy) return;
      // Nothing to do only when both the stored choice and what the row shows
      // already match. Switching on a row that is chosen but not reaching the
      // device retries turning it on; switching it off still stores the opt-out.
      if (
        enabled === categoryOn(notifications, category) &&
        enabled === notifications.preferences[category]
      ) {
        return;
      }
      setNotifications({ ...notifications, busy: category });
      void (async () => {
        await setNotificationCategory(category, enabled);
        setNotifications(await readNotificationsView());
      })();
    },
    [notifications],
  );

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
  const verified = verification.state === "verified";
  const showBankCards = verification.action !== null;

  return (
    <>
      <Layer visible={visible} onRequestClose={onClose}>
        {/* The Layer's host is transparent and the home stays mounted behind
              it: this canvas keeps the home from showing through. */}
        <View chrome="canvas" direction="column" align="stretch" fill="grow-shrink">
          <Screen>
            {/* The bar pins above the scroll and the content passes behind it;
                the Scroll's dock inset starts the handle at the bar's edge. */}
            <Dock edge="top">
              <Header safeAreaTop chrome="transparent" safeAreaChrome="canvas">
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
            </Dock>

            <Scroll safeAreaBottom insetTop="dock">
              <View
                direction="column"
                align="stretch"
                justify="start"
                gap="md"
                paddingBottom="xl"
                fill="grow"
              >
                {username ? (
                  <View direction="row" align="center" gap="sm" paddingX="lg" paddingTop="md">
                    <Text size="lg" emphasis>{`@${username}`}</Text>
                    {verified ? <NuriIcon name="check-circle" /> : null}
                  </View>
                ) : null}

                <List>
                  {payLink && username ? (
                    <ListAction
                      accessibilityLabel={t(`${K}.payLink`)}
                      onPress={() => setCreatingPayLink(true)}
                    >
                      <ListActionText>{t(`${K}.payLink`)}</ListActionText>
                      <ListActionTrailIcon name="chevron-right" />
                    </ListAction>
                  ) : null}
                  <ListAction
                    accessibilityLabel={t(`${K}.addressBook`)}
                    onPress={onOpenAddressBook}
                  >
                    <ListActionText>{t(`${K}.addressBook`)}</ListActionText>
                    <ListActionTrailIcon name="chevron-right" />
                  </ListAction>
                  <ListAction accessibilityLabel={t(`${K}.support`)} onPress={openSupport}>
                    <ListActionText>{t(`${K}.support`)}</ListActionText>
                    <ListActionTrailIcon name="chevron-right" />
                  </ListAction>
                </List>

                {showBankCards ? (
                  // The activation card takes the hairline's place.
                  <View paddingX="lg" paddingTop="md">
                    <View
                      direction="row"
                      align="stretch"
                      chrome="strong"
                      radius="lg"
                      clip
                      aspectRatio="banner"
                    >
                      <View
                        direction="column"
                        align="start"
                        justify="between"
                        padding="lg"
                        fill="grow-shrink"
                      >
                        <View direction="column" align="start" gap="xs">
                          <Text size="md" emphasis>
                            {t(`${K}.bankCards`)}
                          </Text>
                          <Text size="sm" muted>
                            {t(`${K}.bankCardsBody`)}
                          </Text>
                        </View>
                        <Button variant="solid" size="sm" onPress={onVerify}>
                          <ButtonText>{t(`${K}.activate`)}</ButtonText>
                        </Button>
                      </View>
                      <Image source={BANK_AND_CARDS} fit="cover" aspectRatio="portrait" />
                    </View>
                  </View>
                ) : null}

                <Heading title={t(`${K}.notifications`)} hairline={!showBankCards} />
                <List>
                  {NOTIFICATION_CATEGORIES.map((category) => {
                    const on = notifications ? categoryOn(notifications, category) : false;
                    return (
                      <ListSwitch
                        key={category}
                        accent="lilac"
                        checked={on}
                        onPress={() => chooseCategory(category, !on)}
                      >
                        <ListSwitchText>{t(`${K}.notify_${category}`)}</ListSwitchText>
                      </ListSwitch>
                    );
                  })}
                </List>

                <Heading title={t(`${K}.settings`)} />
                <List>
                  <ListAction
                    accessibilityLabel={`${t(`${K}.language`)}, ${LANGUAGE_OPTIONS[locale].label}`}
                    onPress={() => setPicker("language")}
                  >
                    <ListActionText>{t(`${K}.language`)}</ListActionText>
                    <ListActionTextMuted>{LANGUAGE_OPTIONS[locale].label}</ListActionTextMuted>
                    <ListActionTrailIcon name="chevron-right" />
                  </ListAction>
                  <ListAction
                    accessibilityLabel={`${t(`${K}.currency`)}, ${t(`${K}.currency_${currency}`)}`}
                    onPress={() => setPicker("currency")}
                  >
                    <ListActionText>{t(`${K}.currency`)}</ListActionText>
                    <ListActionTextMuted>{t(`${K}.currency_${currency}`)}</ListActionTextMuted>
                    <ListActionTrailIcon name="chevron-right" />
                  </ListAction>
                  {visible && PAY_WALLET_AVAILABLE ? (
                    <PayWalletProvider>
                      <CryptoWalletRow />
                    </PayWalletProvider>
                  ) : null}
                </List>

                <Heading title={t(`${K}.shop`)} />
                <List>
                  <ListAction accessibilityLabel={t(`${K}.esim`)} onPress={onOpenEsim}>
                    <ListActionText>{t(`${K}.esim`)}</ListActionText>
                    <ListActionTrailIcon name="chevron-right" />
                  </ListAction>
                </List>

                <Heading title={t(`${K}.account`)} />
                <List>
                  <ListAction accessibilityLabel={t(`${K}.logout`)} onPress={onLogout}>
                    <ListActionText>{t(`${K}.logout`)}</ListActionText>
                    <ListActionTrailIcon name="chevron-right" />
                  </ListAction>
                </List>

                <View paddingX="lg">
                  <Separator ySpace="none" />
                </View>
                <View paddingX="lg">
                  <Text size="sm" muted>
                    {t(`${K}.version`, { version: getAppVersion() })}
                  </Text>
                </View>
              </View>
            </Scroll>
          </Screen>
        </View>
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
