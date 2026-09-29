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
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aValue = a.item.homeValue;
      const bValue = b.item.homeValue;
      if (aValue === null && bValue === null) return a.index - b.index;
      if (aValue === null) return 1;
      if (bValue === null) return -1;
      return bValue - aValue || a.index - b.index;
    })
    .map(({ item }) => item);
}
