// Disposable TM-0 runtime probe. No production code imports this file.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
interface Env { SPIKE: DurableObjectNamespace<SpikeSandbox> }
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
export class EgressGate extends WorkerEntrypoint<Env, { enabled: boolean }> {
  async fetch(request: Request) {
    if (!this.ctx.props.enabled) return new Response("disabled\n", { status: 403 });
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Only GET and HEAD are allowed\n", { status: 405 });
    return fetch(request, { redirect: "manual" });
  }
}
export class SpikeSandbox extends DurableObject<Env> {
  private get c() { if (!this.ctx.container) throw new Error("missing container"); return this.ctx.container; }
  async start(network = true) {
    const started = Date.now();
    if (!this.c.running) this.c.start({ image: this.c.images.sandbox!, enableInternet: false, env: { SPIKE_START_ENV: "start-present" } });
    await this.c.setInactivityTimeout(15 * 60_000);
    if (network) {
      const gate = this.ctx.exports.EgressGate({ props: { enabled: true } });
      await this.c.interceptAllOutboundHttp(gate);
      await this.c.interceptOutboundHttps("*", gate);
    }
    for (;;) {
      try { await (await this.c.exec(["true"])).output(); break; }
      catch (e) { if (Date.now() - started > 60_000) throw e; await new Promise(r => setTimeout(r, 250)); }
    }
    return { readyMs: Date.now() - started, network };
  }
  async run(command: string, env?: Record<string, string>) {
    const started = Date.now();
    try {
      const p = await this.c.exec(["sh", "-c", command], { cwd: "/workspace", stderr: "combined", signal: AbortSignal.timeout(120_000), ...(env ? { env } : {}) });
      const o = await p.output();
      return { exitCode: o.exitCode, out: new TextDecoder().decode(o.stdout), ms: Date.now() - started };
    } catch (e) { return { error: String(e), ms: Date.now() - started }; }
  }
  async probe(name: string) {
    switch (name) {
      case "start": return this.start();
      case "offline": await this.start(false); return this.run('curl --max-time 15 -sS -o /dev/null -w "%{http_code}" https://example.com');
      case "env": return { plain: await this.run("env | sort"), custom: await this.run("env | sort", { SPIKE_EXEC_ENV: "exec-present" }) };
      case "trust": return this.run(`ls -l ${CA} && cp ${CA} /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates && npm config set --global cafile ${CA}`);
      case "curl": return this.run('curl --max-time 30 -sS -o /dev/null -w "%{http_code}" https://example.com');
      case "http": return this.run('curl --max-time 30 -sS -o /dev/null -w "%{http_code}" http://example.com');
      case "post": return this.run('curl --max-time 30 -sS -w "\\n%{http_code}" -X POST https://example.com');
      case "node-plain": return this.run('node -e "fetch(\'https://example.com\').then(r=>console.log(r.status)).catch(e=>{console.error(e);process.exitCode=1})"');
      case "node-env": return this.run('node -e "fetch(\'https://example.com\').then(r=>console.log(r.status)).catch(e=>{console.error(e);process.exitCode=1})"', { NODE_EXTRA_CA_CERTS: CA });
      case "npm": return this.run('npm install left-pad --no-audit --no-fund');
      case "port": return this.run('curl --max-time 15 -sS -o /dev/null -w "%{http_code}" https://example.com:8443');
      case "search": return this.run('curl --max-time 30 -sS -L -o /tmp/search.html -w "%{http_code}\\n" "https://www.google.com/search?q=cloudflare+containers" && node -e "const s=require(\'fs\').readFileSync(\'/tmp/search.html\',\'utf8\');console.log(s.slice(0,1000));console.log(\'bytes\',s.length,\'contains query\',s.includes(\'cloudflare\'))"');
      case "restart": await this.c.destroy(); return this.start();
      case "destroy": await this.c.destroy(); return { destroyed: true };
      default: throw new Error("unknown probe");
    }
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    try { return Response.json(await env.SPIKE.getByName(url.searchParams.get("s") ?? "egress").probe(url.pathname.slice(1))); }
    catch (e) { return Response.json({ error: String(e), stack: (e as Error).stack }, { status: 500 }); }
  }
} satisfies ExportedHandler<Env>;
