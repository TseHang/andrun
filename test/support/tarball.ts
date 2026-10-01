import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A gzipped tarball shaped like GitHub's: one top-level directory (`repo-<sha>/`) holding the repo.
 * `overrides` replaces or adds files, keyed by path relative to the repo root.
 */
export function fixtureTarball(fixtureDir: string, overrides: Record<string, string> = {}): Uint8Array {
  const tmp = mkdtempSync(join(tmpdir(), "andrun-tarball-"));
  try {
    const top = "repo-0df6f53";
    cpSync(fixtureDir, join(tmp, top), { recursive: true });
    for (const [path, content] of Object.entries(overrides)) {
      mkdirSync(dirname(join(tmp, top, path)), { recursive: true });
      writeFileSync(join(tmp, top, path), content);
    }
    execFileSync("tar", ["-czf", "repo.tgz", top], { cwd: tmp });
    return new Uint8Array(readFileSync(join(tmp, "repo.tgz")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
