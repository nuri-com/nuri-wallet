// Timing of the move pill's compact ("island") state.
//
// Compact, the pill IS the DS IconButton — the same 48² circle as the close
// button, drawn by the DS itself — so it is round and centred by construction.
// The full pill and the circle cross-fade and scale into each other.

/** DS IconButton: one fixed 48² circle (size leaf `lg`). */
export const COMPACT_PILL_SIZE = 48;

/** A running move folds to its icon after this long on screen. */
export const COMPACT_AFTER_MS = 8000;
/** Duration of the full <-> compact change, both ways. */
export const PILL_MORPH_MS = 350;

/**
 * How far the full pill scales down while it fades into the circle: to the
 * circle's height, so the two meet at the same size mid-morph.
 */
export const fullPillScaleAtCompact = (fullHeight: number): number =>
  fullHeight > 0 ? Math.min(1, COMPACT_PILL_SIZE / fullHeight) : 1;
