/**
 * PayoutAbroadSheet: pick where a Lightning payout lands abroad.
 *
 * Country, then method, then the method's recipient fields, all read live
 * from ZapRemit's catalog; bank and network lists are searchable. Methods
 * that ask for the sender's own identity are not offered. The sheet only
 * collects the destination: pricing, the quote and the payment stay on the
 * send screen that opened it.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  List,
  ListAction,
  ListActionLeadingAvatar,
  ListActionText,
  ListActionTextMuted,
  ListActionTrailIcon,
  ListSeparator,
  Scroll,
  Text,
  TextField,
  TextFieldLabel,
  Topbar,
  TopbarLeading,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";

import DsSheetHost from "./DsSheetHost";
import { flagForIso2 } from "../lib/countryFlags";
import { groupCount } from "../lib/formatting";
import { t } from "../lib/i18n";
import {
  buildZapRemitRecipient,
  isZapRemitFormComplete,
  TANZANIA,
  TZ_METHODS,
  type ZapRemitDestination,
  type ZapRemitField,
  type ZapRemitMethod,
  type ZapRemitOption,
  zapRemitSummary,
} from "../lib/remit/zapremitForm";
import {
  getZapRemitCountries,
  getZapRemitMethods,
  getZapRemitOptions,
  listTzOptions,
  type ZapRemitCountry,
} from "../services/remit/RemitService";

const K = "component.PayoutAbroadSheet";

type Props = {
  visible: boolean;
  /**
   * What the opening screen pays with. Bitcoin reaches every destination
   * (Lightning, or a swap into USDC for a Tanzanian bank). A stablecoin pays
   * Tanzanian orders directly; ZapRemit takes Lightning only, and the bank
   * offer is USDC only.
   */
  payWith: "bitcoin" | "USDC" | "EURC";
  onClose: () => void;
  onDone: (destination: ZapRemitDestination) => void;
};

function methodsFor(country: string, payWith: Props["payWith"]): ZapRemitMethod[] | null {
  if (country !== TANZANIA.code) return null;
  return payWith === "EURC" ? TZ_METHODS.filter((m) => m.code !== "TZ_BANK") : TZ_METHODS;
}

/** Our own words for the fields ZapRemit names; anything new shows its label. */
function fieldLabel(field: ZapRemitField): string {
  switch (field.name) {
    case "fullName":
    case "accountName":
      return t(`${K}.fieldFullName`);
    case "phoneNumber":
      return t(`${K}.fieldPhoneNumber`);
    case "accountNumber":
      return field.label === "CLABE" ? "CLABE" : t(`${K}.fieldAccountNumber`);
    case "cardNumber":
      return t(`${K}.fieldCardNumber`);
    case "bic":
      return t(`${K}.fieldBank`);
    case "providerCode":
      return t(`${K}.fieldNetwork`);
    case "institutionCode":
      return /bank/i.test(field.label) ? t(`${K}.fieldBank`) : t(`${K}.fieldNetwork`);
    default:
      return field.label;
  }
}

function inputModeFor(field: ZapRemitField): "tel" | "numeric" | "text" {
  if (field.name === "phoneNumber") return "tel";
  if (["accountNumber", "cardNumber", "lipaNamba"].includes(field.name)) return "numeric";
  return "text";
}

