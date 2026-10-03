import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubError } from "../../src/github";
import { testKeys } from "../support/fake-github";
import { setup } from "./helpers";

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
const tokenRequests = (fake: ReturnType<typeof setup>["fake"]) => fake.requests.filter((r) => r.path.endsWith("/access_tokens")).length;

describe("GitHub App auth (D9)", () => {
  it("signs a JWT, caches the installation token and renews it", async () => {
    const { fake, github, clock } = setup();
    await github.defaultBranchHead();
    await github.defaultBranchHead();
    expect(tokenRequests(fake)).toBe(1);

    const [header, payload, signature] = fake.jwts[0]!.split(".") as [string, string, string];
    expect(decode(header)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload) as { iss: string; iat: number; exp: number };
    expect(String(claims.iss)).toBe("12345");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iat).toBeLessThanOrEqual(clock.now / 1000);
    const ok = verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPublicKey(testKeys().publicKey), Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);

    // Calls to the repo carry the installation token, never the JWT or the PAT.
    expect(fake.requests.filter((r) => r.path.startsWith("/repos/")).every((r) => r.auth?.startsWith("ghs_"))).toBe(true);

    clock.now += 51 * 60_000;
    await github.defaultBranchHead();
    expect(tokenRequests(fake)).toBe(2);
  });

  it("accepts a key whose newlines are written as \\n", async () => {
    const { github } = setup({}, { privateKey: testKeys().privateKey.replace(/\n/g, "\\n") });
    await expect(github.defaultBranchHead()).resolves.toMatchObject({ branch: "main" });
  });

  it("refuses a key that is not PKCS#8", async () => {
    const pkcs1 = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const { github, fake } = setup({}, { privateKey: pkcs1 });
    await expect(github.defaultBranchHead()).rejects.toThrow("GITHUB_APP_PRIVATE_KEY must be a PKCS#8 PEM");
    expect(fake.requests).toHaveLength(0);
  });

  it("turns GitHub failures into GitHubError with the status and the rate limit", async () => {
    const { fake, github } = setup();
    fake.fail({ path: /^\/repos\//, status: 502, body: { message: "Bad Gateway" } });
    const bad = await github.defaultBranchHead().catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(GitHubError);
    expect(bad).toMatchObject({ status: 502, rateLimited: false });
    expect((bad as Error).message).toMatch(/502/);

    const reset = Math.floor(Date.parse("2026-10-03T00:30:00Z") / 1000);
    fake.fail({
      path: /^\/repos\//,
      status: 403,
      body: { message: "API rate limit exceeded for installation" },
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    });
    const limited = await github.defaultBranchHead().catch((e: unknown) => e);
    expect(limited).toMatchObject({ status: 403, rateLimited: true, resetAt: reset * 1000 });
    expect((limited as Error).message).toMatch(/rate limit/i);
    expect((limited as Error).message).toMatch(/00:30/); // says when it resets (UTC)
  });
});
