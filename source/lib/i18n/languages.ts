// The languages the app ships, as the Settings picker shows them: each in its
// own name (a German speaker stuck in English still finds "Deutsch") with the
// flag the rest of the app already bundles. Adding a language = one entry here
// plus its translation file registered in ./index.
import type { ImageSourcePropType } from "react-native";
import type { AppLocale } from "./index";

export const LANGUAGE_OPTIONS: Record<AppLocale, { label: string; flag: ImageSourcePropType }> = {
  en: { label: "English", flag: require("../../assets/flags/gbr.png") },
  de: { label: "Deutsch", flag: require("../../assets/flags/deu.png") },
  sw: { label: "Kiswahili", flag: require("../../assets/flags/tza.png") },
  es: { label: "Español", flag: require("../../assets/flags/esp.png") },
  fr: { label: "Français", flag: require("../../assets/flags/fra.png") },
  it: { label: "Italiano", flag: require("../../assets/flags/ita.png") },
  nl: { label: "Nederlands", flag: require("../../assets/flags/nld.png") },
  pl: { label: "Polski", flag: require("../../assets/flags/pol.png") },
  "pt-PT": { label: "Português (Portugal)", flag: require("../../assets/flags/prt.png") },
  "pt-BR": { label: "Português (Brasil)", flag: require("../../assets/flags/bra.png") },
};
