import { useEffect, useRef } from "react";

import { nextAmountFromKey } from "../../../lib/pay/amountKeyboard";

type Options = {
  /** Only while the amount step is on screen AND no soft keypad is offered. */
  enabled: boolean;
  /** Whether the chosen asset has a decimal point (sats do not). */
  decimals: boolean;
  amount: string;
  canSubmit: boolean;
  onAmount: (next: string) => void;
  onSubmit: () => void;
};

/**
 * The amount step's hardware keyboard, for the desktop pay page (no soft
 * keypad there). Digits and the decimal point type, Backspace deletes, Enter
 * presses Continue.
 *
 * A browser keydown handler rather than a real text field: the page's figure
 * is a display, not an input, and it must not gain a caret or an OS text
 * keyboard on the phones and tablets that keep the keypad.
 */
export function usePayAmountKeyboard({
  enabled,
  decimals,
  amount,
  canSubmit,
  onAmount,
  onSubmit,
}: Options): void {
  const amountRef = useRef(amount);
  amountRef.current = amount;
  const canSubmitRef = useRef(canSubmit);
  canSubmitRef.current = canSubmit;
  const onAmountRef = useRef(onAmount);
  onAmountRef.current = onAmount;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const decimalsRef = useRef(decimals);
  decimalsRef.current = decimals;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      // A shortcut belongs to the browser or the OS, never to the figure.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // A control the payer is on (the From trigger, a picker row, the close
      // button) or a field/dialog owns the keystroke: Enter must activate it,
      // not submit this form, so the event is left completely alone.
      if (isInteractiveTarget(event.target)) return;
      if (event.key === "Enter") {
        if (!canSubmitRef.current) return;
        event.preventDefault();
        onSubmitRef.current();
        return;
      }
      const next = nextAmountFromKey(event.key, amountRef.current, {
        decimals: decimalsRef.current,
      });
      if (next === null) return;
      event.preventDefault();
      onAmountRef.current(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/**
 * A focusable control, a text field, or anything inside a dialog. Enter and the
 * digits belong to those, not to the amount: the source chooser's rows are
 * `role="button"`, and its sheet has no dialog ancestor to recognise.
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (typeof window === "undefined" || !target) return false;
  const element = target as HTMLElement;
  if (typeof element.closest !== "function") return false;
  return Boolean(
    element.closest(
      "input, textarea, select, button, a, [role='button'], [role='link'], [tabindex], [contenteditable='true'], [role='dialog']",
    ),
  );
}
