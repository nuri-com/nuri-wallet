export type Country = {
  iso2: string; // uppercase ISO 3166-1 alpha-2
  name: string;
  dialCode: string; // numeric, no leading +
};

export const CUSTOM_COUNTRY_ISO2 = "__CUSTOM__";
export const CUSTOM_COUNTRY_NAME = "Enter Country Code";

// Phone countries shown in Verify Phone OTP country dropdown.
export const EEA_COUNTRIES: Country[] = [
  { iso2: "AE", name: "United Arab Emirates", dialCode: "971" },
  { iso2: "AR", name: "Argentina", dialCode: "54" },
  { iso2: "AT", name: "Austria", dialCode: "43" },
  { iso2: "AU", name: "Australia", dialCode: "61" },
  { iso2: "BE", name: "Belgium", dialCode: "32" },
  { iso2: "BG", name: "Bulgaria", dialCode: "359" },
  { iso2: "BO", name: "Bolivia", dialCode: "591" },
  { iso2: "BR", name: "Brazil", dialCode: "55" },
  { iso2: "CH", name: "Switzerland", dialCode: "41" },
  { iso2: "CO", name: "Colombia", dialCode: "57" },
  { iso2: "HR", name: "Croatia", dialCode: "385" },
  { iso2: "CY", name: "Cyprus", dialCode: "357" },
  { iso2: "CZ", name: "Czechia", dialCode: "420" },
  { iso2: "GB", name: "United Kingdom", dialCode: "44" },
  { iso2: "DK", name: "Denmark", dialCode: "45" },
  { iso2: "EE", name: "Estonia", dialCode: "372" },
  { iso2: "FI", name: "Finland", dialCode: "358" },
  { iso2: "FR", name: "France", dialCode: "33" },
  { iso2: "DE", name: "Germany", dialCode: "49" },
  { iso2: "GH", name: "Ghana", dialCode: "233" },
  { iso2: "GR", name: "Greece", dialCode: "30" },
  { iso2: "HU", name: "Hungary", dialCode: "36" },
  { iso2: "IE", name: "Ireland", dialCode: "353" },
  { iso2: "IT", name: "Italy", dialCode: "39" },
  { iso2: "JP", name: "Japan", dialCode: "81" },
  { iso2: "KE", name: "Kenya", dialCode: "254" },
  { iso2: "LV", name: "Latvia", dialCode: "371" },
  { iso2: "LT", name: "Lithuania", dialCode: "370" },
  { iso2: "LU", name: "Luxembourg", dialCode: "352" },
  { iso2: "MY", name: "Malaysia", dialCode: "60" },
  { iso2: "MT", name: "Malta", dialCode: "356" },
  { iso2: "MX", name: "Mexico", dialCode: "52" },
  { iso2: "NG", name: "Nigeria", dialCode: "234" },
  { iso2: "NL", name: "Netherlands", dialCode: "31" },
  { iso2: "PY", name: "Paraguay", dialCode: "595" },
  { iso2: "PH", name: "Philippines", dialCode: "63" },
  { iso2: "PL", name: "Poland", dialCode: "48" },
  { iso2: "PT", name: "Portugal", dialCode: "351" },
  { iso2: "RO", name: "Romania", dialCode: "40" },
  { iso2: "SG", name: "Singapore", dialCode: "65" },
  { iso2: "SK", name: "Slovakia", dialCode: "421" },
  { iso2: "SI", name: "Slovenia", dialCode: "386" },
  { iso2: "ZA", name: "South Africa", dialCode: "27" },
  { iso2: "ES", name: "Spain", dialCode: "34" },
  { iso2: "SE", name: "Sweden", dialCode: "46" },
  { iso2: "TZ", name: "Tanzania", dialCode: "255" },
  { iso2: "TH", name: "Thailand", dialCode: "66" },
  { iso2: "TR", name: "Turkey", dialCode: "90" },
  { iso2: "IS", name: "Iceland", dialCode: "354" },
  { iso2: "LI", name: "Liechtenstein", dialCode: "423" },
  { iso2: "NO", name: "Norway", dialCode: "47" },
].sort((a, b) => a.name.localeCompare(b.name));

export const findCountryByIso2 = (iso2: string): Country | undefined =>
  EEA_COUNTRIES.find((c) => c.iso2.toUpperCase() === iso2.toUpperCase());

export const findCountryByDialCode = (dial: string): Country | undefined =>
  EEA_COUNTRIES.find((c) => c.dialCode === dial.replace(/^\+/, ""));

export const allDialCodesDesc = (): string[] =>
  [...new Set(EEA_COUNTRIES.map((c) => c.dialCode))].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
