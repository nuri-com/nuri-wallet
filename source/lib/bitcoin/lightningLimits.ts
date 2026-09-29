// The bounds a Lightning send is held to, and which side each comes from.
//
// Two parties state limits: the corridor (a fixed band the solver's card
// publishes) and the recipient's own LNURL pay request. An amount has to
// satisfy BOTH, so the floor is the higher of the two and the ceiling is the
// lower — the same rule in both directions, applied in one place so the keypad,
// the CTA and the confirm path cannot disagree about it.

export type LightningBounds = { minSats: number; maxSats: number };

export function resolveLightningBounds(input: {
  /** The corridor's own band. */
  corridorMinSats: number;
  corridorMaxSats: number;
  /** The recipient's, when it stated one. LNURL only — a BOLT11 states an amount, not a band. */
  providerMinSats?: number | null;
  providerMaxSats?: number | null;
}): LightningBounds {
  const providerMin = Number(input.providerMinSats);
  const providerMax = Number(input.providerMaxSats);
  return {
    minSats:
      Number.isFinite(providerMin) && providerMin > 0
        ? Math.max(providerMin, input.corridorMinSats)
        : input.corridorMinSats,
    maxSats:
      Number.isFinite(providerMax) && providerMax > 0
        ? Math.min(providerMax, input.corridorMaxSats)
        : input.corridorMaxSats,
  };
}
