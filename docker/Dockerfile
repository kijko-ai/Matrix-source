# =============================================================================
# Claude Agent Teams UI standalone Docker image
#
# Runs the HTTP server without Electron, serving the full UI over HTTP.
# Mount your ~/.claude directory to make session data available.
#
# Build:  docker build -t claude-agent-teams-ui .
# Run:    docker run -p 3456:3456 -v ~/.claude:/data/.claude:ro claude-agent-teams-ui
# =============================================================================

FROM node:20-slim AS builder

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# node-pty needs a native build toolchain during install
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN NODE_OPTIONS=--max-old-space-size=6144 pnpm standalone:build

# =============================================================================
# Production stage — minimal image with only the built output
# =============================================================================
FROM node:20-slim

WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/kijko-ai/Matrix"
LABEL org.opencontainers.image.description="Standalone Matrix deployment image for docs.kijko.nl"

# Enable corepack for pnpm
RUN corepack enable

# Reuse the builder's installed modules so native addons and lifecycle scripts
# don't need to run again in the runtime image.
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/agent-teams-controller ./agent-teams-controller

# Copy built standalone server and renderer output
COPY --from=builder /app/dist-standalone ./dist-standalone
COPY --from=builder /app/out/renderer ./out/renderer

# Create data directory for Claude session mount
RUN mkdir -p /data/.claude

ENV NODE_ENV=production
ENV CLAUDE_ROOT=/data/.claude
ENV HOST=0.0.0.0
ENV PORT=3456

EXPOSE 3456

CMD ["node", "dist-standalone/index.cjs"]
