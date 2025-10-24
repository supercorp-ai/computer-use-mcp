FROM ghcr.io/puppeteer/puppeteer:24.2.0
WORKDIR /app
USER root

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=0

RUN apt-get update && apt-get install -y --no-install-recommends xvfb ffmpeg xdotool \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ensure a browser is available to executablePath()
RUN npx --yes puppeteer browsers install chrome

EXPOSE 8000
ENTRYPOINT ["node", "dist/index.js"]
