// The slice of the Cloudflare container API the sandbox adapter uses (ADR D15, Sandbox SDK 1.0).
// `ctx.container` and `Files` from @cloudflare/sandbox satisfy these structurally; tests use fakes.

export interface ExecOptionsLike {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore" | "combined";
}

export interface ExecProcessLike {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  /** 137 when the process was killed (an aborted signal kills it). May reject if the container goes away. */
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

export interface ContainerLike {
  readonly running: boolean;
  start(options: { image?: string; enableInternet: boolean }): void;
  destroy(): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
  /** Throws when the container is not running or not ready yet. */
  exec(cmd: string[], options?: ExecOptionsLike): Promise<ExecProcessLike>;
}

/** Errors carry `code` with the Linux errno name (e.g. "ENOENT"), like SandboxFileError. */
export interface FilesLike {
  readFile(path: string): Promise<Response>;
  /** Does not create parent directories (spike finding 1). */
  writeFile(path: string, content: string | Uint8Array | ReadableStream<Uint8Array>): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

export interface CloudflareSandboxOptions {
  container: ContainerLike;
  files: FilesLike;
  /** Image passed to `container.start`. A function is called when the container is started. */
  image?: string | (() => string);
  /** Absolute workspace path inside the container. Default `/workspace`. */
  workdir?: string;
  /** Absolute scratch path inside the container, outside the workspace. Default `/tmp`. */
  tmpDir?: string;
  /** Container idle timeout (ADR D10). Default 15 minutes. */
  inactivityMs?: number;
  /** How long `setup` waits for the container to accept exec. Default 60 s. */
  startTimeoutMs?: number;
}
