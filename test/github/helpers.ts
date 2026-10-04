import { createGitHub } from "../../src/github";
import { FAKE_PAT, FAKE_REPO, createFakeGitHub, testKeys } from "../support/fake-github";

export const API = "https://api.github.test";

/** A fake GitHub and the real client wired to it. `clock.now` can be moved forward. */
export function setup(seed: Parameters<typeof createFakeGitHub>[0] = {}, over: Partial<Parameters<typeof createGitHub>[0]> = {}) {
  const fake = createFakeGitHub(seed);
  const clock = { now: Date.parse("2026-10-03T00:00:00Z") };
  const github = createGitHub({
    apiUrl: API,
    repo: FAKE_REPO,
    appId: "12345",
    installationId: "678",
    privateKey: testKeys().privateKey,
    pat: FAKE_PAT,
    fetch: fake.fetch,
    now: () => clock.now,
    ...over,
  });
  return { fake, github, clock };
}
