# Multi-stage build: compile with dev dependencies, ship without them.
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
# Migrations are read from disk at boot, so they ship with the image rather than being baked in.
COPY migrations ./migrations
COPY scripts ./scripts

# Run unprivileged. The node image already provides this user.
USER node

EXPOSE 3000

# Liveness only — readiness is checked by the load balancer, which needs to stop routing before
# the process is actually unhealthy.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
