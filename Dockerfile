FROM oven/bun:1 AS builder

WORKDIR /app
COPY package.json bun.lockb tsconfig.json map.html ./

RUN PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium bun install --frozen-lockfile

COPY ./src/ ./src/

FROM oven/bun:1-debian

LABEL org.opencontainers.image.source="https://github.com/coin-mirror/maplibre-gl-renderer"

WORKDIR /app

# Install Chromium and dependencies (for puppeteer)
RUN apt-get update && apt-get install -y \
  chromium \
  libatk-bridge2.0-0 \
  libgtk-3-0 \
  libasound2 \
  libgbm1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libxshmfence1 \
  libx11-xcb1 \
  libxcursor1 \
  libxi6 \
  libxtst6 \
  fonts-liberation \
  libnss3 \
  libcups2 \
  # WebGL spezifische Pakete
  mesa-utils \
  xvfb \
  libgl1-mesa-dri \
  libgl1-mesa-glx \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1111 -s /bin/bash appuser \
  && chown -R appuser:appuser /app

COPY --from=builder --chown=appuser:appuser /app/src /app/src
COPY --from=builder --chown=appuser:appuser /app/node_modules /app/node_modules
COPY --from=builder --chown=appuser:appuser  /app/package.json /app/tsconfig.json /app/map.html /app/

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
  NODE_ENV=production \
  DISPLAY=:99

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

COPY --chown=appuser:appuser entrypoint.sh /app/
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
