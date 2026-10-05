# Development & deployment

[Product overview](../README.md) · [Docs & progress](README.md) · [Known limits](limits.md)

## Local checks

Needs Node 22+ and pnpm.

```sh
pnpm install
pnpm test          # unit + integration tests (no network, no cost)
pnpm typecheck
pnpm lint
pnpm e2e           # browser tests: starts the fake model and wrangler dev itself (needs Docker)
```

### Eval against a real model

Copy `.env.example` to `.env` (git-ignored) and fill in your ai& key, then:

```sh
pnpm eval --case sum-off-by-one            # one case, one run
pnpm eval                                  # all 13 current cases, one run each
pnpm eval --runs 3 --max-cost 10           # three runs per case, with a cost cap
```

- Defaults: `--runs 1 --max-cost 5` (yen); the model is `deepseek-ai/deepseek-v4-flash`.
- The runner stops after reported usage reaches the cost cap and checks it between runs. An in-flight model call can overshoot the cap.
- Each run writes a JSONL trajectory per case and a `summary.md` to `eval/runs/<timestamp>/`.
- Each case defines its own forbidden changes and acceptance check; cases that ask for tests may edit tests.

Historical baseline on 2026-09-30 (flash, the original 5 cases × 1): **5/5 pass, 5.6 steps on average, ¥1.22 total.** This is not a result for the current 13-case suite.

### Run the Worker locally

Needs Docker running (the sandbox is a container). No ai& key and no cost: a fake model server plays a fixed script.

```sh
cp .dev.vars.example .dev.vars
pnpm fake-model                      # terminal 1: fake OpenAI-compatible SSE server on :8788
pnpm fake-github                     # terminal 2: fake GitHub REST API on :8789 (one in-memory repo)
pnpm build && pnpm dev               # terminal 3: build the app, then wrangler dev on :8787 (open it)
pnpm smoke                           # terminal 4: create → gate → replay → reject → approve → delete
pnpm smoke --flow kill               # kill the sandbox mid-run → failed → message → rebuilt
```

`pnpm dev` serves the last build in `dist/`. While working on the UI, run `pnpm dev:web` as well (Vite on :5173 with hot reload, proxying the API to :8787). The Phase 2 debug page is still at `/debug.html`.

Each local session leaves a `workerd-andrun-…` container in Docker, and `wrangler dev` does not always remove them when it stops. To clear them (with `wrangler dev` stopped):

```sh
docker ps -aq --filter name=workerd-andrun- | xargs docker rm -f
```

Tasks for the fake model can carry a marker: `[slow]` (8 s per answer), `[fail]` (every request fails), `[ask]` (writes `scratch.txt`, then proposes a deleting patch that needs approval). A Review session gets a fixed script of four findings. With the Auto model, a task with `[complex]` is sorted as complex (routed to `deepseek-v4.1-flash`, high); anything else is daily (`deepseek-v4-flash`, high).

The fake GitHub starts with an empty pull request list. Approving a Code session opens one; `curl -X POST localhost:8789/__reset` empties it again, and `GET localhost:8789/__state` shows its refs, pull requests and reviews. `.dev.vars.example` holds a throwaway App key that only the fake accepts.

To use the real model locally, put your ai& key and base URL in `.dev.vars` instead.

### Deploy

```sh
pnpm exec wrangler secret put AIAND_API_KEY
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_APP_INSTALLATION_ID
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY     # PKCS#8 PEM, see below
pnpm exec wrangler secret put GITHUB_PAT
pnpm run deploy
pnpm smoke https://<your-worker>.workers.dev      # one real session: costs tokens, and its approve opens a real pull request
```

The repo is set by `DEMO_REPO` in `wrangler.jsonc`. A Code session starts from the head of the repo's default branch; set `DEMO_SHA` to pin a commit instead. `KILL_SWITCH="1"` stops new sessions and every GitHub write; `GITHUB_WRITES="0"` stops only the GitHub writes.

**GitHub setup** (two identities, so the reviewer is never the author):

1. Create a GitHub App with repository permissions Contents (read and write), Pull requests (read and write) and Metadata (read). Install it on the one repo. The App id is on its settings page; the installation id is the number at the end of the installation's URL.
2. Generate a private key for the App and convert it to PKCS#8, which is what WebCrypto reads: `openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pk8.pem`. That file's content is `GITHUB_APP_PRIVATE_KEY`.
3. Create a fine-grained personal access token for the same repo with Pull requests (read and write). That is `GITHUB_PAT`: reviews are posted with it, as you.

The App bot opens every pull request (branch `agent/<session>-<n>`). GitHub does not let an account approve or request changes on its own pull request, so pull requests to be reviewed must not be opened by the PAT's account.
