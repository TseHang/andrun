# TM-0 disposable egress probe

Requires local Docker. This starts only `wrangler dev`; never deploy this probe.

```sh
pnpm exec wrangler dev --config spike/egress/wrangler.jsonc --port 8791
# Once the image is built and the server is ready, in another terminal:
python3 spike/egress/run.py
```

Each endpoint is also callable with `curl http://localhost:8791/<probe>`.
`/start` starts the offline container and registers both wildcard intercepts using
`ctx.exports.EgressGate({props})`. `/trust` installs the runtime CA into the OS
trust store and npm's global config. `/node-env` explicitly supplies Node's CA.
`/restart` destroys the container and registers fresh intercepts after starting.
`/offline?s=offline` uses a separate container without intercepts.

The `evidence` directory records output, including expected failures. The gate
here only tests plumbing; production host validation and size limits belong to
acceptance tests S8/S9, not this throwaway implementation.

Cleanup before stopping Wrangler:

```sh
curl http://localhost:8791/destroy
curl 'http://localhost:8791/destroy?s=offline'
```
