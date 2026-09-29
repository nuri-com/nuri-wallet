export type HomeIdentity = {
  handle: string;
  username: string;
  ensName: string;
};

const normalizeHandle = (value: string | null | undefined): string =>
  String(value || "")
    .trim()
    .toLowerCase();

export function applyVerifiedHomeHandle(
  current: HomeIdentity | null,
  value: string | null | undefined,
  ensParentDomain: string,
): HomeIdentity | null {
  const handle = normalizeHandle(value);
  if (!handle) return current;
  return {
    handle,
    username: handle.charAt(0).toUpperCase() + handle.slice(1),
    ensName: `${handle}.${ensParentDomain}`,
  };
}
