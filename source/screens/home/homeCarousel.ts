export function homeCarouselEligibleKey<T extends string>(
  keys: readonly T[],
  selectedKey: T | null,
): T | null {
  return selectedKey && keys.includes(selectedKey) ? selectedKey : null;
}

export const ungroupedCount = (value: number): string =>
  String(Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)));

export function sortByHomeValueDescending<T extends { homeValue: number | null }>(
  items: readonly T[],
): T[] {
  return sortByValueDescending(items, (item) => item.homeValue);
}

/**
 * Largest first (#1728). `amountOf` must give every item in ONE unit, the
 * display currency: raw sats and euros are not comparable. An unknown value
 * (no price yet) goes last; ties and unknowns keep their given order.
 */
export function sortByValueDescending<T>(
  items: readonly T[],
  amountOf: (item: T) => number | null | undefined,
): T[] {
  return items
    .map((item, index) => ({ item, index, value: amountOf(item) }))
    .sort((a, b) => {
      const aValue = a.value == null || !Number.isFinite(a.value) ? null : a.value;
      const bValue = b.value == null || !Number.isFinite(b.value) ? null : b.value;
      if (aValue === null && bValue === null) return a.index - b.index;
      if (aValue === null) return 1;
      if (bValue === null) return -1;
      return bValue - aValue || a.index - b.index;
    })
    .map(({ item }) => item);
}
