import { useCallback, useEffect, useRef, useState } from "react";
import { InteractionManager } from "react-native";

export type CurrencyToggleOpts<A extends string, B extends string> = {
  modeA: A;
  modeB: B;
  initialMode?: A | B;
  initialDigitsA?: string;
  initialDigitsB?: string;
  inputRef?: React.RefObject<{ focus: () => void } | null>;
  /** When provided and changes false→true, state resets to initial values. */
  visible?: boolean;
  /** Called inside `toggle` BEFORE switching the mode. Use this to invalidate
   *  in-flight quotes / clear preview state in the consumer. */
  onBeforeToggle?: () => void;
};

export type CurrencyToggleResult<A extends string, B extends string> = {
  inputMode: A | B;
  setInputMode: (m: A | B) => void;
  digitsA: string;
  digitsB: string;
  setDigitsA: (d: string) => void;
  setDigitsB: (d: string) => void;
  /** Switches A↔B, calls onBeforeToggle first, refocuses inputRef after interactions settle. */
  toggle: () => void;
  isModeA: boolean;
};

export function useCurrencyToggle<A extends string, B extends string>(
  opts: CurrencyToggleOpts<A, B>,
): CurrencyToggleResult<A, B> {
  const {
    modeA,
    modeB,
    initialMode,
    initialDigitsA = "",
    initialDigitsB = "",
    inputRef,
    visible,
    onBeforeToggle,
  } = opts;

  const resolvedInitialMode: A | B = initialMode ?? modeA;

  const [inputMode, setInputMode] = useState<A | B>(resolvedInitialMode);
  const [digitsA, setDigitsA] = useState<string>(initialDigitsA);
  const [digitsB, setDigitsB] = useState<string>(initialDigitsB);

  const onBeforeToggleRef = useRef(onBeforeToggle);
  onBeforeToggleRef.current = onBeforeToggle;

  const initialModeRef = useRef(resolvedInitialMode);
  initialModeRef.current = resolvedInitialMode;
  const initialDigitsARef = useRef(initialDigitsA);
  initialDigitsARef.current = initialDigitsA;
  const initialDigitsBRef = useRef(initialDigitsB);
  initialDigitsBRef.current = initialDigitsB;

  const modeARef = useRef(modeA);
  modeARef.current = modeA;
  const modeBRef = useRef(modeB);
  modeBRef.current = modeB;

  const prevVisibleRef = useRef<boolean | undefined>(visible);
  useEffect(() => {
    if (visible === undefined) {
      prevVisibleRef.current = visible;
      return;
    }
    const prev = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (visible && !prev) {
      setInputMode(initialModeRef.current);
      setDigitsA(initialDigitsARef.current);
      setDigitsB(initialDigitsBRef.current);
    }
  }, [visible]);

  const toggle = useCallback(() => {
    onBeforeToggleRef.current?.();
    setInputMode((m) => (m === modeARef.current ? modeBRef.current : modeARef.current));
    InteractionManager.runAfterInteractions(() => {
      try {
        inputRef?.current?.focus();
      } catch {}
    });
  }, [inputRef]);

  return {
    inputMode,
    setInputMode,
    digitsA,
    digitsB,
    setDigitsA,
    setDigitsB,
    toggle,
    isModeA: inputMode === modeA,
  };
}

export type KeypadEntryOpts = {
  /** Which half the keypad is currently typing into. */
  isModeA: boolean;
  digitsA: string;
  digitsB: string;
  /** The consumers' own sanitizing setters — they also clear their error state. */
  onChangeA: (raw: string) => void;
  onChangeB: (raw: string) => void;
};

export type KeypadEntryResult = {
  handleDigit: (digit: string) => void;
  handleDecimal: () => void;
  handleDelete: () => void;
};

/**
 * The AmountKeypad wiring for a two-unit amount: append, delete, and the
 * decimal point. Only the B half takes a decimal — A is the whole-number unit
 * (sats), so the consumer passes `undefined` for `onDecimal` while in mode A.
 */
export function useKeypadEntry(opts: KeypadEntryOpts): KeypadEntryResult {
  const { isModeA, digitsA, digitsB, onChangeA, onChangeB } = opts;

  const handleDigit = useCallback(
    (digit: string) => {
      if (isModeA) {
        onChangeA(digitsA + digit);
      } else {
        onChangeB(digitsB + digit);
      }
    },
    [isModeA, digitsA, digitsB, onChangeA, onChangeB],
  );

  const handleDecimal = useCallback(() => {
    onChangeB(`${digitsB}.`);
  }, [digitsB, onChangeB]);

  const handleDelete = useCallback(() => {
    if (isModeA) {
      onChangeA(digitsA.slice(0, -1));
    } else {
      onChangeB(digitsB.slice(0, -1));
    }
  }, [isModeA, digitsA, digitsB, onChangeA, onChangeB]);

  return { handleDigit, handleDecimal, handleDelete };
}
