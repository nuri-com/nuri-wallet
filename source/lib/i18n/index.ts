import * as Localization from "expo-localization";

import { en } from "./en";
import { de } from "./de";
import { sw } from "./sw";
import { es } from "./es";
import { fr } from "./fr";
import { it } from "./it";
import { nl } from "./nl";
import { pl } from "./pl";
import { ptPT } from "./pt-PT";
import { ptBR } from "./pt-BR";
import { tr } from "./tr";
import { uk } from "./uk";
import { resolveAppLocale, translate } from "./locale";

const translations = { en, de, sw, es, fr, it, nl, pl, "pt-PT": ptPT, "pt-BR": ptBR, tr, uk };

/** Every language the app ships, in the order the language picker lists them. */
export const SUPPORTED_LOCALES = Object.keys(translations) as AppLocale[];
export type AppLocale = keyof typeof translations;

const deviceLocale = Localization.getLocales()[0]?.languageTag ?? "en";
let currentLocale: AppLocale = resolveAppLocale(deviceLocale, SUPPORTED_LOCALES);

const listeners = new Set<() => void>();

/** The language the app is rendering in right now. */
export const getAppLocale = (): AppLocale => currentLocale;

export const setAppLocale = (locale: string) => {
  const next = resolveAppLocale(locale, SUPPORTED_LOCALES);
  if (next === currentLocale) return;
  currentLocale = next;
  for (const listener of listeners) listener();
};

/** Fires after the app language changed; returns the unsubscribe. */
export const subscribeAppLocale = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const t = (scope: string, values?: Record<string, unknown>): string =>
  translate(translations[currentLocale], currentLocale, scope, values);
