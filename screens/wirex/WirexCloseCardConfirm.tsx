// @screen wirex.closeCard
// Confirmation page for PERMANENTLY closing a card, rendered as a sub-page of
// WirexCardDetailsModal (same pattern as WirexCardLimitEditor). Deliberately its
// own page rather than an inline button: closing cannot be undone — Wirex has no
// reopen and no reissue route, so a replacement card carries a new PAN. Freeze
// stays the reversible option and keeps its place on the details page.
// This is the page BODY only: the confirm action lives in the sheet's footer, and
// backing out is the sheet's own back/close control. The consequence text is a
// plain paragraph, not an Alert — the alert message row is single-line and
// truncated it mid-sentence.
import type React from "react";
import { Text, View } from "@ds";
import { t } from "../../lib/i18n";

type Props = {
  // The close attempt failed. Scoped to this page: the freeze alert on the
  // details page has its own flag and must not show this.
  error?: boolean;
};

const WirexCloseCardConfirm: React.FC<Props> = ({ error }) => (
  <View direction="column" align="stretch" gap="lg">
    <Text size="md" muted>
      {t("screen.WirexCard.close.body")}
    </Text>
    {error ? (
      <Text size="md" muted align="center">
        {t("screen.WirexCard.actionError")}
      </Text>
    ) : null}
  </View>
);

export default WirexCloseCardConfirm;
