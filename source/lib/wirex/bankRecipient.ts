// A bank transfer's recipient, to and from the address book: a saved bank
// contact becomes the transfer's recipient (name split the way the recipient
// form splits it), and a transfer that went out becomes a bank destination to
// save. Pure, so both directions are testable.
import type { Contact, Destination } from "../addressBook/contact";
import { normalizeIbanInput } from "../ibanFormat";

export type BankTransferRecipient = {
  iban: string;
  bic: string;
  firstName: string;
  lastName: string;
};

/**
 * The transfer recipient a saved bank contact stands for, or null for a
 * destination that is not a bank account. A one-word name is a company (the
 * form's company tab sends no last name); otherwise the first word is the
 * first name. The BIC is empty when the contact saved none: the caller looks
 * it up before the amount step.
 */
export function bankRecipientFromSaved(
  contact: Pick<Contact, "label">,
  destination: Destination,
): BankTransferRecipient | null {
  if (destination.type !== "bank") return null;
  const holder = (destination.holder || contact.label).trim().replace(/\s+/g, " ");
  const iban = normalizeIbanInput(destination.iban);
  if (!holder || !iban) return null;
  const [first = "", ...rest] = holder.split(" ");
  return {
    iban,
    bic: (destination.bic || "").replace(/\s+/g, "").toUpperCase(),
    firstName: rest.length ? first : holder,
    lastName: rest.join(" "),
  };
}

/** The name a sent-to recipient is saved under. */
export function bankRecipientName(
  recipient: Pick<BankTransferRecipient, "firstName" | "lastName">,
): string {
  return `${recipient.firstName} ${recipient.lastName}`.trim().replace(/\s+/g, " ");
}

/** The address-book destination for a recipient a transfer went out to. */
export function bankDestinationFor(recipient: BankTransferRecipient): Destination {
  const iban = normalizeIbanInput(recipient.iban);
  return {
    type: "bank",
    raw: iban,
    iban,
    bic: recipient.bic.replace(/\s+/g, "").toUpperCase(),
    holder: bankRecipientName(recipient),
  };
}
