// @screen wirex.cardLimit
// Inline daily-limit editor, rendered as a sub-page of WirexCardDetailsModal.
// The parent owns loading the current limit; this page renders the shared
// presentational CardLimitControl and applies the new value synchronously (one
// biometric signature via WirexService.setCardLimit), then asks the parent to
// re-read.
import type React from "react";
import { useState } from "react";
import { Text, View } from "@ds";
import CardLimitControl from "../../components/CardLimitControl";
import { LIMIT_MAX } from "../../config/constants";
import { t } from "../../lib/i18n";
import { type WirexCardLimit, wirexService } from "../../services/wirex/WirexService";

type Props = {
  cardId: string | null;
  limit: WirexCardLimit | null; // current limit (loaded by the parent); -1 = no limit
  onRefresh: () => Promise<void>; // parent re-reads the limit after a successful set
};

const WirexCardLimitEditor: React.FC<Props> = ({ cardId, limit, onRefresh }) => {
  const [saving, setSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (amount: number) => {
    if (!cardId) return;
    setSaving(true);
    setError(null);
    setShowSuccess(false);
    try {
      await wirexService.setCardLimit(cardId, amount); // one biometric signature
      await onRefresh();
      setShowSuccess(true);
    } catch {
      setError(t("screen.CardLimitModal.errorDefault"));
    } finally {
      setSaving(false);
    }
  };

  // -1 = no limit (Wirex convention) → treat as "no value set".
  const daily = limit?.daily_limit;
  const value = typeof daily === "number" && daily >= 0 ? daily : null;

  // Current-state line: the formatted limit when one is set, "No limit set"
  // when Wirex reports -1. Omitted entirely when the read failed (limit null) —
  // better silent than wrong.
  const currentDisplay =
    limit === null
      ? null
      : value !== null
        ? (limit.currency ?? "EUR") === "EUR"
          ? `EUR ${Math.round(value)}`
          : `${limit.currency} ${Math.round(value)}`
        : t("screen.CardLimitModal.noLimitSet");

  return (
    <View direction="column" align="stretch" gap="md">
      {currentDisplay ? (
        <Text size="md" muted>
          {`${t("screen.CardLimitModal.currentLimit")}: ${currentDisplay}`}
        </Text>
      ) : null}
      <CardLimitControl
        visible
        value={value}
        maxLimit={LIMIT_MAX}
        hasLimit={limit !== null}
        loading={false}
        saving={saving}
        error={error}
        showSuccess={showSuccess}
        onSave={handleSave}
      />
    </View>
  );
};

export default WirexCardLimitEditor;
