# syntax=docker/dockerfile:1

# ---- Abhängigkeiten (nur Laufzeit) ----
FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- Laufzeit-Image ----
FROM node:25-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# Datenverzeichnis gehört dem unprivilegierten Benutzer „node“ (UID 1000).
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server/index.js"]
