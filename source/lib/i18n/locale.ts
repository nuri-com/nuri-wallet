// Pure locale rules, kept free of Expo/RN imports so they are unit-testable.

/** A requested language, or English when the app does not ship it. */
export function resolveAppLocale<L extends string>(
  requested: string | null | undefined,
  supported: readonly L[],
): L {
  const code = String(requested ?? "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  const match = supported.find((locale) => locale === code);
  return match ?? (supported.includes("en" as L) ? ("en" as L) : supported[0]);
}

/**
 * The stored choice wins over the device language; with nothing (or something
 * unknown) stored the device language applies, as it did before there was a
 * choice to make.
 */
export function pickStartupLocale<L extends string>(
  stored: string | null | undefined,
  device: string | null | undefined,
  supported: readonly L[],
): L {
  const storedCode = String(stored ?? "")
    .trim()
    .toLowerCase();
  if (storedCode && supported.includes(storedCode as L)) return storedCode as L;
  return resolveAppLocale(device, supported);
}

/**
 * The string at a dotted `scope` in one locale's tree, with `%{name}`
 * placeholders filled from `values`. No fallback to another locale: a missing
 * key or value renders as a visible marker, as i18n-js rendered it.
 */
export function translate(
  tree: unknown,
  locale: string,
  scope: string,
  values?: Record<string, unknown>,
): string {
  let node: unknown = tree;
  for (const key of scope.split(".")) {
    node =
      node != null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
  }
  if (node == null) return `[missing "${locale}.${scope}" translation]`;
  if (typeof node !== "string") return node as string;
  return node.replace(/%\{([^}]+)\}/g, (placeholder, name: string) => {
    const value = values?.[name];
    return value == null ? `[missing "${placeholder}" value]` : String(value);
  });
}
