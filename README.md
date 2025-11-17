# Computer Use MCP Server

An MCP server that exposes a virtual browser session driven through computer-use actions. By default the server launches Chrome via [Rebrowser Puppeteer](https://github.com/rebrowser/rebrowser-patches) and captures screenshots after each action, giving an LLM client immediate visual feedback. Optional MJPEG/HLS streaming endpoints allow a human to watch the live browser session. A Playwright + [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) path is also available for stealth-friendly sessions.

## Features

- Supports the standard computer-use action set (click, double-click, drag, keypress, move, screenshot, scroll, type, wait).
- Returns `computer_call_output` payloads with a screenshot embedded as a `data:image/png;base64,...` URI for each tool invocation.
- Configurable post-action delay (`--postActionDelayMs`) and screenshot policy (`--actionScreenshotMode auto|manual`).
- Multiple automation backends: Rebrowser Puppeteer (`--automationDriver puppeteer`) or Patchright Playwright (`--automationDriver playwright`). Add `--stealth` to opt into the vendor’s stealth patches.
- Optional HLS streaming with a shared browser window; pass `--stream auto` to launch it automatically and `--stream functions` to expose `start_stream`, `get_stream`, and `stop_stream` MCP tools.
- Works over stdio, SSE, or streamable HTTP transports.
- Configurable viewport size, default URL, and multiple transport modes.
- Supports routing browser traffic through HTTP/SOCKS proxies (including credentials) via `--proxy`.
- Optional preview page (set `--previewPath`) that displays the shared HLS feed.
- Serves a local `/blank` page that guarantees capture-friendly content before the agent navigates elsewhere.
- Powered by Xvfb + ffmpeg so the stream shows the full Chrome window (address bar, tabs, etc.).

## Prerequisites

The server expects the following binaries to be present on the host/container:

- `Xvfb` (virtual X11 display server)
- `ffmpeg` with `libx264` support for HLS output
- `xdotool` (moves the pointer inside the virtual display)
- Google Chrome / Chromium (Puppeteer downloads a test build by default; override with `--chromePath` if needed)


### macOS (development)

```bash
brew install --cask xquartz   # provides /opt/X11/bin/Xvfb
brew install ffmpeg
brew install xdotool

# Launch the server, pointing to the Homebrew Xvfb binary
npm start -- \
  --stream auto \
  --stream functions \
  --previewPath /preview \
  --xvfbPath /opt/X11/bin/Xvfb \
  --ffmpegPath "$(which ffmpeg)"

# or use the convenience script
npm run start:mac
```

### Docker (works on macOS/Linux)

The repository ships with a Dockerfile that installs Chromium, Xvfb, and ffmpeg. Build and run it with:

```bash
npm run start:docker -- --stream auto --stream functions --previewPath /preview
```

The container exposes port `8000`, so you can open `http://localhost:8000/preview` on your host to watch the stream.

### Debian/Ubuntu / Fly.io (Dockerfile snippet)

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb ffmpeg chromium \
      libgtk-3-0 libnss3 libatk-bridge2.0-0 libxss1 libdrm2 libxkbcommon0 libgbm1 libasound2 \
      fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

# Optional: wrap Chromium with additional flags
RUN echo '#!/usr/bin/env bash\nexec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@"' \
      > /usr/local/bin/chromium-wrapper \
 && chmod +x /usr/local/bin/chromium-wrapper

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium-wrapper

# install your app here …

CMD ["npm", "start", "--", "--chromePath", "/usr/local/bin/chromium-wrapper"]
```

Make sure the container exposes `ffmpeg` and `Xvfb` (paths can be overridden with `--ffmpegPath` / `--xvfbPath`).

## Installation

```bash
npm install
npm run build
```

## CLI

```
Usage: computer-use-mcp [options]

Options:
  --port <number>           Port for HTTP/SSE transports and media endpoints (default: 8000)
  --transport <mode>        "stdio", "sse", or "http" (default: "http")
  --displayWidth <number>   Browser viewport width (default: 1280)
  --displayHeight <number>  Browser viewport height (default: 720)
  --environment <string>    Only "browser" is currently supported (default: "browser")
  --headless                Ignored for streaming; Chrome always runs headful so the video shows UI
  --defaultUrl <string>     Optional URL to load when a session starts
  --proxy <url>             Route browser traffic through an HTTP/SOCKS proxy (e.g. http://user:pass@host:15001)
  --toolsPrefix <string>    Prefix added to registered tool names (default: "computer_")
  --publicBaseUrl <url>     Base URL used when constructing screenshot and stream links (default: http://localhost:<port>)
  --streamFps <number>      Default MJPEG stream FPS (1–30, default: 2)
  --streamQuality <number>  Default JPEG quality for streaming (10–100, default: 80)
  --streamPath <path>       Route prefix for HLS streams (default: /streams)
  --stream <mode>           Enable streaming features (modes: auto, functions). Pass multiple times.
  --streamTarget <mode>     Streaming back-end ("local" or "mediamtx", default: local)
  --mtxRtspUrl <url>        RTSP publish URL when using MediaMTX
  --mtxHlsUrl <url>         Optional HLS playback URL when using MediaMTX
  --mtxFps <number>         MediaMTX stream FPS (default: 25)
  --mtxBitrateK <number>    MediaMTX video bitrate in Kbps (default: 2500)
  --audioSource <mode>      Audio source ("none", "anullsrc", or "pulse", default: anullsrc)
  --previewPath <path>      Mount the HTML preview page at the given path (requires --stream)
  --automationDriver <drv>  "puppeteer" (default) or "playwright"
  --stealth                 Enable the driver's stealth patches (works with puppeteer via Rebrowser or playwright via Patchright)
  --chromePath <path>       Chrome/Chromium executable launched by Puppeteer (default: bundled binary)
  --ffmpegPath <path>       ffmpeg binary used for display capture (default: ffmpeg)
  --xvfbPath <path>         Xvfb binary used for the virtual display (default: Xvfb)
  --displayStart <number>   Base X display number allocated to sessions (default: 90)
  --postActionDelayMs <ms>  Delay (in milliseconds) after actions before capturing a screenshot (default: 1000)
  --actionScreenshotMode    "auto" (default) captures every action; "manual" only captures explicit screenshot actions
  -h, --help                Show help
```

Example streaming setups:

- `--stream auto` – start the HLS feed automatically.
- `--stream functions` – keep streaming manual but expose MCP tools.
- Pass both flags to enable automatic streaming and the MCP controls.

## Tools

All tools are registered with the prefix configured through `--toolsPrefix` (default `computer_`).

- `{prefix}call`: Accepts a `computer_call` payload matching the MCP computer-use schema. Executes the action, captures a screenshot, and returns a `computer_call_output` envelope with a Base64 `data:image/png` URL.
- When `--stream functions` is provided, the server also exposes `{prefix}start_stream`, `{prefix}get_stream`, and `{prefix}stop_stream` for managing the shared HLS feed.

### Example actions

```json
{
  "action": {
    "type": "screenshot"
  }
}
```

To navigate, send a keypress to focus the address bar (`{"action":{"type":"keypress","keys":["Control","L"]}}` on Linux/Fly, or `"Meta"` instead of `"Control"` on macOS), followed by a `type` action with the URL, then press `Enter` with another `keypress` action.

## Media Endpoints

Regardless of transport mode, the server binds HTTP routes for media:

- `GET {streamPath}/default/index.m3u8` – Playlist for the shared HLS feed (adjusts with `--streamPath`).
- `GET {previewPath}` – Lightweight HTML page that shows the shared feed (available when `--previewPath` is supplied).
- `GET /blank` – Minimal capture-ready page used as the initial browser target.
- `GET /healthz` – Basic liveness probe.

When you deploy behind a reverse proxy, set `--publicBaseUrl` so returned URLs are externally resolvable.

## Development

- `npm run build` compiles TypeScript to `dist/`.
- `npm run lint` runs ESLint.
- `npm start` launches the compiled server.

The browser session is launched on demand and cleaned up when the process exits (SIGINT/SIGTERM).
