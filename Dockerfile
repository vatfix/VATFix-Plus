# Dockerfile — VATFix Plus (TLS-clean, tini, conditional npm install)
FROM node:20-slim

# System deps for TLS + time + init
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata tini \
 && rm -rf /var/lib/apt/lists/*

ENV TZ=Europe/Rome \
    NODE_ENV=production \
    # Crash fast on unhandled promises so Fly restarts instead of wedging
    NODE_OPTIONS=--unhandled-rejections=strict

WORKDIR /app

# Install deps first for layer cache. Support both with/without lockfile.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm i --omit=dev --no-audit --no-fund; \
    fi \
 && npm cache clean --force

# Copy source
COPY server.mjs ./server.mjs
COPY webhook.js ./webhook.js
COPY lib ./lib

# Drop privileges
RUN useradd -m -u 10001 appuser \
 && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

# Use tini as PID1 for clean signals in Fly
ENTRYPOINT ["/usr/bin/tini","--"]

CMD ["node","server.mjs"]
