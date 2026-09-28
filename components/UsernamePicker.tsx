// Controlled picker for the user's Lightning handle (LUD-16 name@host).
// Validates locally, debounced-checks server availability; parent owns the claim.
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { Button, ButtonText, Text, TextField, type TextFieldHandle, View } from "@ds";
import { useAndroidAutofocus } from "../lib/androidFocus";
import { t } from "../lib/i18n";
import {
  checkUsernameAvailability,
  isUsernameFormatValid,
  type UsernameAvailability,
} from "../lib/arkade/usernameAvailability";

type Status = "idle" | "checking" | UsernameAvailability;

// LN address brand. Server-side `LNURL_DOMAIN` is nuri.com regardless of the
// arkade node URL the client is configured against, so the picker preview is
// always `<name>@nuri.com` to match what the server will return after claim.
const LIGHTNING_ADDRESS_HOST = "nuri.com";

type Props = {
  initialValue?: string;
  /** Disables the input + continue button while the parent is busy (e.g. claiming). */
  busy?: boolean;
  /** External error to surface above the continue button (e.g. server rejected the claim). */
  externalError?: string | null;
  /** Lets a parent render the submit button somewhere else while this component keeps the validation logic. */
  onSubmitControlChange?: (control: UsernamePickerSubmitControl) => void;
  autoFocus?: boolean;
  placeholder?: string;
  statusMode?: "all" | "errors";
  showHeader?: boolean;
  showStatus?: boolean;
  showPreview?: boolean;
  showSubmitButton?: boolean;
  /** Called when user submits a name that's locally valid and the most recent availability check returned "available". */
  onContinue: (name: string) => void;
  /** Notifies the host when editing invalidates a previously displayed host error. */
  onValueChange?: () => void;
};

const DEBOUNCE_MS = 350;
const ERROR_STATUSES = new Set<Status>(["taken", "invalid", "network_error"]);

// The DS TextField has no maxLength — enforce the legacy 32-char input cap in
// the change handler instead.
const MAX_USERNAME_INPUT_LENGTH = 32;

export type UsernamePickerSubmitControl = {
  canSubmit: boolean;
  submit: () => boolean;
  loading: boolean;
  label: string;
  accessibilityLabel: string;
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export const UsernamePicker: React.FC<Props> = ({
  initialValue = "",
  busy = false,
  externalError = null,
  onSubmitControlChange,
  autoFocus = false,
  placeholder,
  statusMode = "all",
  showHeader = true,
  showStatus = true,
  showPreview = true,
  showSubmitButton = true,
  onContinue,
  onValueChange,
}) => {
  const [value, setValue] = useState<string>(initialValue);
  const [status, setStatus] = useState<Status>("idle");
  const inputRef = useRef<TextFieldHandle>(null);
  const requestIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useAndroidAutofocus(inputRef, autoFocus && !busy);

  // iOS mount-time autofocus (the legacy InputField autoFocus prop; the DS
  // TextField has none). Android is handled by useAndroidAutofocus above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once on mount, like the legacy autoFocus prop
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (autoFocus && !busy) inputRef.current?.focus();
  }, []);

  const normalized = normalize(value);
  const formatValid = isUsernameFormatValid(normalized);

  const handleChangeText = useCallback(
    (next: string) => {
      // Keep disallowed characters visible so validation can explain why the
      // username cannot be claimed.
      setValue(next.slice(0, MAX_USERNAME_INPUT_LENGTH));
      onValueChange?.();
    },
    [onValueChange],
  );

  // Debounced availability check.
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (normalized.length === 0) {
      setStatus("idle");
      return;
    }
    if (!formatValid) {
      setStatus("invalid");
      return;
    }
    setStatus("checking");
    const requestId = ++requestIdRef.current;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      (async () => {
        try {
          const result = await checkUsernameAvailability(normalized);
          if (requestId !== requestIdRef.current) return;
          setStatus(result);
        } catch {
          if (requestId !== requestIdRef.current) return;
          setStatus("network_error");
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [normalized, formatValid]);

  // Bump the request id on unmount so any in-flight resolution is ignored.
  useEffect(
    () => () => {
      requestIdRef.current++;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  const canSubmit = !busy && formatValid && status === "available";

  const handleContinue = useCallback(() => {
    if (!canSubmit) return false;
    try {
      console.log(`[UsernamePicker] continue name=${normalized}`);
    } catch {}
    onContinue(normalized);
    return true;
  }, [canSubmit, normalized, onContinue]);

  const submitLabel = t("screen.UsernamePicker.continue");

  useEffect(() => {
    onSubmitControlChange?.({
      canSubmit,
      submit: handleContinue,
      loading: busy,
      label: submitLabel,
      accessibilityLabel: submitLabel,
    });
  }, [busy, canSubmit, handleContinue, onSubmitControlChange, submitLabel]);

  const statusText = useMemo(() => {
    switch (status) {
      case "checking":
        return t("screen.UsernamePicker.statusChecking");
      case "available":
        return t("screen.UsernamePicker.statusAvailable");
      case "taken":
        return t("screen.UsernamePicker.statusTaken");
      case "invalid":
        return t("screen.UsernamePicker.statusInvalid");
      case "network_error":
        return t("screen.UsernamePicker.statusNetworkError");
      default:
        return "";
    }
  }, [status]);

  const previewName = normalized.length > 0 ? normalized : t("screen.UsernamePicker.placeholder");
  const inputPlaceholder = placeholder ?? t("screen.UsernamePicker.placeholder");
  const shouldRenderStatusRow =
    showStatus && (statusMode === "all" || (statusText.length > 0 && ERROR_STATUSES.has(status)));
  // DS has no success/error text colors: problems read emphasized, neutral
  // progress reads muted (the converted send-sheet hint convention).
  const statusIsError = ERROR_STATUSES.has(status);

  return (
    <View direction="column" align="stretch" gap={showHeader ? "lg" : "md"}>
      {showHeader ? (
        <View direction="column" align="stretch" gap="xs">
          <Text size="md" emphasis>
            {t("screen.UsernamePicker.title")}
          </Text>
          <Text size="md" muted>
            {t("screen.UsernamePicker.subtitle")}
          </Text>
        </View>
      ) : null}

      <View direction="column" align="stretch" gap="sm">
        <TextField
          ref={inputRef}
          value={value}
          onChangeText={handleChangeText}
          autoCapitalize="none"
          placeholder={inputPlaceholder}
          disabled={busy}
          accessibilityLabel={t("screen.UsernamePicker.inputLabel")}
        />
        {shouldRenderStatusRow ? (
          <Text size="sm" muted={!statusIsError} emphasis={statusIsError}>
            {statusText}
          </Text>
        ) : null}
      </View>

      {showPreview ? (
        <View direction="column" align="stretch" gap="xs">
          <Text size="xs" muted>
            {t("screen.UsernamePicker.previewLabel")}
          </Text>
          <Text size="md" mono>{`${previewName}@${LIGHTNING_ADDRESS_HOST}`}</Text>
        </View>
      ) : null}

      {externalError ? (
        <Text size="sm" emphasis>
          {externalError}
        </Text>
      ) : null}

      {showSubmitButton ? (
        <Button
          size="lg"
          variant="solid"
          accent="lilac"
          disabled={!canSubmit}
          onPress={handleContinue}
          accessibilityLabel={submitLabel}
        >
          <ButtonText>{submitLabel}</ButtonText>
        </Button>
      ) : null}
    </View>
  );
};

export default UsernamePicker;
