/**
 * Strip ANSI escape sequences and collapse whitespace into single spaces.
 */
export function compactWhitespace(text: string): string {
  return (
    String(text ?? "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
      .replace(/\u001b\[[0-9:;?]*[ -/]*[@-~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}
