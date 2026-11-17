// @screen app.move-failure
import type { FC } from "react";
import { useEffect, useState } from "react";

import {
  Alert,
  AlertIcon,
  Button,
  ButtonText,
  Header,
  IconButton,
  List,
  ListAction,
  ListActionText,
  ListActionTrailingText,
  ListSeparator,
  Scroll,
  Text,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import { t } from "../lib/i18n";
import {
  subscribeSupportReports,
  supportReportState,
  type SupportReportState,
} from "../lib/support/reportErrorToSupport";
import { EventBus } from "../services/events/AppEventBusService";
import {
  type MoveFailureAttempt,
  moveFailureReference,
  sendMoveFailureReport,
} from "../services/support/MoveFailureReport";
import AppFooter from "./AppFooter";
import DsSheetHost from "./DsSheetHost";

/**
 * A failed move's details (#1932): what went wrong in plain words, when, the
 * error's class and code, and the support report for this very attempt. The
 * sheet stays open while the report is sent, so it can say whether it arrived
 * and offer a retry when it did not.
 */
const MoveFailureSheet: FC<{
  visible: boolean;
  attempt: MoveFailureAttempt;
  onClose: () => void;
}> = ({ visible, attempt, onClose }) => {
  const [report, setReport] = useState<SupportReportState | null>(() =>
    supportReportState(attempt.subject),
  );

  useEffect(() => {
    const read = () => setReport(supportReportState(attempt.subject));
    read();
    return subscribeSupportReports(read);
  }, [attempt]);

  const reference = moveFailureReference(attempt.error);
  const at = new Date(attempt.at).toLocaleString();

  const openChat = () => {
    // The report is already with support: open the chat, never a second report.
    EventBus.emit("support:openNostrChat");
    onClose();
  };

  const reportLine =
    report?.state === "sent"
      ? t("screen.MoveFailureSheet.reportSent", { id: report.reportId.slice(0, 8) })
      : report?.state === "sending"
        ? t("screen.MoveFailureSheet.reportSending")
        : report?.state === "failed"
          ? t("screen.MoveFailureSheet.reportFailed")
          : null;
  const action =
    report?.state === "sent"
      ? { label: t("screen.MoveFailureSheet.openChat"), onPress: openChat }
      : {
          label:
            report?.state === "failed"
              ? t("screen.MoveFailureSheet.retry")
              : t("screen.MoveFailureSheet.send"),
          onPress: () => {
            void sendMoveFailureReport(attempt);
          },
        };

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t("swap.move.failed")}</TopbarTitle>
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
        <View direction="column" align="stretch" gap="lg" paddingBottom="lg">
          <View paddingX="lg">
            <Alert variant="soft" accent="orange">
              <AlertIcon name="warning-circle" />
              {t("screen.MoveFailureSheet.explanation")}
            </Alert>
          </View>
          <List>
            <ListAction accessibilityLabel={t("screen.MoveFailureSheet.when")}>
              <ListActionText>{t("screen.MoveFailureSheet.when")}</ListActionText>
              <ListActionTrailingText>{at}</ListActionTrailingText>
            </ListAction>
            <ListSeparator />
            <ListAction accessibilityLabel={t("screen.MoveFailureSheet.error")}>
              <ListActionText>{t("screen.MoveFailureSheet.error")}</ListActionText>
              <ListActionTrailingText>
                {reference === null
                  ? t("screen.MoveFailureSheet.errorNone")
                  : reference || t("screen.MoveFailureSheet.errorRecorded")}
              </ListActionTrailingText>
            </ListAction>
          </List>
          {reportLine ? (
            <View paddingX="lg">
              <Text size="sm" muted>
                {reportLine}
              </Text>
            </View>
          ) : null}
        </View>
      </Scroll>
      <AppFooter canvas>
        <Button
          size="lg"
          variant="soft"
          disabled={report?.state === "sending"}
          onPress={action.onPress}
          accessibilityLabel={action.label}
        >
          <ButtonText>{action.label}</ButtonText>
        </Button>
      </AppFooter>
    </DsSheetHost>
  );
};

export default MoveFailureSheet;
