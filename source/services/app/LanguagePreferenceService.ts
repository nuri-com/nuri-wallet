// The user's language choice from Settings. Stored per device (like the OS
// language it overrides), so it survives logout. Nothing stored = the device
// language, exactly as before the choice existed.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Localization from "expo-localization";

import { type AppLocale, SUPPORTED_LOCALES, setAppLocale } from "../../lib/i18n";
import { pickStartupLocale } from "../../lib/i18n/locale";

export const LANGUAGE_STORAGE_KEY = "@nuri:language:v1";

/** Applies the stored choice. Awaited before the first render. */
export async function initializeLanguagePreference(): Promise<void> {
  let stored: string | null = null;
  try {
    stored = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {}
  const device = Localization.getLocales()[0]?.languageTag ?? null;
  setAppLocale(pickStartupLocale(stored, device, SUPPORTED_LOCALES));
}

/** Switches the app language now and remembers it. */
export async function setLanguagePreference(locale: AppLocale): Promise<void> {
  setAppLocale(locale);
  try {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {}
}
