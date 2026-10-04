// Tool specs and execution for the agent loop. Platform-free (ADR D1): all I/O goes through SandboxAdapter.

import { TOOL_OUTPUT_CAP, capToolOutput } from "./context";
import { pathsInPatch } from "./diff";
import { SandboxLostError, type Finding, type SandboxAdapter, type ToolName, type ToolSpec } from "./types";

export const MAX_FILE_BYTES = 1_000_000;

const str = (description: string) => ({ type: "string", description });
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
});

const SPECS: Record<ToolName, ToolSpec> = {
  list_files: {
    name: "list_files",
    description: "List files (recursive) under a directory of the repo. Defaults to the repo root.",
    parameters: schema({ path: str("Directory relative to the repo root; omit for the root.") }, []),
  },
  read_file: {
    name: "read_file",
    description: "Read a file and return its contents.",
    parameters: schema({ path: str("File path relative to the repo root.") }, ["path"]),
  },
  write_file: {
    name: "write_file",
    description: "Create or overwrite a whole file. Max 1 MB. Prefer apply_patch for small edits to existing files.",
    parameters: schema(
      { path: str("File path relative to the repo root."), content: str("Full new file content.") },
      ["path", "content"],
    ),
  },
  apply_patch: {
    name: "apply_patch",
    description: "Apply a unified diff (git format) to the repo. Fails if the context lines do not match.",
    parameters: schema({ patch: str("The unified diff, with ---/+++ headers and @@ hunks.") }, ["patch"]),
  },
  run_command: {
    name: "run_command",
    description:
      "Run a shell command in the repo root (e.g. the tests). Returns the exit code and combined output. A non-zero exit is reported, not an error.",
    parameters: schema({ command: str("Shell command line.") }, ["command"]),
  },
  report_finding: {
    name: "report_finding",
    description: "Record one review finding about a specific line. Call once per issue.",
    parameters: schema(
      {
        path: str("File path relative to the repo root."),
        line: { type: "integer", minimum: 1, description: "1-based line number." },
        severity: { type: "string", enum: ["high", "medium", "low"] },
        text: str("What is wrong and why."),
      },
      ["path", "line", "severity", "text"],
    ),
  },
  finish: {
    name: "finish",
    description: "Call when the task is done. The summary is shown to the human.",
    parameters: schema(
      {
        summary: str("Short summary of what you did or found."),
        title: str("A short pull request title for the change, in the imperative. Code mode only."),
      },
      ["summary"],
    ),
  },
};

export function toolSpecs(names: ToolName[]): ToolSpec[] {
  return names.map((n) => SPECS[n]);
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

export function summarizeCall(name: string, args: unknown): string {
  const a = asRecord(args);
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (name) {
    case "read_file":
      return `Read ${s("path")}`;
    case "run_command":
      return `Run ${s("command")}`;
    case "write_file":
      return `Write ${s("path")}`;
    case "apply_patch": {
      const paths = [...new Set(pathsInPatch(s("patch")).map((p) => p.path).filter(Boolean))];
      if (paths.length === 0) return "Patch";
      return paths.length <= 2 ? `Patch ${paths.join(", ")}` : `Patch ${paths.length} files`;
    }
    case "list_files":
      return `List ${s("path") || "."}`;
    case "report_finding":
      return `Finding ${s("path")}:${String(a.line ?? "")}`;
    case "finish":
      return "Finish";
    default:
      return name;
  }
}

/** Normalizes to a relative POSIX path; throws if it is absolute or escapes the workspace root. */
export function validatePath(path: string): string {
  const fail = () => new Error(`path outside workspace: ${path.replace(/\0/g, "\\0")}`);
  if (path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) throw fail();
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.pop() === undefined) throw fail();
    } else out.push(seg);
  }
  // The baseline repo lives in .git; writing there could hide changes from the approval diff.
  if (out.some((seg) => seg.toLowerCase() === ".git")) throw new Error(`reserved path: ${path} (.git is managed by the sandbox)`);
  return out.length ? out.join("/") : ".";
}

export type ToolResult =
  | {
      ok: true;
      output: string;
      exitCode?: number | null;
      changedPaths?: string[];
      finding?: Omit<Finding, "id">;
      /** Sizes for the UI only (never sent to the model). */
      meta?: { bytes?: number; files?: number };
    }
  | { ok: false; error: string; exitCode?: number | null };

