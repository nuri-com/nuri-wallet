import { WIREX_PROXY_BASE_URL } from "../../config/network";
import { USERNAME_REGEX } from "../arkade/usernameAvailability";

export function wirexKycPermalink(
  username: string | null | undefined,
  baseUrl = WIREX_PROXY_BASE_URL,
): string | null {
  const normalized = String(username || "")
    .trim()
    .toLowerCase();
  if (!USERNAME_REGEX.test(normalized)) return null;
  return `${baseUrl.replace(/\/+$/, "")}/mcp/kyc/${encodeURIComponent(normalized)}`;
}

export function canResumeWirexKyc(
  verificationStatus: string | null | undefined,
  isApproved: boolean,
  isRejected: boolean,
): boolean {
  const status = String(verificationStatus || "")
    .trim()
    .toLowerCase();
  return (
    !isApproved &&
    !isRejected &&
    Boolean(status) &&
    status !== "unknown" &&
    status !== "approved" &&
    status !== "rejected"
  );
}
