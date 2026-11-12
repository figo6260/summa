# Summa — production image.
#
# Multi-stage build:
#   deps   — install the full dependency tree (including devDependencies)
#   build  — generate the Prisma client and build the Next.js app
#   runner — production runtime, non-root
#
# The runner intentionally keeps the full dependency tree: Summa v1 has
# no Prisma migrations yet (the entrypoint applies the schema with
# `prisma db push`), and the operational CLI scripts in scripts/
# (commissions:release, payouts:generate, seed:demo) run against that
# same tree. In v1, image size is traded for operational fidelity:
# everything that works in a source checkout works in the container.
FROM node:20-slim AS deps
WORKDIR /app
# Prisma detects its engine platform from the openssl binary; without
# it the generated client targets the wrong OpenSSL line and cannot
# find its query engine at runtime. Install it in every build stage.
RUN apt-get update  && apt-get install -y --no-install-recommends openssl ca-certificates  && rm -rf /var/lib/apt/lists/*
# Optional: point npm at a mirror registry (e.g. a regional mirror)
# by passing --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=""
COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm ci

FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update  && apt-get install -y --no-install-recommends openssl ca-certificates  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Prisma needs OpenSSL present to pick the right engine at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/app ./app
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
