import { I18n } from "i18n-js";
import * as Localization from "expo-localization";

import { en } from "./en";
import { de } from "./de";

const translations = { en, de };

export const i18n = new I18n(translations);

const deviceLocale = Localization.getLocales()[0]?.languageCode ?? "en";
const resolvedLocale = Object.prototype.hasOwnProperty.call(translations, deviceLocale)
  ? deviceLocale
  : "en";
i18n.locale = resolvedLocale;

export const setAppLocale = (locale: string) => {
  i18n.locale = Object.prototype.hasOwnProperty.call(translations, locale) ? locale : "en";
};

export const t = i18n.t.bind(i18n);
