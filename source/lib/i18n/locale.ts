// Pure locale rules, kept free of Expo/RN imports so they are unit-testable.

const normalizeTag = (value: string | null | undefined): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");

/** The shipped locale spelled like `tag` (case and `_`/`-` ignored), if any. */
const exactLocale = <L extends string>(tag: string, supported: readonly L[]): L | undefined =>
  tag ? supported.find((locale) => normalizeTag(locale) === tag) : undefined;

/**
 * A requested language tag mapped to a shipped locale: the exact regional
 * variant when the app ships one (`pt-BR`), else the first shipped locale of
 * the same language (`pt-AO` -> `pt-PT`, `de-AT` -> `de`), else English.
 */
export function resolveAppLocale<L extends string>(
  requested: string | null | undefined,
  supported: readonly L[],
): L {
  const tag = normalizeTag(requested);
  const language = tag.split("-")[0];
  const match =
    exactLocale(tag, supported) ??
    supported.find((locale) => normalizeTag(locale).split("-")[0] === language);
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
  return exactLocale(normalizeTag(stored), supported) ?? resolveAppLocale(device, supported);
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
