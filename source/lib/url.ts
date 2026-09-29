export const withCacheBuster = (url: string, key = "cb"): string => {
  const raw = String(url || "").trim();
  if (!raw) return raw;

  const hashIndex = raw.indexOf("#");
  const base = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const hash = hashIndex >= 0 ? raw.slice(hashIndex) : "";

  const qIndex = base.indexOf("?");
  const path = qIndex >= 0 ? base.slice(0, qIndex) : base;
  const query = qIndex >= 0 ? base.slice(qIndex + 1) : "";

  const parts = query
    ? query
        .split("&")
        .map((p) => p.trim())
        .filter(Boolean)
        .filter((p) => p.split("=", 1)[0] !== key)
    : [];

  parts.push(`${encodeURIComponent(key)}=${Date.now()}`);
  const nextQuery = parts.length > 0 ? `?${parts.join("&")}` : "";

  return `${path}${nextQuery}${hash}`;
};
