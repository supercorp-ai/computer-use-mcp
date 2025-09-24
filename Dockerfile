FROM node:22-bookworm-slim

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    ffmpeg \
    xdotool \
    libgtk-3-0 \
    libnss3 \
    libatk-bridge2.0-0 \
    libxss1 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

RUN echo '#!/usr/bin/env bash\nexec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@"' \
      > /usr/local/bin/chromium-wrapper \
    && chmod +x /usr/local/bin/chromium-wrapper

EXPOSE 8000

ENTRYPOINT ["node", "dist/index.js"]
