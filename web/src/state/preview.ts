/** Inline local classic scripts; the resulting page still runs in an isolated iframe. */
export async function inlinePreviewScripts(html: string, path: string, loadFile: (path: string) => Promise<string | null>): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = new URL(path, "https://preview.invalid/");
  for (const script of doc.querySelectorAll<HTMLScriptElement>("script[src]")) {
    if (script.type && script.type !== "text/javascript" && script.type !== "application/javascript") continue;
    const url = new URL(script.getAttribute("src")!, base);
    if (url.origin !== base.origin || !/\.js$/i.test(url.pathname)) continue;
    const source = await loadFile(decodeURIComponent(url.pathname.slice(1))).catch(() => null);
    if (source === null) continue;
    script.removeAttribute("src");
    script.textContent = source.replace(/<\/script/gi, "<\\/script");
  }
  return `${doc.doctype ? "<!doctype html>\n" : ""}${doc.documentElement.outerHTML}`;
}
