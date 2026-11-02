// The browser chrome around the app (Safari's status-bar strip and toolbar
// tint, the installed PWA's safe-area bands) takes its color from the page:
// the theme-color meta tag and the document background. A full-bleed screen in
// another color (the lilac landing) tints them to match while it shows, and
// puts the canvas color back when it goes.
//
// The document is injected so the rule is testable without a browser.

type TintDocument = {
  documentElement: { style: { backgroundColor: string } };
  body: { style: { backgroundColor: string } } | null;
  querySelector(selector: string): {
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  } | null;
};

/** Tints the page to `color`; the returned function restores what was there. */
export function tintPage(doc: TintDocument | undefined, color: string): () => void {
  if (!doc) return () => {};
  const meta = doc.querySelector('meta[name="theme-color"]');
  const previousMeta = meta?.getAttribute("content") ?? null;
  const previousHtml = doc.documentElement.style.backgroundColor;
  const previousBody = doc.body?.style.backgroundColor ?? "";
  meta?.setAttribute("content", color);
  doc.documentElement.style.backgroundColor = color;
  if (doc.body) doc.body.style.backgroundColor = color;
  return () => {
    if (meta && previousMeta !== null) meta.setAttribute("content", previousMeta);
    doc.documentElement.style.backgroundColor = previousHtml;
    if (doc.body) doc.body.style.backgroundColor = previousBody;
  };
}
