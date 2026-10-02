import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ContainerLike, ExecOptionsLike, ExecProcessLike, FilesLike } from "../../src/sandbox/container";

class FileError extends Error {
  readonly name = "SandboxFileError";
  constructor(
    readonly code: string,
    readonly operation: string,
    readonly path: string,
  ) {
    super(`${operation} ${path}: ${code}`);
  }
}

const fileError = (e: unknown, operation: string, path: string) =>
  new FileError((e as NodeJS.ErrnoException).code ?? "UNKNOWN", operation, path);

/**
 * Stands in for `ctx.container`: argv runs with child_process on the host, inside a temp dir.
 * It mirrors what the spike measured: exec throws while the container is not running, an aborted
 * exec exits 137, and a destroyed container comes back with an empty filesystem.
 */
export class FakeContainer implements ContainerLike {
  running = false;
  /** Use these as the adapter's `workdir` and `tmpDir`. */
  readonly root = mkdtempSync(join(tmpdir(), "andrun-fake-container-"));
  readonly workdir = join(this.root, "workspace");
  readonly tmpDir = join(this.root, "tmp");

  readonly starts: { image?: string; enableInternet: boolean }[] = [];
  readonly calls: { argv: string[]; options?: ExecOptionsLike }[] = [];
  /** Order of lifecycle calls, to check sequencing. */
  readonly log: string[] = [];
  destroyed = 0;
  inactivityMs: number | undefined;
  /** exec throws "not ready" for this long after start(). */
  startDelayMs = 0;
  /** exec never succeeds after start(). */
  neverReady = false;
  /** start() is accepted but the container never runs; monitor() rejects with this (seen on the deployed Worker). */
  failStart: string | null = null;
  /** The most execs that were ever running at once. */
  maxConcurrent = 0;

  private readyAt = 0;
  private exit: Promise<void> = Promise.resolve();
  private exited: () => void = () => {};
  private readonly children = new Set<ChildProcess>();

  start(options: { image?: string; enableInternet: boolean }): void {
    this.starts.push(options);
    this.exit = new Promise<void>((resolve) => (this.exited = resolve));
    if (this.failStart !== null) return; // accepted, but it never runs
    this.running = true;
    this.readyAt = Date.now() + this.startDelayMs;
    mkdirSync(this.tmpDir, { recursive: true });
  }

  async destroy(): Promise<void> {
    this.destroyed++;
    this.running = false;
    this.exited();
    for (const child of this.children) kill(child);
    for (const entry of readdirSync(this.root)) rmSync(join(this.root, entry), { recursive: true, force: true });
  }

  /** Resolves when the container exits; rejects when it failed to start. */
  monitor(): Promise<void> {
    this.log.push("monitor");
    if (this.failStart !== null) return Promise.reject(new Error(this.failStart));
    return this.exit;
  }

  async setInactivityTimeout(durationMs: number): Promise<void> {
    this.log.push("setInactivityTimeout");
    this.inactivityMs = durationMs;
  }

  async exec(argv: string[], options: ExecOptionsLike = {}): Promise<ExecProcessLike> {
    this.calls.push({ argv, options });
    this.log.push(`exec:${argv[0]}`);
    if (!this.running) throw new Error("cannot exec in a container that is not running");
    if (this.neverReady || Date.now() < this.readyAt) throw new Error("container is not ready");

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.add(child);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.children.size);

    const exitCode = new Promise<number>((resolve) => {
      child.on("error", () => resolve(127));
      // On exit, not on close: a background child may keep the pipes open after the command is done.
      child.on("exit", (code, signal) => {
        this.children.delete(child);
        resolve(signal ? 137 : (code ?? 1));
      });
    });
    const onAbort = () => kill(child);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const web = (stream: Readable | null, mode: string | undefined) => {
      if (mode === "pipe" && stream) return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
      stream?.resume();
      return null;
    };
    return {
      stdout: web(child.stdout, options.stdout),
      stderr: web(child.stderr, options.stderr),
      exitCode,
      kill: () => kill(child),
    };
  }

  /** Stands in for `new Files(ctx.container)`. Paths are absolute host paths. */
  readonly files: FilesLike = {
    readFile: async (path) => {
      this.assertRunning();
      try {
        return new Response(await readFile(path));
      } catch (e) {
        throw fileError(e, "readFile", path);
      }
    },
    writeFile: async (path, content) => {
      this.assertRunning();
      const bytes =
        typeof content === "string" || content instanceof Uint8Array
          ? content
          : new Uint8Array(await new Response(content).arrayBuffer());
      try {
        await writeFile(path, bytes); // no parent creation, like the real Files (spike finding 1)
      } catch (e) {
        throw fileError(e, "writeFile", path);
      }
    },
    mkdir: async (path, options) => {
      this.assertRunning();
      try {
        await mkdir(path, { recursive: options?.recursive ?? false });
      } catch (e) {
        throw fileError(e, "mkdir", path);
      }
    },
    remove: async (path, options) => {
      this.assertRunning();
      try {
        await rm(path, { recursive: options?.recursive ?? false, force: options?.force ?? false });
      } catch (e) {
        throw fileError(e, "remove", path);
      }
    },
  };

  /** Removes the temp dir. Call from afterEach. */
  async cleanup(): Promise<void> {
    for (const child of this.children) kill(child);
    rmSync(this.root, { recursive: true, force: true });
  }

  private assertRunning(): void {
    if (!this.running) throw new Error("cannot exec in a container that is not running");
  }
}

function kill(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}
