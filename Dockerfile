# ─────────────────────────────────────────────────────────────────────────────
# Bulgarian Data Protection MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t bulgarian-data-protection-mcp .
# Run:    docker run --rm -p 3000:3000 bulgarian-data-protection-mcp
#
# The image expects a pre-built database at /app/data/cpdp.db.
# Override with CPDP_DB_PATH for a custom location.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + native bindings ---
FROM node:20-alpine AS builder

# Toolchain needed for better-sqlite3 native build
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json* ./
COPY tsconfig.json ./
COPY src/ src/
COPY scripts/ scripts/

# Install deps (postinstall runs to fetch/build better-sqlite3 binding),
# then explicitly rebuild against the runtime Node ABI.
RUN npm ci && npm rebuild better-sqlite3

RUN npm run build

# --- Stage 2: Production ---
FROM node:20-alpine AS production

WORKDIR /app
ENV NODE_ENV=production
ENV CPDP_DB_PATH=/app/data/cpdp.db

# Copy already-built node_modules (with native binding intact) from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Bake the operational DB into the image so the container is self-contained.
# (The CI workflow gunzips the GitHub Release asset to data/database.db before
# build; locally the repo's data/cpdp.db is used directly.)
COPY data/database.db data/cpdp.db

# Preserve scripts dir so tsc rootDir invariants stay aligned with what was
# compiled in builder (CMD path is dist/src/http-server.js).
COPY scripts/ ./scripts/

# Non-root user for security
RUN addgroup -S -g 1001 mcp && \
    adduser -S -u 1001 -G mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
