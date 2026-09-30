// Throwaway spike for @cloudflare/sandbox 1.0 (ADR D5, D10, D11, D15). Not merged into src/.
// One DO class holds session state (SQLite) AND hosts the container, to answer D5.
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

interface Env {
  SPIKE: DurableObjectNamespace<SpikeSandbox>;
}

const W = "/workspace";

// Fixture: the eval's sum-off-by-one repo, inlined.
const FIXTURE: Record<string, string> = {
  "package.json": '{ "name": "sum", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
  "src/sum.js":
    "export function sum(values) {\n  let total = 0;\n  for (let i = 0; i < values.length - 1; i++) {\n    total += values[i];\n  }\n  return total;\n}\n",
  "test/sum.test.js":
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "../src/sum.js";\n\ntest("sums all values", () => {\n  assert.equal(sum([1, 2, 3]), 6);\n});\n',
};

const decode = (b: ArrayBuffer) => new TextDecoder().decode(b);

export class SpikeSandbox extends DurableObject<Env> {
  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error("container binding not configured");
    return c;
  }

  /** Q1: start with egress off; returns how long until exec works. */
  async ensureStarted(): Promise<{ wasRunning: boolean; readyMs: number; attempts: number }> {
    const c = this.container;
    const wasRunning = c.running;
    const t0 = Date.now();
    if (!wasRunning) {
      c.start({ image: c.images["sandbox"]!, enableInternet: false });
      await c.setInactivityTimeout(15 * 60_000);
    }
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        const p = await c.exec(["true"]);
        await p.output();
        return { wasRunning, readyMs: Date.now() - t0, attempts };
      } catch (e) {
        if (Date.now() - t0 > 60_000) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  async run(argv: string[], timeoutMs = 120_000) {
    const t0 = Date.now();
    const p = await this.container.exec(argv, { cwd: W, signal: AbortSignal.timeout(timeoutMs), stderr: "combined" });
    try {
      const o = await p.output();
      return { exitCode: o.exitCode, out: decode(o.stdout), ms: Date.now() - t0 };
    } catch (e) {
      return { exitCode: null, out: String(e), ms: Date.now() - t0, aborted: true };
    }
  }

  /** Q2a: write the fixture via Files, then git baseline. */
  async seedFixture() {
    await this.ensureStarted();
    const files = new Files(this.container);
    const t0 = Date.now();
    for (const [path, content] of Object.entries(FIXTURE)) {
      // Finding: writeFile does not create parent directories.
      const dir = `${W}/${path}`.split("/").slice(0, -1).join("/");
      await files.mkdir(dir, { recursive: true });
      await files.writeFile(`${W}/${path}`, content);
    }
    const git = await this.run([
      "sh",
      "-c",
      "git init -q && git -c user.email=a@b -c user.name=spike add -A && git -c user.email=a@b -c user.name=spike commit -qm base && git log --oneline",
    ]);
    const read = await (await files.readFile(`${W}/src/sum.js`)).text();
    const dir = await files.readDirectory(W);
    return { writeMs: Date.now() - t0, git, readBack: read.includes("values.length - 1"), dir: dir.map((d) => d.name) };
  }

  /** Q2b: the Worker (not the container) fetches a tarball and streams it in via Files. */
  async seedTarball(stream: ReadableStream<Uint8Array>) {
    await this.ensureStarted();
    const files = new Files(this.container);
    const t0 = Date.now();
    await files.writeFile("/tmp/repo.tgz", stream);
    const unpack = await this.run(["sh", "-c", "mkdir -p /tmp/repo && tar -xzf /tmp/repo.tgz -C /tmp/repo --strip-components=1 && ls /tmp/repo | head"]);
    return { ms: Date.now() - t0, unpack };
  }

  /** Q3: stream stdout chunk by chunk, with arrival times. */
  async streamed(): Promise<ReadableStream<Uint8Array>> {
    await this.ensureStarted();
    const p = await this.container.exec(
      ["sh", "-c", "for i in 1 2 3 4; do echo line $i; sleep 1; done; node --test 2>&1; echo exit=$?"],
      { cwd: W, stdout: "pipe", stderr: "combined" },
    );
    const t0 = Date.now();
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    return p.stdout!.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          const text = dec.decode(chunk, { stream: true });
          ctl.enqueue(enc.encode(`[+${Date.now() - t0}ms] ${text}`));
        },
      }),
    );
  }

  /** Q3b: timeout/abort kills the process. */
  async timeout() {
    await this.ensureStarted();
    const r = await this.run(["sleep", "30"], 2000);
    const leftover = await this.run(["sh", "-c", "ps -eo pid,comm | grep -c '[s]leep 30' || true"]);
    return { r, sleepStillRunning: leftover.out.trim() };
  }

  /** Q1b: no egress, no secrets in env. */
  async isolation() {
    await this.ensureStarted();
    const net = await this.run(
      ["node", "-e", "fetch('https://example.com').then(r=>console.log('REACHED',r.status)).catch(e=>console.log('BLOCKED',e.cause?.code??e.message))"],
      20_000,
    );
    const env = await this.run(["sh", "-c", "env | cut -d= -f1 | sort | tr '\\n' ' '"]);
    return { net, envKeys: env.out };
  }

  /** Q4: session state in this DO's SQLite, alongside the running container. */
  async session(note: string) {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)");
    sql.exec("INSERT INTO events (body) VALUES (?)", note);
    const rows = sql.exec("SELECT seq, body FROM events ORDER BY seq").toArray();
    return { rows, containerRunning: this.ctx.container?.running ?? null };
  }

  /** Q5: lose the container, detect it, rebuild. */
  async destroyAndRebuild() {
    const c = this.container;
    await c.destroy();
    const afterDestroy = c.running;
    let filesError = "";
    try {
      await new Files(c).readFile(`${W}/src/sum.js`);
    } catch (e) {
      filesError = SandboxFileError.is(e) ? `SandboxFileError ${e.code}` : String(e);
    }
    const restart = await this.ensureStarted();
    const stillThere = await this.run(["sh", "-c", `ls ${W} || true`]);
    return { afterDestroy, filesError, restart, workspaceAfterRestart: stillThere.out };
  }

  async teardown() {
    await this.ctx.container?.destroy();
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const stub = env.SPIKE.getByName(url.searchParams.get("s") ?? "spike-1");
    const json = (p: Promise<unknown>) =>
      p.then((v) => Response.json(v)).catch((e: unknown) => Response.json({ error: String(e), stack: (e as Error)?.stack }, { status: 500 }));
    switch (url.pathname) {
      case "/start":
        return json(stub.ensureStarted());
      case "/fixture":
        return json(stub.seedFixture());
      case "/tarball": {
        const t0 = Date.now();
        const r = await fetch("https://codeload.github.com/sindresorhus/slugify/tar.gz/refs/heads/main");
        if (!r.ok || !r.body) return new Response(`tarball fetch ${r.status}`, { status: 502 });
        return json(stub.seedTarball(r.body).then((v) => ({ ...v, fetchStartMs: Date.now() - t0 })));
      }
      case "/stream":
        return new Response(await stub.streamed(), { headers: { "content-type": "text/plain; charset=utf-8" } });
      case "/timeout":
        return json(stub.timeout());
      case "/isolation":
        return json(stub.isolation());
      case "/session":
        return json(stub.session(url.searchParams.get("note") ?? "hello"));
      case "/rebuild":
        return json(stub.destroyAndRebuild());
      case "/teardown":
        return json(stub.teardown());
      default:
        return new Response("spike: /start /fixture /tarball /stream /timeout /isolation /session /rebuild /teardown\n");
    }
  },
} satisfies ExportedHandler<Env>;
