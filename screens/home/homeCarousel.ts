export function homeCarouselEligibleKey<T extends string>(
  keys: readonly T[],
  selectedKey: T | null,
): T | null {
  return selectedKey && keys.includes(selectedKey) ? selectedKey : null;
}

export const ungroupedCount = (value: number): string =>
  String(Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)));

export const ungroupedFiat = (value: number): string =>
  Math.max(0, Number.isFinite(value) ? value : 0).toFixed(2);

export function sortByHomeValueDescending<T extends { homeValueEur: number | null }>(
  items: readonly T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aValue = a.item.homeValueEur;
      const bValue = b.item.homeValueEur;
      if (aValue === null && bValue === null) return a.index - b.index;
      if (aValue === null) return 1;
      if (bValue === null) return -1;
      return bValue - aValue || a.index - b.index;
    })
    .map(({ item }) => item);
}
