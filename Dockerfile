# The sandbox image: Node (for `node --test`), git, tar, and the helper that the Files API talks to.
# The sandbox-shim tag must match the @cloudflare/sandbox package version (ADR D15).
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace
# The sandbox has no network. Without this, npm's update check waits about 10 s for DNS to time out
# at the end of every `npm test` (seen on the deployed Worker; spike finding 4).
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
CMD ["sleep", "infinity"]
