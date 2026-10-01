# The sandbox image: Node (for `node --test`), git, tar, and the helper that the Files API talks to.
# The sandbox-shim tag must match the @cloudflare/sandbox package version (ADR D15).
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace
CMD ["sleep", "infinity"]
