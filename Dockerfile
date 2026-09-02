# Use debian slim for glibc compatibility (essential for Chrome)
FROM debian:bookworm-slim

# Install system dependencies:
# - curl/unzip: Bun install
# - xvfb: virtual display for headful capture
# - ffmpeg: encode (CPU + NVENC/VAAPI/QSV/…) and mux for SRT/RTMP/etc.
# - libva/mesa: VAAPI runtime for Intel/AMD GPU encode in-container
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    xvfb \
    ffmpeg \
    libva2 \
    mesa-va-drivers \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrender1 \
    libxtst6 \
    libnss3 \
    libgbm1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxrandr2 \
    fonts-liberation \
    pulseaudio \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_nvenc \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_vaapi \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_qsv

# NVENC runtime: host NVIDIA driver libs are injected when running with --gpus all.
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Set the configuration path
ENV CONFIG_PATH=/app/config.json
# Shared Chrome cache for bun install postinstall and `puppeteer browsers install`.
ENV PUPPETEER_CACHE_DIR=/root/.cache/puppeteer

# Install production dependencies only — lint/format/typecheck run on the host.
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --production

# Ensure the Chrome binary exists (postinstall can skip download in some environments).
RUN bun x puppeteer browsers install chrome

# Copy the source code
COPY src ./src
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod +x ./scripts/docker-entrypoint.sh

# Set the entrypoint
CMD ["./scripts/docker-entrypoint.sh"]
