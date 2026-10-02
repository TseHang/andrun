import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "../../src/core/tools";
import { SandboxLostError } from "../../src/core/types";
import { CloudflareSandboxAdapter } from "../../src/sandbox/cloudflare-sandbox";
import { FakeContainer } from "../support/fake-container";
import { fixtureTarball, streamOf } from "../support/tarball";

const FIXTURE = join(import.meta.dirname, "../../eval/fixtures/sum-off-by-one");
const TARBALL = fixtureTarball(FIXTURE);
const FILES = ["package.json", "src/sum.js", "test/sum.test.js"];

const FIX_PATCH_WRONG_COUNTS = [
  "--- a/src/sum.js",
  "+++ b/src/sum.js",
  "@@ -1,3 +1,3 @@", // the hunk really spans 6 lines: models get these counts wrong
  " export function sum(values) {",
  "   let total = 0;",
  "-  for (let i = 0; i < values.length - 1; i++) {",
  "+  for (let i = 0; i < values.length; i++) {",
  "     total += values[i];",
  "   }",
  "   return total;",
  "",
].join("\n");

let container: FakeContainer;
let sandbox: CloudflareSandboxAdapter;

const adapter = (over: { startTimeoutMs?: number } = {}) =>
  new CloudflareSandboxAdapter({
    container,
    files: container.files,
    image: "registry.example/sandbox:test",
    workdir: container.workdir,
    tmpDir: container.tmpDir,
    ...over,
  });

beforeEach(() => {
  container = new FakeContainer();
  sandbox = adapter();
});
afterEach(async () => {
  await container.cleanup();
});

const setup = () => sandbox.setup(streamOf(TARBALL));
const AGENT_GIT = "git -c user.email=agent@example.com -c user.name=agent";

