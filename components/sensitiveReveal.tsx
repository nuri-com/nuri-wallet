// Reusable "reveal a masked sensitive value" state — tracks which named fields
// are currently revealed (vs masked) in card-details modals. The row visuals
// live in the consuming DS surface.
import { useCallback, useState } from "react";

/** Tracks which named fields are currently revealed (vs masked). */
export function useReveal() {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const toggle = useCallback((field: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }, []);

  const reset = useCallback(() => setRevealed(new Set()), []);
  const isRevealed = useCallback((field: string) => revealed.has(field), [revealed]);

  return { isRevealed, toggle, reset };
}
