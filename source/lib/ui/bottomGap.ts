/**
 * The one bottom gap under a screen's last button.
 *
 * Every screen's buttons sit the same distance from the bottom edge: the
 * device's bottom inset (home indicator, Android nav bar; 0 on Touch ID
 * iPhones and in a Safari tab with its toolbar docked) plus the DS `lg` space,
 * as the design system's send screens draw it.
 * `AppFooter` applies this rule through the DS Footer; the few
 * surfaces that cannot host a DS Footer (a WebView page, the keyboard-driven
 * onboarding footer) use the pixel form, so both land on the same number.
 *
 * The pixel values are the DS space tokens `sm` and `lg`
 * (pinned by bottomGap.test.ts against the vendored tokens).
 */

/** DS space `lg`: the gap above the inset is the same with or without one. */
export const BOTTOM_GAP_WITH_INSET = 18;
/** DS space `lg`. */
export const BOTTOM_GAP_WITHOUT_INSET = 18;

/** The DS space token the Footer adds on top of the bottom inset. */
export function bottomGapToken(_bottomInset: number): "lg" {
  return "lg";
}

/** The whole gap in px (inset included), for surfaces without a DS Footer. */
export function bottomGapPx(bottomInset: number): number {
  const inset = Number.isFinite(bottomInset) && bottomInset > 0 ? bottomInset : 0;
  return inset > 0 ? inset + BOTTOM_GAP_WITH_INSET : BOTTOM_GAP_WITHOUT_INSET;
}
