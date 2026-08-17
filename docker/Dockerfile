# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Copy root manifests
COPY package*.json ./
COPY tsconfig.base.json ./

# Copy only the workspace manifests needed for npm install resolution.
# Excludes dashboard to avoid pulling in Next.js devDependencies.
COPY packages/types/package.json       packages/types/
COPY packages/db/package.json          packages/db/
COPY packages/event-bus/package.json   packages/event-bus/
COPY packages/llm/package.json         packages/llm/
COPY services/event-bus/package.json   services/event-bus/
COPY services/ingestion/package.json   services/ingestion/
COPY services/pipeline/package.json    services/pipeline/
COPY services/arb-solver/package.json  services/arb-solver/

RUN npm ci --ignore-scripts

# Copy only the source needed for the event-bus service and its deps
COPY tsconfig.base.json ./
COPY packages/types/   packages/types/
COPY packages/event-bus/ packages/event-bus/
COPY services/event-bus/ services/event-bus/

# Build only the packages this service depends on
RUN npx tsc -p packages/types/tsconfig.json && \
    npx tsc -p packages/event-bus/tsconfig.json && \
    npx tsc -p services/event-bus/tsconfig.json

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Copy manifests + node_modules from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules  ./node_modules

# Copy only the built artefacts needed at runtime
COPY --from=builder /app/packages/types/dist    packages/types/dist
COPY --from=builder /app/packages/event-bus/dist packages/event-bus/dist
COPY --from=builder /app/services/event-bus/dist services/event-bus/dist

# Copy package.json files so Node can resolve workspace symlinks
COPY --from=builder /app/packages/types/package.json    packages/types/
COPY --from=builder /app/packages/event-bus/package.json packages/event-bus/
COPY --from=builder /app/services/event-bus/package.json services/event-bus/

CMD ["node", "services/event-bus/dist/index.js"]
