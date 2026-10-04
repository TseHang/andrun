import { describe, expect, it, vi } from "vitest";
import { egressDecision, proxyEgress } from "../../src/sandbox/egress";

const ON = { enabled: true, killSwitch: false };

describe("Task egress", () => {
  it("GET and HEAD to public names pass; other methods, addresses and internal names are refused", () => {
    for (const [method, url] of [["GET", "https://example.com/a"], ["HEAD", "http://example.com/"]]) {
      expect(egressDecision(method!, url!, ON)).toBeNull();
    }
    expect(egressDecision("POST", "https://example.com/", ON)).toMatchObject({ status: 405 });
    for (const url of ["http://169.254.169.254/", "http://127.0.0.1/", "http://[::1]/", "http://localhost/", "http://localhost./", "http://intranet/", "https://db.internal/", "https://db.local/", "https://db.internal./"]) {
      expect(egressDecision("GET", url, ON), url).toMatchObject({ status: 403, reason: expect.stringMatching(/^[^\n]+$/) });
    }
    for (const opts of [{ enabled: false, killSwitch: false }, { enabled: true, killSwitch: true }]) {
      for (const method of ["GET", "HEAD", "POST"]) expect(egressDecision(method, "https://example.com/", opts)).toMatchObject({ status: 403 });
    }
  });

  it("a redirect is handed back, a body is cut at the limit", async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://localhost/x" } }));
    const r = await proxyEgress(new Request("https://example.com/"), ON, redirect);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("http://localhost/x");
    expect(redirect).toHaveBeenCalledExactlyOnceWith(expect.any(Request), { redirect: "manual" });
    const upstream = vi.fn(async () => new Response(new Uint8Array(30 * 1024 * 1024), { headers: { "content-length": String(30 * 1024 * 1024) } }));
    const body = await proxyEgress(new Request("https://example.com/"), ON, upstream);
    expect((await body.arrayBuffer()).byteLength).toBe(25 * 1024 * 1024);
    expect(body.headers.get("content-length")).not.toBe(String(30 * 1024 * 1024));
    const denied = await proxyEgress(new Request("https://example.com/", { method: "POST" }), ON, upstream);
    expect(denied.status).toBe(405);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
