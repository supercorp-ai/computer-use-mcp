FROM ghcr.io/puppeteer/puppeteer:24.2.0
WORKDIR /app
USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl gnupg ca-certificates xvfb ffmpeg xdotool \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-linux-signing-keyring.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-linux-signing-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ensure a browser is available to executablePath()
RUN npx --yes puppeteer browsers install chrome
ENV CHROME_PATH=/usr/bin/google-chrome-stable

EXPOSE 8000
ENTRYPOINT ["node", "dist/index.js"]