export interface ToolContext {
  sandbox: SandboxAdapter;
  allowed: ToolName[];
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  timeoutMs: number;
  signal?: AbortSignal;
}

const fail = (error: string): ToolResult => ({ ok: false, error });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new InvalidArgs(`"${key}" must be a string`);
  return v;
}

class InvalidArgs extends Error {}

export async function executeTool(call: { name: string; rawArgs: string }, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.allowed.includes(call.name as ToolName)) return fail(`unknown tool: ${call.name}`);
  const name = call.name as ToolName;

  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.rawArgs || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidArgs("expected a JSON object");
    args = parsed as Record<string, unknown>;
  } catch (e) {
    return fail(`invalid arguments: ${e instanceof InvalidArgs ? e.message : message(e)}`);
  }

  try {
    return await run(name, args, ctx);
  } catch (e) {
    if (e instanceof SandboxLostError) throw e;
    if (e instanceof InvalidArgs) return fail(`invalid arguments: ${e.message}`);
    return fail(message(e));
  }
}

async function run(name: ToolName, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { sandbox } = ctx;
  switch (name) {
    case "list_files": {
      const raw = args.path;
      if (raw !== undefined && typeof raw !== "string") throw new InvalidArgs(`"path" must be a string`);
      const dir = raw === undefined ? "." : validatePath(raw);
      const files = await sandbox.listFiles(dir === "." ? undefined : dir);
      const list = files.join("\n");
      const meta = { files: files.length };
      if (list.length <= TOOL_OUTPUT_CAP) return { ok: true, output: list, meta };
      const hint = "\n(list truncated: pass a narrower path to see more)";
      return { ok: true, output: capToolOutput(list, TOOL_OUTPUT_CAP - hint.length) + hint, meta };
    }
    case "read_file": {
      const path = validatePath(reqString(args, "path"));
      const content = await sandbox.readFile(path);
      return { ok: true, output: capToolOutput(content), meta: { bytes: new TextEncoder().encode(content).length } };
    }
    case "write_file": {
      const rawPath = reqString(args, "path");
      const content = reqString(args, "content");
      const path = validatePath(rawPath);
      if (content.length > MAX_FILE_BYTES) return fail("file too large: the limit is 1 MB");
      await sandbox.writeFile(path, content);
      return { ok: true, output: `wrote ${path}`, changedPaths: [path] };
    }
    case "apply_patch": {
      const patch = reqString(args, "patch");
      const paths = pathsInPatch(patch).map((p) => p.path).filter((p) => p !== "" && p !== "/dev/null");
      const changed = paths.map(validatePath);
      // Models often drop the final newline, which git reports as a corrupt patch.
      const r = await sandbox.applyPatch(patch.endsWith("\n") ? patch : `${patch}\n`);
      if (!r.ok) return fail(`patch failed to apply: ${r.stderr}`);
      return { ok: true, output: `patched ${[...new Set(changed)].join(", ")}`, changedPaths: [...new Set(changed)] };
    }
    case "run_command": {
      const command = reqString(args, "command");
      const r = await sandbox.exec(command, { onOutput: ctx.onOutput, timeoutMs: ctx.timeoutMs, signal: ctx.signal });
      if (r.timedOut) return { ok: false, error: `command timed out after ${Math.round(ctx.timeoutMs / 1000)}s`, exitCode: null };
      return {
        ok: true,
        exitCode: r.exitCode,
        output: capToolOutput(`exit code ${r.exitCode}\n${r.stdout}${r.stderr}`),
      };
    }
    case "report_finding": {
      const path = validatePath(reqString(args, "path"));
      const text = reqString(args, "text");
      const { line, severity } = args;
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
        throw new InvalidArgs(`"line" must be a positive integer`);
      }
      if (severity !== "high" && severity !== "medium" && severity !== "low") {
        throw new InvalidArgs(`"severity" must be high, medium or low`);
      }
      return { ok: true, output: "finding recorded", finding: { path, line, severity, text } };
    }
    case "finish":
      return { ok: true, output: reqString(args, "summary") };
  }
}
