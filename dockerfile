FROM node:18-slim

# Metadata
LABEL maintainer="scraper-cd"
LABEL description="Scraper professionale per Componenti Digitali"
LABEL version="3.0.0"

# Installa dipendenze necessarie per Chromium e sistema
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Install Playwright Chromium
RUN npx playwright install chromium

# Copy application files
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p /data/output/images \
    /data/logs \
    /data/backups \
    /tmp/output/images && \
    chmod -R 755 /data

# Environment variables
ENV NODE_ENV=production \
    RENDER=true \
    PORT=10000 \
    DATA_DIR=/data \
    TZ=Europe/Rome

# Expose port
EXPOSE 10000

# Health check - ogni 30 secondi verifica che il server risponda
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:10000/healthz || exit 1

# Non-root user per sicurezza
RUN useradd -m -u 1000 scraper && \
    chown -R scraper:scraper /app /data /tmp

USER scraper

# Entry point with graceful shutdown
ENTRYPOINT ["node"]
CMD ["server.js"]
