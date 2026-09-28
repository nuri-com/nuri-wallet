/**
 * CountryPicker — a searchable, flag-illustrated country list.
 *
 * Self-contained content block (search field + filtered rows); the host owns
 * presentation (a wizard step, a full Modal, …). Rows show a flag avatar, the
 * country name, and — when `showDialCode` — the dial code as muted trailing
 * text. Search matches name or dial code.
 */

import type React from "react";
import { Fragment, useMemo, useState } from "react";

import {
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  ListSeparator,
  TextField,
  TextFieldIconButton,
  View,
} from "@ds";
import { flagForIso2 } from "../lib/countryFlags";
import { t } from "../lib/i18n";
import type { Country } from "../lib/phone/eea";

type Props = {
  countries: Country[];
  onSelect: (iso2: string) => void;
  showDialCode?: boolean;
};

const CountryPicker: React.FC<Props> = ({ countries, onSelect, showDialCode = false }) => {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0) return countries;
    return countries.filter(
      (c) => c.name.toLocaleLowerCase().includes(needle) || c.dialCode.includes(needle),
    );
  }, [countries, query]);

  return (
    <View direction="column" align="stretch" gap="md">
      <TextField
        value={query}
        onChangeText={setQuery}
        accessibilityLabel={t("component.CountryPicker.searchLabel")}
        placeholder={t("component.CountryPicker.searchPlaceholder")}
      >
        {query.length > 0 ? (
          <TextFieldIconButton
            name="cross-circle"
            accessibilityLabel={t("component.CountryPicker.clearSearch")}
            onPress={() => setQuery("")}
          />
        ) : null}
      </TextField>

      <List>
        {filtered.map((country, index) => (
          <Fragment key={country.iso2}>
            {index > 0 ? <ListSeparator /> : null}
            <ListAction
              accessibilityLabel={
                showDialCode ? `${country.name}, +${country.dialCode}` : country.name
              }
              onPress={() => onSelect(country.iso2)}
            >
              <ListActionLeadingAvatar source={flagForIso2(country.iso2)} />
              <ListActionText>{country.name}</ListActionText>
              {showDialCode ? (
                <ListActionTextMuted>{`+${country.dialCode}`}</ListActionTextMuted>
              ) : null}
            </ListAction>
          </Fragment>
        ))}
      </List>
    </View>
  );
};

export default CountryPicker;
