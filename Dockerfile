# ── Base: Node + Puppeteer deps ───────────────────────────────────────────
FROM node:20-slim AS base

# Puppeteer system dependencies
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libgdk-pixbuf2.0-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

# ── App: Next.js server ───────────────────────────────────────────────────
FROM base AS app
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]

# ── Worker: BullMQ worker process ────────────────────────────────────────
FROM base AS worker
ENV NODE_ENV=production
CMD ["node", "dist/worker/index.js"]