# Spike — Cloudflare Sandbox SDK 1.0

**Date**: 2026-09-30
**Verdict**: ✅ **Go with 1.0** (D15). The 0.12.x fallback is not needed. **D5 confirmed**: one DO class is both the session and the container host.
**Code**: `spike/sandbox-1.0/`, about 150 lines. It is throwaway and not merged into `src/`.
**Environments**:
- local `wrangler dev` with Docker
- a deployed Worker (Workers Paid), deleted afterwards along with its image and container application

## Setup that works
- `@cloudflare/sandbox@1.0.0`, `wrangler@4.144.0`, `compatibility_date 2026-09-30`, `nodejs_compat`.
- `wrangler.jsonc`:
  - `containers[{class_name, scheduling_policy: "durable_object", images: {sandbox: {dockerfile}}}]`
  - `exports: {Class: {type: "durable-object", storage: "sqlite"}}` (1.0 uses `exports`, not `migrations`)
  - a DO binding
- Image: `node:22-bookworm-slim`, plus `git`, plus `sandbox-shim` copied from `docker.io/cloudflare/sandbox:1.0.0`. The shim tag must match the package version.

## Results

| # | Question | Local | Deployed | Result |
|---|---|---|---|---|
| 1 | Container starts with `enableInternet:false`, and exec works | ready in 0.5 s | **cold start 10.4 s** (first start after deploy), warm 15 ms | ✅ |
| 1b | Egress is blocked and no secrets are in env | `ENOTFOUND` | `EAI_AGAIN` after **~10 s** (DNS timeout); env is only `HOME PATH PWD` | ✅ |
| 2a | Fixture written via `Files`, then git baseline | ✅ | write 186 ms, git 82 ms | ✅ |
| 2b | The Worker fetches a GitHub tarball and streams it in via `Files.writeFile(stream)`, then `tar -x` | ✅ | fetch 0.46 s, write + untar 90 ms | ✅ D10: no token or network needed inside the sandbox |
| 3 | `exec` stdout streams incrementally | lines arrive about 1 s apart | same | ✅ S5 streaming is possible over `ReadableStream` |
| 3b | Abort via `AbortSignal.timeout` | exit 137 at 2.1 s | exit 137 at 2.0 s | ✅ |
| 4 | Same DO: SQLite session rows plus a running container | ✅ | ✅ rows persist across container destroy | ✅ **D5: one class** |
| 5 | Container loss: detect it and rebuild | `exec()` throws "container that is not running"; restart 126 ms | restart 370 ms; **workspace is empty** | ✅ D11 rebuild is required and cheap |
| 6 | Local dev | needs Docker; the first image build took ~4 min (amd64 emulation on Apple Silicon), cached after that | — | ✅ |

## Findings that change the implementation (Phase 2)
1. **`Files.writeFile` does not create parent directories.** The `CloudflareSandboxAdapter.writeFile` must call `files.mkdir(dir, {recursive: true})` first.
2. **`max_instances` is not allowed with `scheduling_policy: durable_object`.** The container count can't be capped in config, so the cap has to live in the app: D14's rate limit on session create, plus the kill switch.
3. **Cold start takes about 10 s** for the first container after a deploy. The UI needs a visible "Starting sandbox…" status, not a silent wait.
4. **Blocked egress fails slowly (~10 s DNS timeout)**, not immediately. `npm install` and similar commands will hang until then. The 120 s exec timeout still bounds this. Fixtures stay zero-dependency, and the prompt already says there is no network.
5. **An aborted exec reports exit 137.** The adapter should map an abort to `timedOut: true`, not to a normal non-zero exit.
6. **`wrangler containers delete` rejects the ID that `wrangler containers list` prints** for DO-scheduled apps. `cf containers applications delete <id> --force` works. The delete-session flow (D18) uses `container.destroy()` in code, so it is not affected.

## Answered in Phase 2 (deployed, 2026-10-02)
- **The DO can hibernate while its container is running.** A session at the approval gate with one WebSocket open was left idle for 5.5 minutes: the Durable Object was evicted and rebuilt (`bootId` changed), the socket stayed open, the container kept running, and a later frame was answered. The inactivity timeout belongs to the object instance, so the constructor sets it again when it finds the container running.
- **The 15 minute inactivity timeout stops the container** also after an eviction (checked 16.5 minutes after the last request).
- **Cold start after a long idle period is short.** About 50 minutes after the container was reclaimed, a rebuild (start, tarball, saved changes) took 1.7 s, with the container ready in 0.6 s. The ~11 s cold start is the first start after a deploy.
- **Image `ENV` does not reach processes started with `exec`**: `env` inside the sandbox prints only `HOME`, `PATH` and `PWD`. Settings a tool needs go into its own config file in the image.
- **`start()` can be accepted and still never run a container.** `exec` then fails with "cannot be called on a container that is not running" until a timeout. Only `monitor()` reports why, at the price of keeping the Durable Object in memory for up to 15 minutes. Seen once on one session; a retry after the next deploy worked.
- `wrangler containers info` instance counts lag behind the real state.
