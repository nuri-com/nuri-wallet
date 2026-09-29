/**
 * LogoutConfirmSheet — the explicit confirmation in front of a soft logout.
 *
 * Logging out here is not a session toggle: the wipe removes this device's key
 * material, so getting back in requires the passkey again. The sheet therefore
 * spells out the four things a user cannot check afterwards — what leaves the
 * device, that the passkey itself is the password manager's and survives, that
 * funds and accounts are untouched, and what signing back in needs.
 *
 * Presentational only. The caller owns the teardown (services/app/
 * UserLogoutService) and passes `busy` while it runs.
 *
 * `blocked` is the third state and the reason this sheet is not an alert: when
 * the teardown aborts part-way, auth state is already cleared and the keychain
 * wipe was already attempted, so there is no intact session to return to. The
 * sheet then loses its cancel, its close button and its scrim dismissal, and
 * offers only Try again — going back to the app over a half-destroyed identity
 * is precisely what must not happen.
 */

import type React from "react";

import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import DsSheetHost from "./DsSheetHost";
import { t } from "../lib/i18n";

type Props = {
  visible: boolean;
  /** Cancel — closes with no teardown, session untouched. */
  onClose: () => void;
  onConfirm: () => void;
  /** Teardown in flight: the app is about to reload, so nothing may re-fire. */
  busy?: boolean;
  /** A teardown aborted part-way. There is no session to go back to. */
  blocked?: boolean;
};

const BULLET_KEYS = ["bulletLocal", "bulletPasskey", "bulletFunds", "bulletSignIn"] as const;

const LogoutConfirmSheet: React.FC<Props> = ({ visible, onClose, onConfirm, busy, blocked }) => {
  // Neither mid-wipe nor after an aborted one: a scrim tap would hand back a
  // home screen whose keys are already gone.
  const sealed = Boolean(busy || blocked);

  const confirmLabel = busy
    ? t("screen.LogoutConfirm.confirmBusy")
    : blocked
      ? t("screen.LogoutConfirm.retry")
      : t("screen.LogoutConfirm.confirm");

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="sheet" dismissible={!sealed}>
      <Header paddingTop="lg">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>
            {blocked ? t("screen.LogoutConfirm.blockedTitle") : t("screen.LogoutConfirm.title")}
          </TopbarTitle>
          {sealed ? null : (
            <TopbarTrailing>
              <IconButton
                icon="cross"
                variant="soft"
                accessibilityLabel={t("common.close")}
                onPress={onClose}
              />
            </TopbarTrailing>
          )}
        </Topbar>
      </Header>

      <Scroll>
        <View direction="column" align="stretch" gap="md" paddingX="lg" paddingBottom="lg">
          {blocked ? (
            <Text size="md">{t("screen.LogoutConfirm.blockedBody")}</Text>
          ) : (
            BULLET_KEYS.map((key) => (
              <Text key={key} size="md" muted>
                {t(`screen.LogoutConfirm.${key}`)}
              </Text>
            ))
          )}
        </View>
      </Scroll>

      <Footer
        safeAreaBottom
        chrome="canvas"
        direction="column"
        align="stretch"
        gap="sm"
        paddingBottom="sm"
        paddingX="lg"
      >
        <Button size="lg" variant="solid" accent="orange" disabled={busy} onPress={onConfirm}>
          <ButtonText>{confirmLabel}</ButtonText>
        </Button>
        {/* No way back once a teardown has aborted — retry is the only exit. */}
        {sealed ? null : (
          <Button size="lg" variant="soft" onPress={onClose}>
            <ButtonText>{t("screen.LogoutConfirm.cancel")}</ButtonText>
          </Button>
        )}
      </Footer>
    </DsSheetHost>
  );
};

export default LogoutConfirmSheet;
