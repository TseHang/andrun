import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CORE = join(import.meta.dirname, "../../src/core");
const NODE_BUILTINS = ["fs", "path", "child_process", "os", "crypto", "http", "https", "stream", "url", "util"];

function coreFiles(dir = CORE): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? coreFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("S13: core is platform-free (D1)", () => {
  it("src/core has no platform imports", () => {
    const files = coreFiles();
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (
          spec.startsWith("cloudflare:") ||
          spec.startsWith("@cloudflare/") ||
          spec.startsWith("node:") ||
          NODE_BUILTINS.includes(spec)
        ) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
