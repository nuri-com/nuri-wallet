export type SanitizedPasskeyError = {
  code: string;
  errorName: string;
};

const safeErrorField = (value: unknown, fallback: string): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[a-zA-Z0-9_.-]{1,80}$/.test(normalized) ? normalized : fallback;
};

export function sanitizePasskeyError(error: unknown): SanitizedPasskeyError {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const message = error instanceof Error ? error.message : "";
  const messageClass = message.match(
    /\b([A-Z][a-zA-Z0-9]*(?:Credential|Exception)[a-zA-Z0-9]*)\b/,
  )?.[1];
  const recordName = safeErrorField(record?.name, "unknown");
  return {
    code: safeErrorField(record?.code, "unknown"),
    // React Native commonly wraps Credential Manager failures in a generic
    // Error while retaining the bounded provider class in the message.
    errorName: recordName === "Error" ? safeErrorField(messageClass, "Error") : recordName,
  };
}
