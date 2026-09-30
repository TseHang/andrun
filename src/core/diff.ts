// Unified-diff helpers (git style or plain `---`/`+++`). Pure string parsing.

import type { DiffSummary } from "./events";

interface ParsedFile {
  oldPath: string | null; // null = /dev/null
  newPath: string | null;
  additions: number;
  deletions: number;
  deletedMode: boolean;
  fallbackPath: string;
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

function headerPath(raw: string): string | null {
  const p = (raw.split("\t")[0] ?? "").trim();
  if (p === "/dev/null") return null;
  return p.replace(/^"?[ab]\//, "").replace(/"$/, "");
}

function parse(diff: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let cur: ParsedFile | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const fresh = (fallbackPath: string): ParsedFile => {
    const f: ParsedFile = { oldPath: null, newPath: null, additions: 0, deletions: 0, deletedMode: false, fallbackPath };
    files.push(f);
    return f;
  };
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === "+") { cur!.additions++; newLeft--; continue; }
      if (c === "-") { cur!.deletions++; oldLeft--; continue; }
      if (c === " " || line === "") { oldLeft--; newLeft--; continue; }
      if (c === "\\") continue;
      oldLeft = newLeft = 0;
    }
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = fresh(m?.[2] ?? "");
    } else if (line.startsWith("deleted file mode")) {
      if (cur) cur.deletedMode = true;
    } else if (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      // A plain diff has no `diff --git` line; start a file unless the current one has no headers yet.
      if (!cur || cur.oldPath !== null || cur.newPath !== null || cur.additions || cur.deletions) cur = fresh("");
      cur.oldPath = headerPath(line.slice(4));
      cur.newPath = headerPath(lines[i + 1]!.slice(4));
      i++;
    } else {
      const h = HUNK.exec(line);
      if (h && cur) {
        oldLeft = h[1] === undefined ? 1 : Number(h[1]);
        newLeft = h[2] === undefined ? 1 : Number(h[2]);
      }
    }
  }
  return files;
}

export function summarizeDiff(diff: string): DiffSummary {
  return {
    files: parse(diff).map((f) => ({
      path: f.newPath ?? f.oldPath ?? f.fallbackPath,
      additions: f.additions,
      deletions: f.deletions,
    })),
  };
}

export function pathsInPatch(patch: string): { path: string; deleted: boolean; created: boolean }[] {
  return parse(patch).map((f) => ({
    path: f.newPath ?? f.oldPath ?? f.fallbackPath,
    deleted: f.deletedMode || (f.newPath === null && f.oldPath !== null),
    created: f.oldPath === null && f.newPath !== null,
  }));
}
