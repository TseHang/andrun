// Eval sandbox: a tmp dir + child_process, no isolation (ADR D12). Trusted fixtures only.

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import type { ExecOptions, ExecResult, SandboxAdapter } from "../src/core/types";

const GIT = ["-c", "user.email=eval@andrun.local", "-c", "user.name=eval", "-c", "commit.gpgsign=false"];

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], stdin?: string): Promise<GitResult> {
  return new Promise((res, rej) => {
    const child = spawn("git", [...GIT, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", rej);
    child.on("close", (code) => res({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

export class LocalSandbox implements SandboxAdapter {
  /** @param baseline the fixture commit; diffs are taken against it, since the agent may move HEAD. */
  private constructor(
    readonly root: string,
    readonly baseline: string,
  ) {}

  static async fromFixture(fixtureDir: string): Promise<LocalSandbox> {
    const root = await mkdtemp(join(tmpdir(), "andrun-eval-"));
    try {
      await cp(fixtureDir, root, { recursive: true });
      for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "baseline"]]) {
        const r = await git(root, args);
        if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
      }
      const head = await git(root, ["rev-parse", "HEAD"]);
      const baseline = head.stdout.trim();
      if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(baseline)) throw new Error(`git rev-parse failed: ${head.stderr}`);
      return new LocalSandbox(root, baseline);
    } catch (e) {
      await rm(root, { recursive: true, force: true });
      throw e;
    }
  }

  private resolvePath(path: string): string {
    const full = resolve(this.root, path);
    const rel = relative(this.root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`EACCES: path outside workspace: ${path}`);
    return full;
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((res) => {
      const child = spawn("sh", ["-c", command], { cwd: this.root, detached: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let done = false;
      let timer: NodeJS.Timeout | undefined;

      const killGroup = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      };
      const finish = (exitCode: number | null) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        res({ exitCode, timedOut, stdout, stderr });
      };
      const stop = () => {
        timedOut = true;
        killGroup();
        finish(null);
      };
      const onAbort = () => stop();

      child.stdout.on("data", (d: Buffer) => {
        const s = d.toString();
        stdout += s;
        opts.onOutput?.("stdout", s);
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        stderr += s;
        opts.onOutput?.("stderr", s);
      });
      child.on("error", (e) => {
        stderr += e.message;
        finish(null);
      });
      child.on("close", (code) => finish(code));

      if (opts.timeoutMs !== undefined) timer = setTimeout(stop, opts.timeoutMs);
      if (opts.signal?.aborted) stop();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async readFile(path: string): Promise<string> {
    const full = this.resolvePath(path);
    try {
      return await readFile(full, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // Message starts with the errno code, with paths relative to the root.
      throw new Error(`${err.code ?? "EIO"}: ${(err.message ?? "").replace(/^[A-Z]+: /, "").replace(full, path)}`);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const full = this.resolvePath(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  async listFiles(dir?: string): Promise<string[]> {
    const args = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
    if (dir) args.push("--", dir);
    const r = await git(this.root, args);
    if (r.code !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
    const deleted = new Set(
      (await git(this.root, ["ls-files", "--deleted", "-z"])).stdout.split("\0").filter(Boolean),
    );
    return [...new Set(r.stdout.split("\0").filter((f) => f && !deleted.has(f)))].sort();
  }

  async applyPatch(patch: string): Promise<{ ok: boolean; stderr: string }> {
    const r = await git(this.root, ["apply", "--recount", "--whitespace=nowarn", "-"], patch);
    return { ok: r.code === 0, stderr: r.stderr };
  }

  async diff(path?: string): Promise<string> {
    await git(this.root, ["add", "-A"]);
    const args = ["diff", "--cached", this.baseline];
    if (path) args.push("--", path);
    return (await git(this.root, args)).stdout;
  }

  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
