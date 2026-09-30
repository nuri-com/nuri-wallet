// No image imports here, so this stays testable under vitest.
/** The letter a name files under: its first letter, accents folded (É → E); "#" otherwise. */
export function initialOf(name: string): string {
  const first = name
    .trim()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .charAt(0)
    .toUpperCase();
  return first >= "A" && first <= "Z" ? first : "#";
}
