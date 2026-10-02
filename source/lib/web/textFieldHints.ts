/**
 * Web (PWA) only: stop Safari's contact AutoFill and autocorrect on the app's
 * data-entry fields.
 *
 * - Safari offers "AutoFill Contact" (and the user's own name as a word
 *   suggestion) on any field whose label or placeholder looks like a person's
 *   name, e.g. the address book "Name" or SEPA "Vorname". These fields hold
 *   other people's names, so that offer is wrong. `autocomplete="off"` alone
 *   does not stop it; a `name` attribute containing "search" does.
 * - Autocorrect rewrites names, addresses and handles ("emino.nuri.eth"
 *   became "Eminem.Nouri.eth"), and its suggestion row takes ~44pt of an
 *   already small screen. It is turned off except on free-text fields
 *   (autocapitalize="sentences": notes, transfer reference, chat).
 *
 * The DS TextField cannot pass these attributes, so they are reconciled on
 * every <input>/<textarea>: when it enters the DOM, when its mode changes (an
 * address-book row switching between phone and email keeps its input), and
 * when React strips one (React removes an input's `name` on every update when
 * the component sets none). Each pass writes only what differs from the wanted
 * state, so the observer never loops. Email fields keep AutoFill: filling in
 * your own email is the case it is for.
 *
 * No-op without a DOM (native).
 */

/** Prefix for the value an attribute had before this module changed it. */
const ORIGINAL = "data-nuri-hints-was-";
/** Stored as the original when the attribute was absent. */
const ABSENT = "";
/** The name generated for this field, kept so it survives React stripping it. */
const OWN_NAME = "data-nuri-hints-name";
/** Attributes whose change can alter the wanted state (or undo ours). */
export const WATCHED_ATTRIBUTES = [
  "type",
  "inputmode",
  "autocapitalize",
  "name",
  "autocomplete",
  "autocorrect",
  "spellcheck",
];

const TEXT_TYPES = new Set(["", "text", "search"]);
let counter = 0;

/** The subset of an input element this module reads and writes. */
export type HintTarget = {
  tagName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
};

/** Hold an attribute at `value`, remembering what it was the first time. */
function hold(el: HintTarget, name: string, value: string): void {
  if (!el.hasAttribute(ORIGINAL + name)) {
    el.setAttribute(ORIGINAL + name, el.getAttribute(name) ?? ABSENT);
  }
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** Give an attribute back its own value, if this module ever held it. */
function release(el: HintTarget, name: string): void {
  const was = el.getAttribute(ORIGINAL + name);
  if (was === null) return;
  el.removeAttribute(ORIGINAL + name);
  if (was === ABSENT) el.removeAttribute(name);
  else if (el.getAttribute(name) !== was) el.setAttribute(name, was);
}

export function applyTextFieldHints(el: HintTarget): void {
  const tag = el.tagName.toUpperCase();
  if (tag !== "INPUT" && tag !== "TEXTAREA") return;

  const text = tag === "TEXTAREA" || TEXT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase());
  const email = el.getAttribute("inputmode") === "email";
  const prose = el.getAttribute("autocapitalize") === "sentences";

  if (text && !email) {
    // A name the app set itself is left alone (a form may read it); otherwise
    // the field carries its own generated search_* name.
    const own = el.getAttribute(OWN_NAME);
    const current = el.getAttribute("name");
    if (!current || current === own) {
      const generated = own ?? `search_field_${++counter}`;
      if (!own) el.setAttribute(OWN_NAME, generated);
      if (current !== generated) el.setAttribute("name", generated);
    }
    hold(el, "autocomplete", "off");
  } else {
    const own = el.getAttribute(OWN_NAME);
    if (own !== null) {
      if (el.getAttribute("name") === own) el.removeAttribute("name");
      el.removeAttribute(OWN_NAME);
    }
    release(el, "autocomplete");
  }

  if (text && !prose) {
    hold(el, "autocorrect", "off");
    hold(el, "spellcheck", "false");
  } else {
    release(el, "autocorrect");
    release(el, "spellcheck");
  }
}

function applyWithin(node: Node): void {
  if (!(node instanceof Element)) return;
  applyTextFieldHints(node as unknown as HintTarget);
  node.querySelectorAll("input, textarea").forEach((el) => {
    applyTextFieldHints(el as unknown as HintTarget);
  });
}

export function installTextFieldHints(): void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  applyWithin(document.documentElement);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") applyTextFieldHints(record.target as unknown as HintTarget);
      else record.addedNodes.forEach(applyWithin);
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRIBUTES,
  });
}
