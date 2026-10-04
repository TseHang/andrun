// Task egress rules and forwarding, using only web-standard APIs (ADR D1).
export interface EgressOptions {
  enabled: boolean;
  killSwitch: boolean;
}

const MAX_BODY_BYTES = 25_000_000;

export function egressDecision(method: string, url: string, opts: EgressOptions): { status: number; reason: string } | null {
  if (!opts.enabled || opts.killSwitch) return { status: 403, reason: "Task network is disabled" };
  if (method !== "GET" && method !== "HEAD") return { status: 405, reason: "Only GET and HEAD are allowed" };
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!["http:", "https:"].includes(parsed.protocol) || (parsed.port && !["80", "443"].includes(parsed.port))) {
    return { status: 403, reason: "Only HTTP and HTTPS on ports 80 and 443 are allowed" };
  }
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { status: 403, reason: "Only public DNS names are allowed" };
  }
  return null;
}

export async function proxyEgress(request: Request, opts: EgressOptions, upstream: typeof fetch = fetch): Promise<Response> {
  const refused = egressDecision(request.method, request.url, opts);
  if (refused) return new Response(`${refused.reason}\n`, { status: refused.status });
  const response = await upstream(request, { redirect: "manual" });
  if (!response.body) return response;
  const reader = response.body.getReader();
  let remaining = MAX_BODY_BYTES;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      const chunk = value.subarray(0, remaining);
      remaining -= chunk.byteLength;
      controller.enqueue(chunk);
      if (remaining === 0) {
        controller.close();
        await reader.cancel();
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
