# TM-0 — Task read-only egress spike

Date: 2026-10-04–05. **Go: implement TM-e (network enabled).**
Local only: Docker 24.0.6, Wrangler 4.144.0, Sandbox 1.0.0, Node 22.23.3 in the image. No deployment or real model call.

## Reproduce

From the repo root:

```sh
pnpm exec wrangler dev --config spike/egress/wrangler.jsonc --port 8791
python3 spike/egress/run.py
```

The disposable Worker and Dockerfile live in `spike/egress/`; JSON results are in `spike/egress/evidence/`. The main agent separately repeated curl, POST, Node and npm after the initial run. The first image build took several minutes downloading Debian packages.

## Results

| Probe | Observed result |
|---|---|
| `ctx.exports.EgressGate({props})` | Works locally with the pinned Wrangler; HTTP and HTTPS intercepts use the exported entrypoint. |
| `start({enableInternet:false})`, then HTTP and HTTPS `*` interception | curl HTTP and HTTPS both return 200. |
| POST | 405, `Only GET and HEAD are allowed`. |
| Runtime CA | `/etc/cloudflare/certs/cloudflare-containers-ca.crt` exists after start. Copying it into `/usr/local/share/ca-certificates/` and running `update-ca-certificates` makes curl trust it. |
| Node without exec env | Fails: `SELF_SIGNED_CERT_IN_CHAIN`, even after updating the system CA store. |
| Node with exec env | `NODE_EXTRA_CA_CERTS` pointing to the runtime CA makes `fetch` return 200. |
| npm | `npm config set --global cafile` to the runtime CA, then `npm install left-pad --no-audit --no-fund` exits 0. The production image already disables audit, fund and update notifications. |
| exec env | Locally it merges with the existing environment: PATH, image marker and start marker remain when an exec marker is supplied. **This differs from the earlier deployed spike** where image ENV was absent; do not rely on image ENV in production. Pass Node's CA setting to exec explicitly. |
| Restart | Destroy, start, register intercepts again, trust the new runtime CA: curl 200, POST 405, Node 200 and npm exit 0 again. |
| Code/offline control | No intercepts; curl exits 6, `Could not resolve host: example.com`. |
| Nonstandard port | `https://example.com:8443` fails, exit 35 (`SSL_ERROR_SYSCALL`), status 000. |
| Search engine GET | Google returned HTTP 200 and 92,372 characters, but the document opens with JavaScript/retry scaffolding. A query substring alone does not prove usable search results. **Usable results not established**; no search feature follows from this probe. |

Production setup must register intercepts after each start and before agent commands, install the runtime CA after readiness, pass `NODE_EXTRA_CA_CERTS` on exec, and set npm's global cafile. Code and Review register nothing. The gate remains in the Worker; its rules are platform-free.

Not verified: deployed behavior, other tools' CA trust (including Python), arbitrary protocols. Local production wiring and rebuild are additionally covered by `e2e/task.spec.ts`. Deployment requires Henry's go-ahead and was not attempted.
