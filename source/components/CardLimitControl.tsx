// Presentational daily-limit control: the limit input + validation + save button
// with saving / success states. It owns NO data source — the parent limit modal
// loads the current limit and performs the save, and passes the current value
// in, receiving `onSave(amount)` out. Extracted so callers reuse the exact same
// UI (single source). Wirex applies limit changes instantly, so there is no
// pending/countdown state.
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  ButtonText,
  Text,
  TextField,
  type TextFieldHandle,
  TextFieldLabel,
  View,
} from "@ds";
import { t } from "../lib/i18n";

type Props = {
  /** Whether the containing sheet is open — used to reset the input on open. */
  visible: boolean;
  /** Currently applied limit amount (null = unknown / not loaded). */
  value: number | null;
  maxLimit: number;
  hasLimit: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  showSuccess: boolean;
  autoFocus?: boolean;
  onSave: (amount: number) => void;
};

const CardLimitControl: React.FC<Props> = ({
  visible,
  value,
  maxLimit,
  hasLimit,
  loading,
  saving,
  error,
  showSuccess,
  autoFocus = true,
  onSave,
}) => {
  const [inputValue, setInputValue] = useState<string>(
    typeof value === "number" ? String(Math.round(value)) : "",
  );
  const inputRef = useRef<TextFieldHandle>(null);

  // Reset the input to the applied limit whenever the sheet opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the sheet opens; adding value would clobber typing on background refreshes
  useEffect(() => {
    if (!visible) return;
    if (typeof value === "number" && Number.isFinite(value)) {
      setInputValue(String(Math.round(value)));
    }
  }, [visible]);

  // Focus once on mount (this control renders as an in-sheet sub-page, so
  // mount is the "opened" moment; there is no sheet animation to wait for).
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Seed the input when a value first arrives (input still empty) or after a
  // successful apply — but never clobber active typing on a background refresh.
  useEffect(() => {
    if ((inputValue === "" || showSuccess) && typeof value === "number" && Number.isFinite(value)) {
      setInputValue(String(Math.round(value)));
    }
  }, [value, showSuccess, inputValue]);

  const normalizedInput = useMemo(
    () => String(inputValue || "").replace(/[^\d]/g, ""),
    [inputValue],
  );
  const parsedLimit = useMemo(() => {
    if (!normalizedInput.length) return null;
    const v = Number(normalizedInput);
    return Number.isFinite(v) ? v : null;
  }, [normalizedInput]);

  const validationError = useMemo(() => {
    if (!hasLimit || !normalizedInput.length) return null;
    if (parsedLimit === null || !Number.isInteger(parsedLimit)) {
      return t("screen.CardLimitModal.errorInteger");
    }
    if (parsedLimit < 1 || parsedLimit > maxLimit) {
      return t("screen.CardLimitModal.errorRange", { max: maxLimit });
    }
    return null;
  }, [hasLimit, normalizedInput, parsedLimit, maxLimit]);

  const statusText = error || validationError;
  const updateLabel = showSuccess
    ? t("screen.CardLimitModal.updated")
    : saving
      ? t("screen.CardLimitModal.saving")
      : t("screen.CardLimitModal.update");

  const canUpdate = hasLimit && !loading && !saving && !validationError && parsedLimit !== null;

  return (
    <View direction="column" align="stretch" gap="md">
      <TextField
        ref={inputRef}
        value={normalizedInput}
        onChangeText={(v) => setInputValue(v.replace(/[^\d]/g, ""))}
        inputMode="numeric"
        placeholder={t("screen.CardLimitModal.limitPlaceholder", { max: maxLimit })}
        disabled={loading || saving || !hasLimit}
      >
        <TextFieldLabel>{t("screen.CardLimitModal.newLimit")}</TextFieldLabel>
      </TextField>
      {statusText ? (
        <Text size="md" muted align="center">
          {statusText}
        </Text>
      ) : null}
      <Button
        size="lg"
        variant="solid"
        accent="lilac"
        disabled={!canUpdate}
        onPress={() => {
          if (canUpdate && parsedLimit !== null) onSave(parsedLimit);
        }}
        accessibilityLabel={updateLabel}
      >
        <ButtonText>{updateLabel}</ButtonText>
      </Button>
    </View>
  );
};

export default CardLimitControl;
