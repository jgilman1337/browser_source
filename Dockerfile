# Use debian slim for glibc compatibility (essential for Chrome)
FROM debian:trixie-slim

# Pipeline packages. Chrome is the Puppeteer zip (not apt); only the .so files
# that binary links — and that xvfb/ffmpeg/pulseaudio do not already pull — are listed.
# libcups2: Chrome is linked against CUPS. Without libcups.so.2 it will not start.
RUN apt-get update && apt-get install -y --no-install-recommends \
	curl \
	unzip \
	ca-certificates \
	xvfb \
	xauth \
	ffmpeg \
	mesa-va-drivers \
	libegl1 \
	libgbm1 \
	pulseaudio \
	fonts-liberation \
	libnss3 \
	libatk-bridge2.0-0 \
	libcups2 \
	libxcomposite1 \
	libxdamage1 \
	&& rm -rf /var/lib/apt/lists/* \
	&& ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_nvenc \
	&& ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_vaapi \
	&& ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_qsv

# NVENC runtime: host NVIDIA driver libs are injected when running with --gpus all.
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility,graphics

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
