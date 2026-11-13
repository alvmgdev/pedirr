# syntax=docker/dockerfile:1

# Compiled output is architecture independent, so the build stage runs natively
# on the builder even when the final image targets another platform.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund
COPY prisma prisma
RUN npx prisma generate
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build

# Production dependencies install on the target platform so native modules
# (argon2, Prisma engines) match the runtime architecture.
FROM node:24-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @pedirr/server --no-audit --no-fund && npm cache clean --force
COPY prisma prisma
RUN npx prisma generate

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="Pedirr" \
      org.opencontainers.image.description="Sports content requests for Sportarr" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"
COPY --chown=node:node LICENSE ./LICENSE
COPY --from=deps --chown=node:node /app/package.json ./package.json
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/prisma ./prisma
COPY --from=deps --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]
