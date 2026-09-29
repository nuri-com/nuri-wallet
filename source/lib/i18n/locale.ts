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
