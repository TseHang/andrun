// The agent's workspace on a Cloudflare container (ADR D10, D11, D15; spike-sandbox-1.0.md).
// Runs inside a Durable Object: web-standard APIs only. The container and Files arrive via options.

import { SandboxLostError, type ExecOptions, type ExecResult } from "../core/types";
import type { ChangedFile, SandboxHost } from "../session/ports";
import type { CloudflareSandboxOptions, ContainerLike, ExecProcessLike, FilesLike } from "./container";

const GIT_IDENTITY = ["-c", "user.email=agent@andrun.local", "-c", "user.name=andrun", "-c", "commit.gpgsign=false"];
const ZERO_SHA = /^0+$/;
const READY_POLL_MS = 250;
const DRAIN_GRACE_MS = 1000;

interface RunResult extends ExecResult {
  /** True when this adapter aborted the process (timeout or caller abort). */
  aborted: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CloudflareSandboxAdapter implements SandboxHost {
  private readonly container: ContainerLike;
  private readonly files: FilesLike;
  private readonly image: CloudflareSandboxOptions["image"];
  private readonly workdir: string;
  private readonly tmpDir: string;
  private readonly inactivityMs: number;
  private readonly startTimeoutMs: number;
  private baseline: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: CloudflareSandboxOptions) {
    this.container = options.container;
    this.files = options.files;
    this.image = options.image;
    this.workdir = options.workdir ?? "/workspace";
    this.tmpDir = options.tmpDir ?? "/tmp";
    this.inactivityMs = options.inactivityMs ?? 15 * 60_000;
    this.startTimeoutMs = options.startTimeoutMs ?? 60_000;
  }

  isRunning(): boolean {
    return this.container.running;
  }

  // ---------- queue and loss detection ----------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }

  private lost(what: string): SandboxLostError {
    return new SandboxLostError(`the sandbox stopped while running: ${what}`);
  }

  private assertRunning(what: string): void {
    if (!this.container.running) throw new SandboxLostError(`the sandbox is not running (${what})`);
  }

