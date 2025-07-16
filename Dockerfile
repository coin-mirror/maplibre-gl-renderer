FROM oven/bun:1.2.12 AS builder

WORKDIR /app
COPY package.json bun.lockb tsconfig.json map.html ./

RUN PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium bun install --frozen-lockfile

COPY ./src/ ./src/

# Will create dist folder
RUN bun run build

FROM oven/bun:1.2.12-debian

LABEL org.opencontainers.image.source="https://github.com/coin-mirror/maplibre-gl-renderer"

WORKDIR /app

RUN useradd -m -u 1111 -s /bin/bash appuser \
  && chown -R appuser:appuser /app

# Install Chromium and dependencies (for puppeteer)
RUN apt-get update && apt-get install -y \
  # Basic utilities
  curl \
  procps \
  psmisc \
  # X11 and display
  xvfb \
  xauth \
  x11-utils \
  # Chromium and dependencies
  chromium \
  # Core dependencies
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
  # Additional stability packages
  libxss1 \
  libgconf-2-4 \
  libxrandr2 \
  libasound2 \
  libpangocairo-1.0-0 \
  libatk1.0-0 \
  libcairo-gobject2 \
  libgtk-3-0 \
  libgdk-pixbuf2.0-0 \
  # Font packages
  fonts-liberation \
  fonts-dejavu-core \
  fontconfig \
  # Networking
  libnss3 \
  libcups2 \
  # WebGL specific packages
  mesa-utils \
  libgl1-mesa-dri \
  libgl1-mesa-glx \
  libglu1-mesa \
  # Memory management and stability
  && echo 'vm.overcommit_memory = 1' >> /etc/sysctl.conf \
  && echo 'net.core.somaxconn = 1024' >> /etc/sysctl.conf \
  # Clean up to reduce image size
  && rm -rf /var/lib/apt/lists/* \
  && apt-get clean

# Copy built application
COPY --from=builder --chown=appuser:appuser /app/dist /app/dist
COPY --from=builder --chown=appuser:appuser /app/package.json /app/map.html /app/

# Set environment variables for stability and performance
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
  NODE_ENV=production \
  DISPLAY=:99 \
  # Performance and stability settings
  NODE_OPTIONS="--max-old-space-size=2048" \
  # Disable unnecessary features
  PUPPETEER_DISABLE_DEV_SHM_USAGE=true \
  # Chromium flags for stability
  CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage" \
  # Memory settings
  UV_THREADPOOL_SIZE=4

# Switch to non-root user
USER appuser

# Expose the application port
EXPOSE 3000

# Health check with improved reliability
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Copy and set up entrypoint
COPY --chown=appuser:appuser entrypoint.sh /app/
RUN chmod +x /app/entrypoint.sh

# Use tini for proper signal handling (if available) or fallback to bash
ENTRYPOINT ["/app/entrypoint.sh"]
