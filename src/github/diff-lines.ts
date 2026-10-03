// Line numbers of a unified patch. A review comment must sit on a line of the new file that the diff
// shows (an added or context line), so the model is given numbered patches and findings are checked against these.

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function commentableLines(patch: string | null | undefined): Set<number> {
  const lines = new Set<number>();
  let n = 0;
  for (const l of (patch ?? "").split("\n")) {
    const hunk = HUNK.exec(l);
    if (hunk) n = Number(hunk[1]);
    else if (l.startsWith("+") || l.startsWith(" ")) lines.add(n++);
  }
  return lines;
}

/** Each added or context line gets its new-file line number; removed lines and hunk headers get none. */
export function numberedPatch(patch: string | null | undefined): string {
  let n = 0;
  return (patch ?? "")
    .split("\n")
    .map((l) => {
      const hunk = HUNK.exec(l);
      if (hunk) {
        n = Number(hunk[1]);
        return l;
      }
      if (l.startsWith("+") || l.startsWith(" ")) return `${String(n++).padStart(5)} ${l}`;
      if (l.startsWith("-")) return `${" ".repeat(5)} ${l}`;
      return l;
    })
    .join("\n");
}