describe("S7: setup, exec, files, patch, list and diff behave like LocalSandbox", () => {
  it("starts with egress off, unpacks the tarball and commits a baseline", async () => {
    expect(sandbox.isRunning()).toBe(false);
    const r = await setup();
    expect(r.readyMs).toBeGreaterThanOrEqual(0);
    expect(sandbox.isRunning()).toBe(true);
    expect(container.starts).toEqual([{ image: "registry.example/sandbox:test", enableInternet: false }]);
    expect(container.inactivityMs).toBe(15 * 60_000);
    // --strip-components=1: the tarball's top-level directory is gone.
    expect(await sandbox.listFiles()).toEqual(FILES);
    expect(existsSync(join(container.workdir, "repo-0df6f53"))).toBe(false);
    expect(await sandbox.diff()).toBe("");
    expect(await sandbox.changedFiles()).toEqual([]);
    const head = await sandbox.exec("git rev-parse HEAD");
    expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("waits for a container that is slow to accept exec", async () => {
    container.startDelayMs = 400;
    const r = await setup();
    expect(r.readyMs).toBeGreaterThanOrEqual(400);
    expect(await sandbox.listFiles()).toEqual(FILES);
  });

  it("runs commands in the workspace, streaming output before they finish", async () => {
    await setup();
    const test = await sandbox.exec("npm test");
    expect(test.exitCode).toBe(1);
    expect(test.timedOut).toBe(false);
    expect(test.stdout + test.stderr).toMatch(/fail/i);

    const seen: { at: number; text: string }[] = [];
    const r = await sandbox.exec("echo first; sleep 0.5; echo second; echo oops 1>&2; exit 3", {
      onOutput: (stream, chunk) => seen.push({ at: Date.now(), text: `${stream}:${chunk}` }),
    });
    const done = Date.now();
    expect(r).toMatchObject({ exitCode: 3, timedOut: false });
    expect(r.stdout).toBe("first\nsecond\n");
    expect(r.stderr).toBe("oops\n");
    expect(seen[0]!.text).toBe("stdout:first\n");
    expect(done - seen[0]!.at).toBeGreaterThan(300);
    expect(seen.map((s) => s.text).join("")).toContain("stderr:oops");
  });

  it("writes into directories that do not exist yet, and reads back (finding 1)", async () => {
    await setup();
    await sandbox.writeFile("a/b/c.txt", "x\n");
    expect(await sandbox.readFile("a/b/c.txt")).toBe("x\n");
    await sandbox.writeFile("src/sum.js", "export const sum = () => 0;\n");
    expect(await sandbox.readFile("src/sum.js")).toBe("export const sum = () => 0;\n");
    await expect(sandbox.readFile("missing.js")).rejects.toThrow(/^ENOENT/);
  });

  it("applies patches leniently and reports the ones that do not apply", async () => {
    await setup();
    expect(await sandbox.applyPatch(FIX_PATCH_WRONG_COUNTS)).toEqual({ ok: true, stderr: "" });
    expect(await sandbox.readFile("src/sum.js")).toContain("i < values.length; i++");
    expect((await sandbox.exec("npm test")).exitCode).toBe(0);

    const bad = await sandbox.applyPatch("--- a/src/sum.js\n+++ b/src/sum.js\n@@ -1,1 +1,1 @@\n-not in the file\n+x\n");
    expect(bad.ok).toBe(false);
    expect(bad.stderr.length).toBeGreaterThan(0);
  });

  it("lists files without .git, and diffs against the baseline even after the agent commits", async () => {
    await setup();
    await sandbox.writeFile("src/sum.js", (await sandbox.readFile("src/sum.js")).replace("length - 1", "length"));
    await sandbox.writeFile("notes/new.txt", "hello\n");
    await sandbox.exec("rm test/sum.test.js");

    expect(await sandbox.listFiles()).toEqual(["notes/new.txt", "package.json", "src/sum.js"]);
    expect(await sandbox.listFiles("src")).toEqual(["src/sum.js"]);

    const diff = await sandbox.diff();
    expect(diff).toContain("+  for (let i = 0; i < values.length; i++) {");
    expect(diff).toContain("+hello"); // untracked files are included
    expect(diff).toContain("deleted file mode");
    const one = await sandbox.diff("src/sum.js");
    expect(one).toContain("values.length; i++");
    expect(one).not.toContain("hello");

    // The agent may move HEAD; the diff is still against the baseline.
    const commit = await sandbox.exec(`git add -A && ${AGENT_GIT} commit -qm wip`);
    expect(commit.exitCode).toBe(0);
    expect(await sandbox.diff()).toBe(diff);
  });

  it("reports changed files with blob ids, and removes files", async () => {
    await setup();
    await sandbox.writeFile("src/sum.js", "changed\n");
    await sandbox.writeFile("notes/new.txt", "hello\n");
    await sandbox.removeFile("test/sum.test.js");
    await sandbox.removeFile("never-existed.txt"); // not an error

    const changed = await sandbox.changedFiles();
    expect(changed.map((c) => [c.path, c.status])).toEqual([
      ["notes/new.txt", "added"],
      ["src/sum.js", "modified"],
      ["test/sum.test.js", "deleted"],
    ]);
    const [added, modified, deleted] = changed;
    expect(added!.beforeSha).toBeNull();
    expect(added!.afterSha).toMatch(/^[0-9a-f]{40}$/);
    expect(modified!.beforeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(modified!.afterSha).toMatch(/^[0-9a-f]{40}$/);
    expect(modified!.afterSha).not.toBe(modified!.beforeSha);
    expect(deleted!.beforeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(deleted!.afterSha).toBeNull();
  });

  it("a fresh adapter over a running container still diffs against the baseline", async () => {
    await setup();
    await sandbox.writeFile("src/sum.js", "changed\n");
    await sandbox.exec(`git add -A && ${AGENT_GIT} commit -qm wip`);
    const expected = await sandbox.diff();

    const again = adapter(); // the Durable Object was evicted; the container kept running
    expect(again.isRunning()).toBe(true);
    expect(await again.diff()).toBe(expected);
    expect((await again.changedFiles()).map((c) => c.path)).toEqual(["src/sum.js"]);
  });

  it("runs one operation at a time", async () => {
    await setup();
    container.maxConcurrent = 0;
    const [slow, diff, files] = await Promise.all([sandbox.exec("sleep 0.3; echo done"), sandbox.diff(), sandbox.listFiles()]);
    expect(slow.stdout).toBe("done\n");
    expect(diff).toBe("");
    expect(files).toEqual(FILES);
    expect(container.maxConcurrent).toBe(1);
  });

  it("never passes secrets or other environment into the container", async () => {
    await setup();
    await sandbox.exec("npm test");
    await sandbox.writeFile("a.txt", "a");
    await sandbox.diff();
    await sandbox.applyPatch(FIX_PATCH_WRONG_COUNTS);
    expect(container.calls.length).toBeGreaterThan(5);
    for (const call of container.calls) {
      const keys = Object.keys(call.options?.env ?? {});
      expect(keys.filter((k) => !k.startsWith("GIT_"))).toEqual([]);
    }
  });

  it("setup after destroy gives a clean workspace again", async () => {
    await setup();
    await sandbox.writeFile("src/sum.js", "changed\n");
    await sandbox.destroy();
    expect(container.destroyed).toBe(1);
    expect(sandbox.isRunning()).toBe(false);

    await setup();
    expect(await sandbox.listFiles()).toEqual(FILES);
    expect(await sandbox.diff()).toBe("");
  });
});

describe("S8: timeouts and aborts are reported as timeouts (finding 5)", () => {
  it("abort and timeout map to timedOut, not exit 137", async () => {
    await setup();

    let started = Date.now();
    const timedOut = await sandbox.exec("sleep 30", { timeoutMs: 500 });
    expect(timedOut).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(2000);

    const controller = new AbortController();
    setTimeout(() => controller.abort("stop"), 200);
    started = Date.now();
    const aborted = await sandbox.exec("sleep 30", { signal: controller.signal });
    expect(aborted).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(2000);

    // What the model sees, through the tool layer.
    const tool = await executeTool(
      { name: "run_command", rawArgs: JSON.stringify({ command: "sleep 30" }) },
      { sandbox, allowed: ["run_command"], timeoutMs: 1000 },
    );
    expect(tool).toMatchObject({ ok: false, exitCode: null });
    if (!tool.ok) expect(tool.error).toMatch(/^command timed out after 1s/);

    // The sandbox is still usable afterwards.
    expect((await sandbox.exec("echo ok")).stdout).toBe("ok\n");
  });
});

describe("sandbox loss is a SandboxLostError (P2-d)", () => {
  it("a call on a stopped container throws SandboxLostError", async () => {
    await setup();
    await container.destroy(); // the platform took it away
    expect(sandbox.isRunning()).toBe(false);
    await expect(sandbox.exec("ls")).rejects.toBeInstanceOf(SandboxLostError);
    await expect(sandbox.readFile("src/sum.js")).rejects.toBeInstanceOf(SandboxLostError);
    await expect(sandbox.writeFile("a.txt", "a")).rejects.toBeInstanceOf(SandboxLostError);
    await expect(sandbox.diff()).rejects.toBeInstanceOf(SandboxLostError);
  });

  it("a container destroyed during a command throws SandboxLostError", async () => {
    await setup();
    const started = Date.now();
    const running = sandbox.exec("sleep 10");
    setTimeout(() => void container.destroy(), 200);
    await expect(running).rejects.toBeInstanceOf(SandboxLostError);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("reads the image when it starts the container, and says why a start did not work", async () => {
    let asked = 0;
    sandbox = new CloudflareSandboxAdapter({
      container,
      files: container.files,
      image: () => {
        asked++;
        return "registry.example/sandbox:lazy";
      },
      workdir: container.workdir,
      tmpDir: container.tmpDir,
      startTimeoutMs: 400,
    });
    expect(asked).toBe(0); // not at construction: the Durable Object builds the adapter before any start
    await setup();
    expect(container.starts).toEqual([{ image: "registry.example/sandbox:lazy", enableInternet: false }]);
    // The idle timeout is set once the container answers, not straight after start().
    expect(container.inactivityMs).toBe(15 * 60_000);
    const order = container.log.filter((l) => l === "setInactivityTimeout" || l === "exec:true");
    expect(order.at(-1)).toBe("setInactivityTimeout");

    await sandbox.destroy();
    container.neverReady = true;
    await expect(setup()).rejects.toThrow(/did not become ready within .*: container is not ready/);
  });

  it("a container that fails to start is reported at once, with the platform's reason", async () => {
    container.failStart = "there is no capacity to start this container";
    const started = Date.now();
    const failed = setup();
    await expect(failed).rejects.toBeInstanceOf(SandboxLostError);
    await expect(failed).rejects.toThrow(/did not start: there is no capacity to start this container/);
    expect(Date.now() - started).toBeLessThan(3000); // not the 60 s readiness timeout

    // The next attempt starts from scratch and works.
    container.failStart = null;
    await setup();
    expect(await sandbox.listFiles()).toEqual(FILES);
  });

  it("start timeout throws SandboxLostError", async () => {
    container.neverReady = true;
    sandbox = adapter({ startTimeoutMs: 400 });
    const started = Date.now();
    await expect(setup()).rejects.toBeInstanceOf(SandboxLostError);
    await expect(sandbox.setup(streamOf(TARBALL))).rejects.toThrow(/ready/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
