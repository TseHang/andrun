// GitHub App authentication (ADR D9): sign an RS256 JWT with WebCrypto, trade it for an installation
// token, and keep that token in memory for 50 minutes (GitHub issues it for 60).

import { GitHubError, type Request } from "./client";

const TOKEN_TTL_MS = 50 * 60_000;

export interface AppAuthConfig {
  appId: string;
  installationId: string;
  privateKey: string;
  request: Request;
  now: () => number;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

function pkcs8Bytes(pem: string): Uint8Array<ArrayBuffer> {
  const text = pem.replace(/\\n/g, "\n").trim();
  if (!text.startsWith("-----BEGIN PRIVATE KEY-----")) throw new Error("GITHUB_APP_PRIVATE_KEY must be a PKCS#8 PEM");
  const body = text.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

async function signJwt(config: AppAuthConfig): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", pkcs8Bytes(config.privateKey ?? ""), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (e) {
    // A key in the wrong format is a setup error; it is reported like any other GitHub failure.
    throw new GitHubError(`GITHUB_APP_PRIVATE_KEY could not be read: ${e instanceof Error ? e.message : String(e)}`, 0);
  }
  const iat = Math.floor(config.now() / 1000) - 60; // allow for clock drift
  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({ iss: config.appId, iat, exp: iat + 600 })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

export interface AppAuth {
  /** The current installation token. */
  token(): Promise<string>;
  /** The App's bot login, `<slug>[bot]`; asked once, with the App JWT. */
  botLogin(): Promise<string>;
}

export function createAppAuth(config: AppAuthConfig): AppAuth {
  let cached: { token: string; expiresAt: number } | undefined;
  let bot: string | undefined;
  return {
    async token() {
      if (cached && config.now() < cached.expiresAt) return cached.token;
      const jwt = await signJwt(config);
      const res = (await config.request("POST", `/app/installations/${config.installationId}/access_tokens`, jwt)) as { token: string };
      cached = { token: res.token, expiresAt: config.now() + TOKEN_TTL_MS };
      return res.token;
    },
    async botLogin() {
      if (bot) return bot;
      const app = (await config.request("GET", "/app", await signJwt(config))) as { slug: string };
      bot = `${app.slug}[bot]`;
      return bot;
    },
  };
}