  /** Runs a container or files call; any failure while the container is gone becomes SandboxLostError. */
  private async guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
    this.assertRunning(what);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SandboxLostError) throw e;
      if (!this.container.running) throw this.lost(what);
      throw e;
    }
  }

  // ---------- process runner ----------

  private async run(
    argv: string[],
    what: string,
    opts: ExecOptions = {},
  ): Promise<RunResult> {
    this.assertRunning(what);
    const controller = new AbortController();
    let aborted = false;
    const abort = () => {
      aborted = true;
      controller.abort();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => abort();
    try {
      if (opts.timeoutMs !== undefined) timer = setTimeout(abort, opts.timeoutMs);
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });

      let proc: ExecProcessLike;
      try {
        proc = await this.container.exec(argv, {
          cwd: this.workdir,
          stdout: "pipe",
          stderr: "pipe",
          signal: controller.signal,
        });
      } catch (e) {
        if (!this.container.running) throw this.lost(what);
        // An exec that was aborted before it started is a timeout too, not an error.
        if (aborted) return { exitCode: null, timedOut: true, stdout: "", stderr: "", aborted };
        throw e;
      }

      let stdout = "";
      let stderr = "";
      const pump = async (stream: ReadableStream<Uint8Array> | null, name: "stdout" | "stderr") => {
        if (!stream) return;
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        const emit = (text: string) => {
          if (!text) return;
          if (name === "stdout") stdout += text;
          else stderr += text;
          opts.onOutput?.(name, text);
        };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            emit(decoder.decode(value, { stream: true }));
          }
          emit(decoder.decode());
        } catch {
          // a stream that errors (container gone, process killed) just ends
        }
      };
      const pumps = Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);

      let exitCode: number | null = null;
      let exitError: unknown;
      try {
        exitCode = await proc.exitCode;
      } catch (e) {
        exitError = e;
      }
      // Streams normally end with the process; do not hang on one that does not.
      await Promise.race([pumps, sleep(aborted || exitError ? DRAIN_GRACE_MS : 30_000)]);

      if (aborted) return { exitCode: null, timedOut: true, stdout, stderr, aborted };
      if (!this.container.running) throw this.lost(what);
      if (exitError) throw exitError instanceof Error ? exitError : new Error(String(exitError));
      return { exitCode, timedOut: false, stdout, stderr, aborted };
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Internal git: argv array, no shell. */
  private git(args: string[], what = `git ${args[0]}`, opts?: ExecOptions): Promise<RunResult> {
    return this.run(["git", ...GIT_IDENTITY, ...args], what, opts);
  }

  private async gitOk(args: string[], step: string): Promise<string> {
    const r = await this.git(args, step);
    if (r.exitCode !== 0) throw new Error(`${step} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  private resolvePath(path: string): string {
    const parts: string[] = [];
    for (const seg of `${this.workdir}/${path}`.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    const full = `/${parts.join("/")}`;
    const root = `/${this.workdir.split("/").filter(Boolean).join("/")}`;
    if (full !== root && !full.startsWith(`${root}/`)) throw new Error(`EACCES: path outside workspace: ${path}`);
    return full;
  }

  private async getBaseline(): Promise<string> {
    if (this.baseline) return this.baseline;
    const out = await this.gitOk(["rev-list", "--max-parents=0", "HEAD"], "git rev-list");
    const sha = out.trim().split("\n").pop()?.trim() ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`git rev-list failed: no baseline commit found`);
    this.baseline = sha;
    return sha;
  }

  // ---------- lifecycle ----------

  setup(tarball: ReadableStream<Uint8Array>): Promise<{ readyMs: number }> {
    return this.enqueue(async () => {
      const t0 = Date.now();
      this.baseline = undefined;
      const started = !this.container.running;
      if (started) {
        const image = typeof this.image === "function" ? this.image() : this.image;
        this.container.start({ ...(image !== undefined ? { image } : {}), enableInternet: false });
      }
      await this.waitUntilReady(t0);
      const readyMs = Date.now() - t0;
      // Set once the container answers: right after start() the platform may not know it yet.
      if (started) await this.guard("set idle timeout", () => this.container.setInactivityTimeout(this.inactivityMs));

      const tarFile = `${this.tmpDir}/andrun-${crypto.randomUUID()}.tar.gz`;
      await this.guard("mkdir", () => this.files.mkdir(this.workdir, { recursive: true }));
      await this.guard("mkdir", () => this.files.mkdir(this.tmpDir, { recursive: true }));
      await this.guard("write tarball", () => this.files.writeFile(tarFile, tarball));
      const tar = await this.run(["tar", "-xzf", tarFile, "-C", this.workdir, "--strip-components=1"], "tar");
      await this.guard("remove tarball", () => this.files.remove(tarFile, { force: true }));
      if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.trim()}`);

      await this.gitOk(["init", "-q"], "git init");
      await this.gitOk(["add", "-A"], "git add");
      await this.gitOk(["commit", "-q", "-m", "baseline"], "git commit");
      const head = (await this.gitOk(["rev-parse", "HEAD"], "git rev-parse")).trim();
      if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`git rev-parse failed: unexpected output '${head}'`);
      this.baseline = head;
      return { readyMs };
    });
  }

  private async waitUntilReady(t0: number): Promise<void> {
    const deadline = t0 + this.startTimeoutMs;
    let last = "the readiness probe failed";
    for (;;) {
      try {
        const proc = await this.container.exec(["true"], { stdout: "ignore", stderr: "ignore" });
        const code = await proc.exitCode;
        if (code === 0) return;
        last = `the readiness probe exited with ${code}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e); // not ready yet; kept for the timeout message
      }
      if (Date.now() + READY_POLL_MS > deadline) {
        throw new SandboxLostError(`the sandbox did not become ready within ${Math.round(this.startTimeoutMs / 1000)}s: ${last}`);
      }
      await sleep(READY_POLL_MS);
    }
  }

  async destroy(): Promise<void> {
    await this.container.destroy();
    this.baseline = undefined;
  }

  // ---------- SandboxAdapter ----------

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return this.enqueue(async () => {
      const r = await this.run(["sh", "-lc", command], command, opts);
      return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdout, stderr: r.stderr };
    });
  }

  readFile(path: string): Promise<string> {
    return this.enqueue(async () => {
      const full = this.resolvePath(path);
      try {
        return await (await this.guard(`read ${path}`, () => this.files.readFile(full))).text();
      } catch (e) {
        throw this.fileError(e, path);
      }
    });
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.enqueue(async () => {
      const full = this.resolvePath(path);
      const parent = full.slice(0, full.lastIndexOf("/")) || "/";
      try {
        await this.guard(`write ${path}`, () => this.files.mkdir(parent, { recursive: true }));
        await this.guard(`write ${path}`, () => this.files.writeFile(full, content));
      } catch (e) {
        throw this.fileError(e, path);
      }
    });
  }

  removeFile(path: string): Promise<void> {
    return this.enqueue(async () => {
      const full = this.resolvePath(path);
      try {
        await this.guard(`remove ${path}`, () => this.files.remove(full, { force: true }));
      } catch (e) {
        if ((e as { code?: unknown }).code === "ENOENT") return;
        throw this.fileError(e, path);
      }
    });
  }

  private fileError(e: unknown, path: string): Error {
    if (e instanceof SandboxLostError) return e;
    const err = e as { code?: unknown; message?: unknown };
    if (typeof err.message === "string" && /^[A-Z]+: /.test(err.message) && err.code === undefined) return e as Error;
    const code = typeof err.code === "string" ? err.code : "EIO";
    const reason = code === "ENOENT" ? "no such file or directory" : typeof err.message === "string" ? err.message : "i/o error";
    return new Error(`${code}: ${reason}, open '${path}'`);
  }

  listFiles(dir?: string): Promise<string[]> {
    return this.enqueue(async () => {
      const args = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
      if (dir) args.push("--", dir);
      const listed = await this.gitOk(args, "git ls-files");
      const deleted = new Set((await this.gitOk(["ls-files", "--deleted", "-z"], "git ls-files")).split("\0").filter(Boolean));
      return [...new Set(listed.split("\0").filter((f) => f && !deleted.has(f)))].sort();
    });
  }

  applyPatch(patch: string): Promise<{ ok: boolean; stderr: string }> {
    return this.enqueue(async () => {
      const file = `${this.tmpDir}/andrun-${crypto.randomUUID()}.patch`;
      await this.guard("write patch", () => this.files.writeFile(file, patch));
      try {
        const r = await this.git(["apply", "--recount", "--whitespace=nowarn", file], "git apply");
        return { ok: r.exitCode === 0, stderr: r.stderr };
      } finally {
        await this.files.remove(file, { force: true }).catch(() => {});
      }
    });
  }

  diff(path?: string): Promise<string> {
    return this.enqueue(async () => {
      const baseline = await this.getBaseline();
      await this.gitOk(["add", "-A"], "git add");
      const args = ["diff", "--cached", baseline];
      if (path) args.push("--", path);
      return (await this.git(args)).stdout;
    });
  }

  changedFiles(): Promise<ChangedFile[]> {
    return this.enqueue(async () => {
      const baseline = await this.getBaseline();
      await this.gitOk(["add", "-A"], "git add");
      const raw = await this.gitOk(["diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z", baseline], "git diff");
      const tokens = raw.split("\0");
      const out: ChangedFile[] = [];
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        const meta = tokens[i]!.match(/^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) (\w)/);
        const path = tokens[i + 1]!;
        if (!meta || !path) continue;
        const [, before, after, letter] = meta;
        out.push({
          path,
          status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified",
          beforeSha: ZERO_SHA.test(before!) ? null : before!,
          afterSha: ZERO_SHA.test(after!) ? null : after!,
        });
      }
      return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    });
  }
}
