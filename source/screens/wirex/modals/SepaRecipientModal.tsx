// @screen wirex.sepa-recipient
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  Scroll,
  Text,
  TextField,
  TextFieldButton,
  TextFieldLabel,
  Topbar,
  TopbarTitle,
  TopbarTrailing,
  View,
} from "@ds";
import type { TextFieldHandle } from "@ds";
import AddressBookSuggestions from "../../../components/AddressBookSuggestions";
import DsSheetHost from "../../../components/DsSheetHost";
import type { DestinationSuggestion } from "../../../lib/addressBook/contact";
import { acceptsBankSend } from "../../addressBook/addressBookModel";
import { normalizeIbanInput } from "../../../lib/ibanFormat";
import { t } from "../../../lib/i18n";
import { isValidIban } from "../../../lib/validation";
import { wirexService } from "../../../services/wirex/WirexService";

export type SepaRecipientData = {
  iban: string;
  bic: string;
  firstName: string;
  lastName: string;
  reference?: string;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onContinue: (data: SepaRecipientData) => void;
  prefilledIban?: string | null;
  prefilledBic?: string | null;
  prefilledFirstName?: string | null;
  prefilledLastName?: string | null;
  prefilledReference?: string | null;
};

const SepaRecipientModal: React.FC<Props> = ({
  visible,
  onClose,
  onContinue,
  prefilledIban,
  prefilledBic,
  prefilledFirstName,
  prefilledLastName,
  prefilledReference,
}) => {
  const [iban, setIban] = useState("");
  const [bic, setBic] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [isCompany, setIsCompany] = useState(false);
  const [reference, setReference] = useState("");
  const [clipboardIban, setClipboardIban] = useState<string | null>(null);
  const ibanFieldRef = useRef<TextFieldHandle>(null);
  const nameFieldRef = useRef<TextFieldHandle>(null);
  // The name a saved contact filled in; the suggestions hide until it changes.
  const [pickedName, setPickedName] = useState<string | null>(null);
  const nameQuery = (isCompany ? firstName : `${firstName} ${lastName}`).trim();
  // IBAN lookup (server /iban/lookup): bank-name confirmation + validation message.
  const [bankName, setBankName] = useState<string | null>(null);
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);

  // Enable when required fields contain something (trimmed)
  const isContinueDisabled = useMemo(() => {
    const hasIban = iban.trim().length > 0;
    const hasBic = bic.trim().length > 0;
    const hasFirst = firstName.trim().length > 0;
    const hasLast = lastName.trim().length > 0;
    return isCompany
      ? !(hasIban && hasBic && hasFirst)
      : !(hasIban && hasBic && hasFirst && hasLast);
  }, [iban, bic, firstName, isCompany, lastName]);

  // On each fresh open, clear any recipient state left from a previous flow so a
  // blank sheet can't inherit and submit the prior IBAN/name. Runs before the
  // prefill effect below (declaration order), so prefills still land on top.
  useEffect(() => {
    if (!visible) return;
    setIban("");
    setBic("");
    setFirstName("");
    setLastName("");
    setReference("");
    setIsCompany(false);
    setBankName(null);
    setLookupMsg(null);
    setPickedName(null);
  }, [visible]);

  // Apply prefills (QR scanner or send-again from an activity row)
  useEffect(() => {
    if (!visible) return;
    if (prefilledIban != null) {
      const formatted = prefilledIban ? formatIbanInput(prefilledIban) : "";
      setIban(formatted);
      if (prefilledBic) {
        // BIC came with the prefill (activity rows carry it) — no lookup needed.
        setBic(prefilledBic.replace(/\s+/g, "").toUpperCase());
      } else {
        // Same treatment as paste: the prefilled IBAN replaces whatever was
        // there, so drop the old BIC and let the lookup autofill the new one.
        setBic("");
        if (formatted) void runIbanLookup(formatted);
      }
    }
    if (prefilledFirstName != null) setFirstName(prefilledFirstName);
    if (prefilledLastName != null) setLastName(prefilledLastName);
    // A prefilled recipient is already chosen: no suggestions for it.
    if (prefilledFirstName || prefilledLastName) {
      setPickedName(`${prefilledFirstName ?? ""} ${prefilledLastName ?? ""}`.trim());
    }
    if (prefilledReference != null) setReference(prefilledReference);
  }, [
    visible,
    prefilledIban,
    prefilledBic,
    prefilledFirstName,
    prefilledLastName,
    prefilledReference,
  ]);

  // Check clipboard for IBAN on open
  useEffect(() => {
    if (!visible) {
      setClipboardIban(null);
      return;
    }
    // Don't check if already prefilled from scanner
    if (prefilledIban) return;
    // On web, iOS shows its Paste/Speak callout for every clipboard read that
    // is not a direct tap on paste, so the PWA skips this unprompted read.
    if (Platform.OS === "web") return;
    (async () => {
      try {
        const text = await Clipboard.getStringAsync();
        if (!text) return;
        const clean = normalizeIbanInput(text);
        if (isValidIban(clean)) {
          setClipboardIban(clean);
        }
      } catch {}
    })();
  }, [visible, prefilledIban]);

  const sanitizeIban = normalizeIbanInput;
  const formatIbanInput = sanitizeIban;

  // Tracks the current sanitized IBAN so a late /iban/lookup response can be
  // discarded if the user changed the IBAN since the request went out (blur A →
  // edit/paste B → A resolves late would otherwise apply A's BIC/bank to B).
  const latestIbanRef = useRef("");
  useEffect(() => {
    latestIbanRef.current = normalizeIbanInput(iban);
  }, [iban]);

  // On IBAN blur: validate + derive BIC/bank on the server, autofill the BIC and
  // show the bank name. Assist only — on failure the user can still enter BIC by hand.
  const runIbanLookup = async (value = iban) => {
    const clean = sanitizeIban(value);
    if (!clean || !isValidIban(clean)) {
      setBankName(null);
      setLookupMsg(null);
      return;
    }
    // Claim this IBAN as the latest in-flight target BEFORE awaiting. On the
    // synchronous paste/prefill paths (setIban + immediate runIbanLookup) the
    // iban-effect hasn't updated the ref yet, so without this the stale-guard
    // below would wrongly discard this fresh lookup's own result.
    latestIbanRef.current = clean;
    try {
      const res = await wirexService.ibanLookup(clean);
      if (latestIbanRef.current !== clean) return; // IBAN changed since request — discard stale result
      if (res.valid && res.bic && !res.needsManualBic) setBic(res.bic);
      setBankName(res.valid ? res.bankName : null);
      setLookupMsg(res.valid ? null : (res.messages[0] ?? null));
    } catch {
      // lookup is an assist; ignore failures — BIC can be entered manually
    }
  };
  const pasteIban = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text?.trim()) {
        const formatted = formatIbanInput(text);
        setIban(formatted);
        setBic("");
        void runIbanLookup(formatted);
      }
    } catch {}
  };
  const pasteBic = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text?.trim()) setBic(text.replace(/\s+/g, "").toUpperCase());
    } catch {}
  };

  // Always-visible optional field — the sheet scrolls and the DS Modal
  // keyboard-avoids, so the extra row is safe on small screens.
  const referenceNode = (
    <TextField
      value={reference}
      onChangeText={(text) => setReference(text.slice(0, 120))}
      placeholder={t("screen.SepaRecipientModal.referencePlaceholder")}
      autoCapitalize="sentences"
    >
      <TextFieldLabel>{t("screen.SepaRecipientModal.referenceLabel")}</TextFieldLabel>
    </TextField>
  );

  const onSubmit = () => {
    const clean = sanitizeIban(iban);
    const cleanBic = bic.trim().toUpperCase();
    // Recipient details are bank-account PII and the console buffer feeds
    // support dumps — only presence/shape of the fields is logged.
    console.log("[SepaRecipientModal] Continue pressed", {
      ibanLength: clean.length,
      hasFirstName: firstName.trim().length > 0,
      hasLastName: lastName.trim().length > 0,
    });
    if (!isValidIban(clean)) {
      console.log("[SepaRecipientModal] Invalid IBAN");
      return;
    }
    if (!cleanBic) {
      console.log("[SepaRecipientModal] Missing BIC");
      return;
    }
    try {
      Keyboard.dismiss();
    } catch {}
    const data = {
      iban: clean,
      bic: cleanBic,
      firstName: firstName.trim(),
      lastName: isCompany ? "" : lastName.trim(),
      reference: reference.trim() || undefined,
    };
    console.log("[SepaRecipientModal] IBAN valid, invoking onContinue");
    try {
      onContinue?.(data);
    } catch {}
  };

  const pickSaved = ({ contact, destination }: DestinationSuggestion) => {
    if (destination.type !== "bank") return;
    const holder = (destination.holder || contact.label).trim();
    const parts = holder ? holder.split(/\s+/) : [];
    setIban(formatIbanInput(destination.iban));
    setBankName(null);
    setLookupMsg(null);
    if (destination.bic) {
      latestIbanRef.current = normalizeIbanInput(destination.iban);
      setBic(destination.bic);
    } else {
      setBic("");
      void runIbanLookup(destination.iban);
    }
    if (isCompany) {
      setFirstName(holder);
      setPickedName(holder);
    } else {
      const first = parts[0] ?? "";
      const last = parts.slice(1).join(" ");
      setFirstName(first);
      setLastName(last);
      setPickedName(`${first} ${last}`.trim());
    }
  };

  return (
    <DsSheetHost
      visible={visible}
      onClose={onClose}
      mode="full"
      onOpenComplete={() => nameFieldRef.current?.focus()}
    >
      <Header safeAreaTop chrome="canvas">
        <Topbar surface="transparent" layout="fluid">
          <TopbarTitle>{t("screen.SepaRecipientModal.headerTitle")}</TopbarTitle>
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

      <Scroll safeAreaBottom={false}>
        <View
          direction="column"
          align="stretch"
          justify="start"
          gap="xl"
          paddingX="lg"
          paddingBottom="lg"
        >
          {/* Segmented control composed from DS Buttons: selected = solid,
              unselected = soft. Same pattern as the card/bank toggle on the
              card details screen. */}
          <View direction="row" gap="sm" distribute="even">
            <Button
              size="sm"
              variant={!isCompany ? "solid" : "soft"}
              onPress={() => setIsCompany(false)}
              accessibilityLabel={t("screen.SepaRecipientModal.tabPersonal")}
            >
              <ButtonText>{t("screen.SepaRecipientModal.tabPersonal")}</ButtonText>
            </Button>
            <Button
              size="sm"
              variant={isCompany ? "solid" : "soft"}
              onPress={() => {
                setIsCompany(true);
                setLastName("");
              }}
              accessibilityLabel={t("screen.SepaRecipientModal.tabCompany")}
            >
              <ButtonText>{t("screen.SepaRecipientModal.tabCompany")}</ButtonText>
            </Button>
          </View>

          <View direction="column" align="stretch" justify="start" gap="lg">
            {/* Who first: typing a name searches the address book; a pick
                fills the name, IBAN and BIC. */}
            {isCompany ? (
              <TextField
                ref={nameFieldRef}
                value={firstName}
                onChangeText={setFirstName}
                placeholder={t("screen.SepaRecipientModal.companyPlaceholder")}
                autoCapitalize="words"
              >
                <TextFieldLabel>{t("screen.SepaRecipientModal.companyLabel")}</TextFieldLabel>
              </TextField>
            ) : (
              <View direction="row" align="stretch" justify="start" gap="md">
                <View fill="even">
                  <TextField
                    ref={nameFieldRef}
                    value={firstName}
                    onChangeText={setFirstName}
                    placeholder={t("screen.SepaRecipientModal.firstNamePlaceholder")}
                    autoCapitalize="words"
                  >
                    <TextFieldLabel>{t("screen.SepaRecipientModal.firstNameLabel")}</TextFieldLabel>
                  </TextField>
                </View>
                <View fill="even">
                  <TextField
                    value={lastName}
                    onChangeText={setLastName}
                    placeholder={t("screen.SepaRecipientModal.lastNamePlaceholder")}
                    autoCapitalize="words"
                  >
                    <TextFieldLabel>{t("screen.SepaRecipientModal.lastNameLabel")}</TextFieldLabel>
                  </TextField>
                </View>
              </View>
            )}
            {/* Saved bank contacts matching the typed name; nothing when none
                match, and gone once one is picked. */}
            <AddressBookSuggestions
              active={visible && nameQuery !== pickedName}
              query={nameQuery}
              accepts={acceptsBankSend}
              onPick={pickSaved}
            />

            <TextField
              ref={ibanFieldRef}
              value={iban}
              autoCapitalize="characters"
              onChangeText={(text) => {
                setIban(formatIbanInput(text));
                // The auto-filled BIC belongs to the previously looked-up IBAN. When
                // the IBAN content changes, drop the BIC so a signed SEPA payout can
                // never go out with a stale bank code (lookup A → edit to B → submit
                // B with A's BIC). latestIbanRef holds the prior sanitized IBAN.
                if (normalizeIbanInput(text) !== latestIbanRef.current) setBic("");
                if (bankName || lookupMsg) {
                  setBankName(null);
                  setLookupMsg(null);
                }
              }}
              onBlur={() => void runIbanLookup()}
              placeholder={t("screen.SepaRecipientModal.ibanPlaceholder")}
            >
              <TextFieldLabel>{t("screen.SepaRecipientModal.ibanLabel")}</TextFieldLabel>
              <TextFieldButton
                accessibilityLabel={t("screen.SepaRecipientModal.pasteAccessoryLabel")}
                onPress={() => void pasteIban()}
              >
                {t("screen.SepaRecipientModal.pasteAccessoryLabel")}
              </TextFieldButton>
            </TextField>

            {clipboardIban && !iban ? (
              <Button
                variant="soft"
                size="sm"
                accessibilityLabel={t("screen.SepaRecipientModal.pasteIbanA11yLabel")}
                onPress={() => {
                  setIban(clipboardIban);
                  setClipboardIban(null);
                  setBic("");
                  void runIbanLookup(clipboardIban);
                }}
              >
                <ButtonText>
                  {t("screen.SepaRecipientModal.pasteIbanLabel", { iban: clipboardIban })}
                </ButtonText>
              </Button>
            ) : null}

            <TextField
              value={bic}
              onChangeText={(text) => setBic(text.replace(/\s+/g, "").toUpperCase())}
              placeholder={t("screen.SepaRecipientModal.bicPlaceholder")}
              autoCapitalize="characters"
            >
              <TextFieldLabel>{t("screen.SepaRecipientModal.bicLabel")}</TextFieldLabel>
              <TextFieldButton
                accessibilityLabel={t("screen.SepaRecipientModal.pasteAccessoryLabel")}
                onPress={() => void pasteBic()}
              >
                {t("screen.SepaRecipientModal.pasteAccessoryLabel")}
              </TextFieldButton>
            </TextField>

            {bankName ? (
              <Text size="sm" muted>
                {bankName}
              </Text>
            ) : null}
            {lookupMsg ? (
              <Text size="sm" muted>
                {lookupMsg}
              </Text>
            ) : null}

            {referenceNode}
          </View>
        </View>
      </Scroll>

      <Footer
        safeAreaBottom
        chrome="canvas"
        direction="column"
        align="stretch"
        paddingBottom="sm"
        paddingX="lg"
      >
        <Button
          size="lg"
          variant="solid"
          accent="lilac"
          disabled={isContinueDisabled}
          onPress={onSubmit}
        >
          <ButtonText>{t("screen.SepaRecipientModal.continueLabel")}</ButtonText>
        </Button>
      </Footer>
    </DsSheetHost>
  );
};

export default SepaRecipientModal;
