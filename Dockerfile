FROM oven/bun:1-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

ENV HOST=0.0.0.0 \
    COMMERCIALFIND_PORT=10000 \
    DOWNLOAD_DIR=/tmp/downloads \
    YTDLP_PATH=/usr/local/bin/yt-dlp

RUN mkdir -p /tmp/downloads

EXPOSE 10000

CMD ["bun", "run", "server.js"]
