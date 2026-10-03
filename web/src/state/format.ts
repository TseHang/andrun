// Small pure formatters for the UI (no DOM).
import type { ChangeView, StepRow } from "./reducer";

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

export function formatCost(yuan: number): string {
  return `¥${yuan.toFixed(2)}`;
}

export function modelLabel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, now - ts) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

export function changeTotals(changes: ChangeView[]): { files: number; additions: number; deletions: number } {
  return {
    files: changes.length,
    additions: changes.reduce((sum, c) => sum + c.additions, 0),
    deletions: changes.reduce((sum, c) => sum + c.deletions, 0),
  };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio of two `#rrggbb` colors. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The muted right-hand text of a step row, e.g. "exit 1 · 1.1 s". */
export function rowSummary(row: StepRow): string {
  if (!row.done) return "";
  const parts: string[] = [];
  if (row.declined) parts.push("declined");
  else if (row.error !== undefined) parts.push("failed");
  else if (row.name === "run_command" && row.exitCode !== undefined) parts.push(row.exitCode === null ? "timed out" : `exit ${row.exitCode}`);
  else if (row.name === "read_file" && row.meta?.bytes !== undefined) parts.push(formatBytes(row.meta.bytes));
  else if (row.name === "list_files" && row.meta?.files !== undefined) parts.push(row.meta.files === 1 ? "1 file" : `${row.meta.files} files`);
  else if (row.additions !== undefined) {
    parts.push(`+${row.additions}${row.deletions ? ` −${row.deletions}` : ""}`);
  }
  if (row.durationMs !== undefined) parts.push(formatDuration(row.durationMs));
  return parts.join(" · ");
}

export function rowTone(row: StepRow): "failed" | "ok" | "muted" {
  if (row.error !== undefined || (row.exitCode !== undefined && row.exitCode !== 0)) return "failed";
  return row.exitCode === 0 ? "ok" : "muted";
}

/** Where a Code session's change goes: `branch → base`, the base left out while it is unknown. */
export function prTarget(branch: string | undefined, id: string, baseBranch: string | null): string {
  const from = branch ?? `agent/${id.slice(0, 8)}-1`;
  return baseBranch ? `${from} → ${baseBranch}` : from;
}
