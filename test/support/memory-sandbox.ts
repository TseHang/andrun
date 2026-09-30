import type { ExecOptions, ExecResult, SandboxAdapter } from "../../src/core/types";

export type ExecHandler = (command: string, files: Map<string, string>) => Partial<ExecResult>;

/** In-memory workspace for fast unit tests. Snapshot/clone support lets tests resume from a checkpoint. */
export class MemorySandbox implements SandboxAdapter {
  readonly files: Map<string, string>;
  readonly baseline: Map<string, string>;
  readonly commands: string[] = [];

  constructor(
    files: Record<string, string> | Map<string, string> = {},
    private readonly handler: ExecHandler = () => ({ exitCode: 0 }),
    baseline?: Map<string, string>,
  ) {
    this.files = new Map(files instanceof Map ? files : Object.entries(files));
    this.baseline = new Map(baseline ?? this.files);
  }

  clone(): MemorySandbox {
    return new MemorySandbox(new Map(this.files), this.handler, this.baseline);
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command);
    const r = this.handler(command, this.files);
    const result: ExecResult = {
      exitCode: r.exitCode === undefined ? 0 : r.exitCode,
      timedOut: r.timedOut ?? false,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
    if (result.stdout) opts?.onOutput?.("stdout", result.stdout);
    if (result.stderr) opts?.onOutput?.("stderr", result.stderr);
    return result;
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async listFiles(dir?: string): Promise<string[]> {
    const prefix = dir && dir !== "." ? `${dir.replace(/\/$/, "")}/` : "";
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  async applyPatch(): Promise<{ ok: boolean; stderr: string }> {
    return { ok: false, stderr: "MemorySandbox does not apply patches" };
  }

  async diff(path?: string): Promise<string> {
    const paths = new Set([...this.files.keys(), ...this.baseline.keys()]);
    const out: string[] = [];
    for (const p of [...paths].sort()) {
      if (path && p !== path) continue;
      const before = this.baseline.get(p);
      const after = this.files.get(p);
      if (before === after) continue;
      out.push(`diff --git a/${p} b/${p}`, `--- ${before === undefined ? "/dev/null" : `a/${p}`}`, `+++ b/${p}`, "@@");
      for (const l of (before ?? "").split("\n").filter(Boolean)) out.push(`-${l}`);
      for (const l of (after ?? "").split("\n").filter(Boolean)) out.push(`+${l}`);
    }
    return out.length ? `${out.join("\n")}\n` : "";
  }
}
