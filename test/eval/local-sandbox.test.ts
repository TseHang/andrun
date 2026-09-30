import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandbox } from "../../eval/local-sandbox";

const FIXTURE = join(import.meta.dirname, "../../eval/fixtures/sum-off-by-one");

let sandbox: LocalSandbox;
beforeEach(async () => {
  sandbox = await LocalSandbox.fromFixture(FIXTURE);
});
afterEach(async () => {
  await sandbox.destroy();
});

describe("LocalSandbox", () => {
  it("copies the fixture into a fresh git baseline without touching the original", async () => {
    expect(sandbox.root).not.toBe(FIXTURE);
    expect((await sandbox.exec("git status --porcelain")).stdout).toBe("");
    await sandbox.writeFile("src/sum.js", "changed\n");
    expect(await sandbox.diff()).toContain("+changed");
    expect(existsSync(join(FIXTURE, ".git"))).toBe(false);
  });

  it("streams output and reports exit codes", async () => {
    const chunks: string[] = [];
    const r = await sandbox.exec("echo out; echo err 1>&2; exit 3", { onOutput: (s, c) => chunks.push(`${s}:${c}`) });
    expect(r).toMatchObject({ exitCode: 3, timedOut: false });
    expect(r.stdout).toContain("out");
    expect(r.stderr).toContain("err");
    expect(chunks.join("")).toContain("stdout:out");
  });

  it("command timeout aborts", async () => {
    const start = Date.now();
    const r = await sandbox.exec("sleep 5", { timeoutMs: 1000 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("diff includes new files and can be scoped to one path", async () => {
    await sandbox.writeFile("src/new.js", "export const y = 2;\n");
    await sandbox.writeFile("src/sum.js", "x\n");
    const all = await sandbox.diff();
    expect(all).toContain("src/new.js");
    expect(all).toContain("src/sum.js");
    const one = await sandbox.diff("src/new.js");
    expect(one).toContain("+export const y = 2;");
    expect(one).not.toContain("src/sum.js");
  });

  it("diff is against the baseline even after the agent commits", async () => {
    await sandbox.writeFile("src/sum.js", "x\n");
    await sandbox.exec("git add -A && git -c user.email=a@b -c user.name=a commit -qm hide");
    expect(await sandbox.diff()).toContain("src/sum.js");
    expect(sandbox.baseline).toMatch(/^[0-9a-f]{40}$/);
  });

  it("lists files without .git", async () => {
    const files = await sandbox.listFiles();
    expect(files).toEqual(expect.arrayContaining(["package.json", "src/sum.js", "test/sum.test.js"]));
    expect(files.some((f) => f.startsWith(".git"))).toBe(false);
    expect(await sandbox.listFiles("src")).toEqual(["src/sum.js"]);
  });

  it("readFile reports ENOENT", async () => {
    await expect(sandbox.readFile("nope.js")).rejects.toThrow(/^ENOENT/);
  });
});
