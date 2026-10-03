// Unified-diff parser for the Changes panel (P3-g).

export interface DiffLine {
  kind: "hunk" | "context" | "add" | "del";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface ParsedDiff {
  lines: DiffLine[];
  isNew: boolean;
  isDeleted: boolean;
  elided: boolean;
  additions: number;
  deletions: number;
}

const ELIDED = /^\[… \d+ bytes elided\]$/;

export function parseDiff(diff: string): ParsedDiff {
  const out: ParsedDiff = { lines: [], isNew: false, isDeleted: false, elided: false, additions: 0, deletions: 0 };
  const raw = diff.split("\n");
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    if (ELIDED.test(line)) {
      out.elided = true;
      break;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      inHunk = true;
      out.lines.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
    } else if (line.startsWith("diff --git")) {
      inHunk = false;
    } else if (!inHunk) {
      if (line.startsWith("new file mode") || line === "--- /dev/null") out.isNew = true;
      if (line.startsWith("deleted file mode") || line === "+++ /dev/null") out.isDeleted = true;
    } else if (line.startsWith("+")) {
      out.additions++;
      out.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      out.deletions++;
      out.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else if (line.startsWith(" ") || (line === "" && i < raw.length - 1)) {
      out.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    }
  }
  return out;
}
