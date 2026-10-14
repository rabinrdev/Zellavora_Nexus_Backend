# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json knexfile.ts ./
COPY src ./src
COPY migrations ./migrations
COPY seeds ./seeds
COPY scripts ./scripts
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini postgresql-client && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home nexus
COPY --from=build --chown=nexus /app/node_modules ./node_modules
COPY --from=build --chown=nexus /app/dist ./dist
COPY --chown=nexus package.json ./
USER nexus
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# run migrations as the owner role first (`npm run db:migrate:prod`), then start the API as nexus_app
CMD ["node", "dist/src/server.js"]
