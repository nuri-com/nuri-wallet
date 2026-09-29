// Secret redaction for logs. Lifted verbatim from the original
// services/logging/DebugLogBuffer.ts so behaviour is unchanged. Zero deps so
// this ports to any app. Rule: keep logs readable, but never let private key
// material reach a log line.
export function redact(raw: string): string {
  let out = String(raw ?? "");
  if (!out) return "";

  out = out.replace(
    /("?(privateKey|authKeyHex|mnemonic|seedPhrase|seed|passphrase|nsec|ncryptsec|register_session_id|session_id|sessionId)"?\s*[:=]\s*")([^"]{6,})(")/gi,
    "$1[REDACTED]$4",
  );
  out = out.replace(
    /((?:private\s*key|mnemonic|seed(?:\s*phrase)?|passphrase|register_session_id|session_id|sessionId)\s*[:=]\s*)([^\s,;]{6,})/gi,
    "$1[REDACTED]",
  );
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY_BLOCK]",
  );
  return out;
}
