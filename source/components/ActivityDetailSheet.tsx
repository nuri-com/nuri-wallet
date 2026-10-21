import type React from "react";
import { Image, type ImageSourcePropType, StyleSheet } from "react-native";

import {
  Button,
  ButtonIcon,
  ButtonText,
  Header,
  IconAvatar,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListSeparator,
  Scroll,
  Text,
  Topbar,
  TopbarLeading,
  TopbarTitle,
  View,
} from "@ds";
import type { IconName } from "@ds";

import DsSheetHost from "./DsSheetHost";
import { copyToClipboard } from "../lib/copyToClipboard";
import { type ActivityPerson, activityDetail } from "../lib/activityDetail";
import { getAppLocale, t } from "../lib/i18n";
import type { ActivityItem } from "./ActivitySheet";

const K = "component.ActivityRowActions";

type Props = {
  item: ActivityItem | null;
  /** The saved contact or Nuri user on the other side, if known. */
  person: ActivityPerson | null;
  /** Their picture: the contact's pet, else the row's own mark. */
  avatar: ImageSourcePropType | null;
  /** Offer "Add to address book" (the other side is not saved yet). */
  canSave: boolean;
  onSave: () => void;
  /** The row's Send again; the details close once it goes ahead. */
  onSendAgain: () => void;
  /** Send again is looking the recipient up. */
  sendAgainBusy?: boolean;
  /** Why Send again could not go ahead. */
  message?: string | null;
  onClose: () => void;
};

function formatWhen(iso: string | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(getAppLocale(), {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * One activity row in full, like the address book's contact page: who it was
 * with and the amount on top, then where it went, when and its state, then
 * what can be done with it (Send again, the explorer, Add to address book).
 */
const ActivityDetailSheet: React.FC<Props> = ({
  item,
  person,
  avatar,
  canSave,
  onSave,
  onSendAgain,
  sendAgainBusy = false,
  message = null,
  onClose,
}) => {
  const detail = item ? activityDetail(item, person) : null;
  const when = formatWhen(item?.createdAt);
  const statusText =
    detail?.status === "pending"
      ? t("common.pending")
      : detail?.status === "failed"
        ? t(`${K}.statusFailed`)
        : t(`${K}.statusCompleted`);

  return (
    <DsSheetHost visible={item !== null} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarLeading>
            <IconButton
              icon="chevron-left"
              variant="soft"
              accessibilityLabel={t("common.back")}
              onPress={onClose}
            />
          </TopbarLeading>
          <TopbarTitle>{""}</TopbarTitle>
        </Topbar>
      </Header>
      <Scroll safeAreaBottom>
        {item && detail ? (
          <View direction="column" align="stretch" gap="lg" paddingX="lg" paddingBottom="lg">
            <View direction="column" align="center" gap="sm">
              {avatar ? (
                <Image source={avatar} style={styles.heroAvatar} accessibilityIgnoresInvertColors />
              ) : (
                <IconAvatar variant="soft" icon={item.icon as IconName} />
              )}
              <Text size="xl" emphasis align="center">
                {detail.title}
              </Text>
              {detail.handle ? (
                <Text size="sm" muted align="center">
                  {detail.handle}
                </Text>
              ) : null}
              {/* A swap states its figures in the From/To card below. */}
              {item.amount && !detail.swap ? (
                <Text size="3xl" emphasis align="center">
                  {item.amount}
                </Text>
              ) : null}
              {item.amountSecondary ? (
                <Text size="sm" muted align="center">
                  {item.amountSecondary}
                </Text>
              ) : null}
            </View>

            {item.onSendAgain ? (
              <Button
                size="lg"
                variant="solid"
                accent="lilac"
                disabled={sendAgainBusy}
                onPress={onSendAgain}
              >
                <ButtonIcon name="arrow-up" />
                <ButtonText>
                  {sendAgainBusy ? t("screen.AddressBook.nuriLookupBusy") : t(`${K}.sendAgain`)}
                </ButtonText>
              </Button>
            ) : null}
            {message ? (
              <Text size="sm" muted align="center">
                {message}
              </Text>
            ) : null}

            {detail.swap ? (
              <View
                variant="soft"
                radius="lg"
                paddingX="lg"
                paddingY="md"
                direction="column"
                align="stretch"
                gap="md"
              >
                {(["from", "to"] as const).map((side) => (
                  <View key={side} direction="column" align="stretch" gap="xs">
                    <Text size="sm" muted>
                      {t(side === "to" ? `${K}.to` : `${K}.from`)}
                    </Text>
                    <View direction="row" justify="between" align="center" gap="sm">
                      <Text size="md">{detail.swap?.[side].name}</Text>
                      {detail.swap?.[side].amount ? (
                        <Text size="md" emphasis>
                          {detail.swap[side].amount}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {detail.counterparty ? (
              <View
                variant="soft"
                radius="lg"
                paddingX="lg"
                paddingY="md"
                direction="row"
                align="center"
                gap="sm"
              >
                <View fill="grow-shrink" direction="column" align="stretch" gap="xs">
                  <Text size="sm" muted>
                    {t(detail.counterparty.direction === "to" ? `${K}.to` : `${K}.from`)}
                  </Text>
                  <Text size="md" mono flow="wrap">
                    {detail.counterparty.value}
                  </Text>
                </View>
                <IconButton
                  icon="copy"
                  variant="ghost"
                  accessibilityLabel={t("common.copy")}
                  onPress={() => void copyToClipboard(detail.counterparty?.value ?? "")}
                />
              </View>
            ) : null}

            <View
              variant="soft"
              radius="lg"
              paddingX="lg"
              paddingY="md"
              direction="column"
              align="stretch"
              gap="md"
            >
              {when ? (
                <View direction="column" align="stretch" gap="xs">
                  <Text size="sm" muted>
                    {t(`${K}.date`)}
                  </Text>
                  <Text size="md">{when}</Text>
                </View>
              ) : null}
              <View direction="column" align="stretch" gap="xs">
                <Text size="sm" muted>
                  {t(`${K}.status`)}
                </Text>
                <Text size="md">{statusText}</Text>
              </View>
            </View>

            {item.onPress || canSave ? (
              <List>
                {item.onPress ? (
                  <ListAction
                    accessibilityLabel={item.onPressLabel ?? t(`${K}.open`)}
                    onPress={item.onPress}
                  >
                    <ListActionLeadingAvatar name="chevron-right" variant="outline" />
                    <ListActionText>{item.onPressLabel ?? t(`${K}.open`)}</ListActionText>
                  </ListAction>
                ) : null}
                {item.onPress && canSave ? <ListSeparator /> : null}
                {canSave ? (
                  <ListAction accessibilityLabel={t(`${K}.addToAddressBook`)} onPress={onSave}>
                    <ListActionLeadingAvatar name="plus" variant="outline" />
                    <ListActionText>{t(`${K}.addToAddressBook`)}</ListActionText>
                  </ListAction>
                ) : null}
              </List>
            ) : null}
          </View>
        ) : null}
      </Scroll>
    </DsSheetHost>
  );
};

const styles = StyleSheet.create({
  // Same hero size as the address book's contact page.
  heroAvatar: { width: 96, height: 96, borderRadius: 48 },
});

export default ActivityDetailSheet;
