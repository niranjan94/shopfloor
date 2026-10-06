FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-plane/package.json apps/control-plane/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm control-plane:build

FROM build AS migrate
CMD ["pnpm", "db:migrate"]

FROM node:24-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/apps/control-plane/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/control-plane/.next/static ./apps/control-plane/.next/static
USER node
ENV PORT=3010 HOSTNAME=0.0.0.0
EXPOSE 3010
CMD ["node", "apps/control-plane/server.js"]

FROM build AS worker
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
USER node
EXPOSE 3011
CMD ["node", "dist/queue-worker.cjs"]
