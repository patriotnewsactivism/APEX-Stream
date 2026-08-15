# syntax=docker/dockerfile:1.7
# Build context is the repository root so workspace packages resolve.
FROM --platform=$BUILDPLATFORM public.ecr.aws/docker/library/node:22-alpine AS build
WORKDIR /repo

# Manifests first: dependency layers stay cached while source churns.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/workflow-engine/package.json packages/workflow-engine/
COPY packages/youtube/package.json packages/youtube/
COPY services/orchestrator/package.json services/orchestrator/
RUN npm ci --ignore-scripts

COPY packages packages
COPY services/orchestrator services/orchestrator
COPY db db
RUN npm run build -w @apex/core \
 && npm run build -w @apex/agent-runtime \
 && npm run build -w @apex/workflow-engine \
 && npm run build -w @apex/youtube \
 && npm run build -w $(node -p "require('./services/orchestrator/package.json').name")

# Drop dev dependencies from the layer that ships.
RUN npm prune --omit=dev

FROM public.ecr.aws/docker/library/node:22-alpine AS runtime
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps
WORKDIR /repo

RUN apk add --no-cache tini && addgroup -S apex && adduser -S apex -G apex

COPY --from=build --chown=apex:apex /repo/node_modules ./node_modules
COPY --from=build --chown=apex:apex /repo/packages ./packages
COPY --from=build --chown=apex:apex /repo/services/orchestrator ./services/orchestrator
COPY --from=build --chown=apex:apex /repo/db ./db
COPY --from=build --chown=apex:apex /repo/package.json ./package.json
# The migration runner reads these at runtime; without them the migrate task
# starts, finds no files, and reports success having done nothing.
COPY --chown=apex:apex db/migrations ./db/migrations

USER apex
EXPOSE 8080

# tini reaps zombies and forwards SIGTERM so the graceful drain actually runs.
ENTRYPOINT ["/sbin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/orchestrator/dist/index.js"]
