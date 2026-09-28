// The one set of quick-amount anchors every amount screen offers, in the home
// currency. It had been copy-pasted into each send sheet; a fourth caller (the
// Move sheet, which converts them into the focused side's unit) made that a
// drift risk rather than a coincidence.
//
// They are round numbers to TAP, so they render as whole units — "€ 25", never
// "€25.00".
export const QUICK_AMOUNTS = [25, 50, 100, 200];
