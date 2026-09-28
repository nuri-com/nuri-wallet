// Stub for expo-localization in the Node test environment: i18n falls back
// to "en" when no device locale is reported.
import type { Locale } from "expo-localization";
export const getLocales = (): Locale[] => [];
export default { getLocales };