export default function PayoutAbroadSheet({ visible, payWith, onClose, onDone }: Props) {
  const [countries, setCountries] = useState<ZapRemitCountry[] | null>(null);
  const [country, setCountry] = useState<ZapRemitCountry | null>(null);
  const [methods, setMethods] = useState<ZapRemitMethod[] | null>(null);
  const [method, setMethod] = useState<ZapRemitMethod | null>(null);
  const [options, setOptions] = useState<Record<string, ZapRemitOption[]>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<ZapRemitField | null>(null);
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);

  const reset = useCallback(() => {
    setCountries(null);
    setCountry(null);
    setMethods(null);
    setMethod(null);
    setOptions({});
    setValues({});
    setPicking(null);
    setQuery("");
    setFailed(false);
  }, []);

  useEffect(() => {
    if (!visible) reset();
  }, [visible, reset]);

  // Load whatever the current step needs. Leaving a step (or the sheet) drops
  // its answer: `live` goes false in the cleanup. Try again clears `failed`,
  // which runs this once more.
  useEffect(() => {
    if (!visible || failed) return;
    let live = true;
    const fail = () => live && setFailed(true);
    if (!country && countries === null) {
      // Tanzania is ours on the same host and pays with any balance; ZapRemit's
      // countries take Lightning only, so a stablecoin screen offers Tanzania.
      if (payWith !== "bitcoin") {
        setCountries([TANZANIA]);
      } else {
        getZapRemitCountries()
          .then((list) => live && setCountries([TANZANIA, ...list]))
          .catch(fail);
      }
    } else if (country && !method && methods === null) {
      const local = methodsFor(country.code, payWith);
      if (local) {
        setMethods(local);
      } else {
        getZapRemitMethods(country.code)
          .then((list) => live && setMethods(list))
          .catch(fail);
      }
    } else if (country && method) {
      const missing = method.fields.filter((f) => f.options && !options[f.name]);
      if (missing.length > 0) {
        Promise.all(
          missing.map((f) =>
            country.code === TANZANIA.code
              ? listTzOptions(f.name === "bic" ? "bic" : "providerCode")
              : getZapRemitOptions(country.code, method.code, f.name),
          ),
        )
          .then((lists) => {
            if (!live) return;
            const next = { ...options };
            missing.forEach((f, i) => {
              next[f.name] = lists[i];
            });
            setOptions(next);
            // A single choice (Kenya's M-Pesa) is no choice: fill it in.
            setValues((v) => {
              const filled = { ...v };
              missing.forEach((f, i) => {
                if (lists[i].length === 1 && !filled[f.name]) filled[f.name] = lists[i][0].code;
              });
              return filled;
            });
          })
          .catch(fail);
      }
    }
    return () => {
      live = false;
    };
  }, [visible, failed, payWith, country, countries, method, methods, options]);

  const back = () => {
    setFailed(false);
    if (picking) {
      setPicking(null);
      setQuery("");
    } else if (method) {
      setMethod(null);
      setValues({});
      setOptions({});
    } else if (country) {
      setCountry(null);
      setMethods(null);
    }
  };

  const optionName = (field: ZapRemitField): string | null => {
    const code = values[field.name];
    return options[field.name]?.find((o) => o.code === code)?.name ?? null;
  };

  const filteredOptions = useMemo(() => {
    if (!picking) return [];
    const list = options[picking.name] ?? [];
    const needle = query.trim().toLocaleLowerCase();
    return needle ? list.filter((o) => o.name.toLocaleLowerCase().includes(needle)) : list;
  }, [picking, options, query]);

  const complete = method ? isZapRemitFormComplete(method.fields, values) : false;

  const finish = () => {
    if (!country || !method || !complete) return;
    const recipient = buildZapRemitRecipient(country.code, method.fields, values);
    const institution = method.fields.find((f) => f.options);
    onDone({
      provider: country.code === TANZANIA.code ? "tz" : "zapremit",
      country: country.code,
      methodCode: method.code,
      currency: method.currency,
      recipient,
      summary: zapRemitSummary(recipient, institution ? optionName(institution) : null),
    });
  };

  const title = picking
    ? fieldLabel(picking)
    : method
      ? method.name
      : country
        ? country.name
        : t(`${K}.title`);

  const loading =
    !failed &&
    ((!country && countries === null) ||
      (country && !method && methods === null) ||
      (method && method.fields.some((f) => f.options && !options[f.name])));

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          {country ? (
            <TopbarLeading>
              <IconButton
                icon="chevron-left"
                variant="soft"
                accessibilityLabel={t("common.back")}
                onPress={back}
              />
            </TopbarLeading>
          ) : null}
          <TopbarTitle>{title}</TopbarTitle>
          <TopbarTrailing>
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel={t("common.close")}
              onPress={onClose}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>

      <Scroll safeAreaBottom={!method || !!picking}>
        <View direction="column" align="stretch" gap="lg" paddingY="md">
          {failed ? (
            <View direction="column" align="stretch" gap="md" paddingX="lg">
              <Text size="md" muted>
                {t(`${K}.loadFailed`)}
              </Text>
              <Button size="lg" variant="soft" onPress={() => setFailed(false)}>
                <ButtonText>{t("common.tryAgain")}</ButtonText>
              </Button>
            </View>
          ) : loading ? (
            <View paddingX="lg">
              <Text size="md" muted>
                {t("common.loading")}
              </Text>
            </View>
          ) : picking ? (
            <>
              <View paddingX="lg">
                <TextField
                  value={query}
                  onChangeText={setQuery}
                  placeholder={t(`${K}.search`)}
                  inputMode="search"
                  autoCapitalize="none"
                  accessibilityLabel={t(`${K}.search`)}
                />
              </View>
              <List>
                {filteredOptions.map((option, index) => (
                  <Fragment key={option.code}>
                    {index > 0 ? <ListSeparator /> : null}
                    <ListAction
                      accessibilityLabel={option.name}
                      onPress={() => {
                        setValues((v) => ({ ...v, [picking.name]: option.code }));
                        setPicking(null);
                        setQuery("");
                      }}
                    >
                      <ListActionText>{option.name}</ListActionText>
                    </ListAction>
                  </Fragment>
                ))}
              </List>
            </>
          ) : method && country ? (
            <View direction="column" align="stretch" gap="md" paddingX="lg">
              {method.fields.map((field) =>
                field.options ? (
                  <List key={field.name}>
                    <ListAction
                      accessibilityLabel={fieldLabel(field)}
                      onPress={() => setPicking(field)}
                    >
                      <ListActionText>{optionName(field) ?? fieldLabel(field)}</ListActionText>
                      {optionName(field) ? (
                        <ListActionTextMuted>{fieldLabel(field)}</ListActionTextMuted>
                      ) : null}
                      <ListActionTrailIcon name="chevron-right" />
                    </ListAction>
                  </List>
                ) : (
                  <TextField
                    key={field.name}
                    value={values[field.name] ?? ""}
                    onChangeText={(text) => setValues((v) => ({ ...v, [field.name]: text }))}
                    inputMode={inputModeFor(field)}
                    autoCapitalize={field.name === "fullName" ? "words" : "none"}
                    accessibilityLabel={fieldLabel(field)}
                  >
                    <TextFieldLabel>{fieldLabel(field)}</TextFieldLabel>
                  </TextField>
                ),
              )}
            </View>
          ) : country ? (
            <List>
              {(methods ?? []).map((m, index) => (
                <Fragment key={m.code}>
                  {index > 0 ? <ListSeparator /> : null}
                  <ListAction accessibilityLabel={m.name} onPress={() => setMethod(m)}>
                    <ListActionText>{m.name}</ListActionText>
                    <ListActionTextMuted>
                      {t(`${K}.upTo`, { amount: groupCount(m.max), currency: m.currency })}
                    </ListActionTextMuted>
                    <ListActionTrailIcon name="chevron-right" />
                  </ListAction>
                </Fragment>
              ))}
            </List>
          ) : (
            <List>
              {(countries ?? []).map((c, index) => (
                <Fragment key={c.code}>
                  {index > 0 ? <ListSeparator /> : null}
                  <ListAction
                    accessibilityLabel={c.name}
                    onPress={() => {
                      setCountry(c);
                      setMethods(null);
                    }}
                  >
                    <ListActionLeadingAvatar source={flagForIso2(c.code)} />
                    <ListActionText>{c.name}</ListActionText>
                    <ListActionTextMuted>{c.currency}</ListActionTextMuted>
                    <ListActionTrailIcon name="chevron-right" />
                  </ListAction>
                </Fragment>
              ))}
            </List>
          )}
        </View>
      </Scroll>

      {method && !picking && !failed ? (
        <Footer
          safeAreaBottom
          chrome="canvas"
          direction="column"
          align="stretch"
          paddingBottom="sm"
          paddingX="lg"
        >
          <Button size="lg" variant="solid" accent="lilac" disabled={!complete} onPress={finish}>
            <ButtonText>{t(`${K}.continue`)}</ButtonText>
          </Button>
        </Footer>
      ) : null}
    </DsSheetHost>
  );
}
