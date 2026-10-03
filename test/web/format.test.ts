import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changeTotals,
  contrastRatio,
  formatBytes,
  formatCost,
  formatDuration,
  formatTokens,
  isTestPath,
  modelLabel,
  relativeTime,
} from "../../web/src/state/format";

describe("formatters", () => {
  it("numbers, times and labels", () => {
    expect(formatBytes(214)).toBe("214 B");
    expect(formatBytes(5000)).toBe("5.0 kB");
    expect(formatBytes(1_250_000)).toBe("1.3 MB");
    expect(formatDuration(100)).toBe("0.1 s");
    expect(formatDuration(10_450)).toBe("10.5 s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatTokens(1812)).toBe("1.8k");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(262_144)).toBe("262k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatCost(0.1149)).toBe("¥0.11");
    expect(modelLabel("deepseek-ai/deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(modelLabel("scripted")).toBe("scripted");

    const now = 10 * 3600_000;
    expect(relativeTime(now - 20_000, now)).toBe("now");
    expect(relativeTime(now - 60_000, now)).toBe("1m");
    expect(relativeTime(now - 3600_000, now)).toBe("1h");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d");
  });

  it("test paths (P3-i) and totals", () => {
    for (const p of ["test/empty.test.js", "tests/a.py", "src/__tests__/x.ts", "a/b.spec.tsx", "c.test.mjs", "pkg/test/x.go"]) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ["src/sum.js", "src/testing.js", "contest/a.js", "latest.js", "coverage/out.json"]) {
      expect(isTestPath(p), p).toBe(false);
    }
    expect(
      changeTotals([
        { path: "a", additions: 1, deletions: 1, diff: "x" },
        { path: "b", additions: 7, deletions: 0, diff: "y" },
        { path: "c", additions: 2, deletions: 0, diff: null },
      ]),
    ).toEqual({ files: 3, additions: 10, deletions: 1 });
  });

  it("token contrast", () => {
    // The colors are the Tailwind theme tokens in web/src/styles.css (`@theme { --color-…: #rrggbb; }`).
    const css = readFileSync(join(import.meta.dirname, "../../web/src/styles.css"), "utf8");
    const token = (name: string) => {
      const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css);
      if (!m) throw new Error(`no --color-${name} in styles.css`);
      return m[1]!;
    };
    const white = "#ffffff";
    expect(contrastRatio(token("accent-text"), white)).toBeGreaterThanOrEqual(4.5); // accent text on white
    expect(contrastRatio(white, token("accent"))).toBeGreaterThanOrEqual(4.5); // white on the accent fill
    for (const name of ["text", "text-secondary", "failed", "done-text"]) {
      expect(contrastRatio(token(name), white), name).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});
