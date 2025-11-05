#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { Socket } from 'node:net'
import { once } from 'node:events'
import { promises as fs, constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import express, { type Application, type NextFunction, type Request, type Response as ExpressResponse } from 'express'
import puppeteer, { executablePath, type Browser as PuppeteerBrowser, type Page as PuppeteerPage } from 'rebrowser-puppeteer'
import type { Browser as PlaywrightBrowser, BrowserContext as PlaywrightBrowserContext, Page as PlaywrightPage } from 'playwright'
import { hideBin } from 'yargs/helpers'
import yargs from 'yargs'
import { z } from 'zod'

import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { actionSchema, ComputerAction, looseActionInputSchema, ToolSchemaMode } from './lib/actions.js'

// -----------------------------------------------------------------------------
// Configuration Types
// -----------------------------------------------------------------------------
type ImageOutputFormat = 'mcp-spec' | 'openai-responses-api'
type StreamTarget = 'local' | 'mediamtx'
type BrowserBackend = PuppeteerBrowser | PlaywrightBrowser
type BrowserPage = PuppeteerPage | PlaywrightPage
type PlaywrightModule = typeof import('playwright')

interface Config {
  port: number
  transport: 'sse' | 'stdio' | 'http'
  automationDriver: 'puppeteer' | 'playwright'
  stealth: boolean
  displayWidth: number
  displayHeight: number
  environment: 'browser'
  headless: boolean
  defaultUrl?: string
  toolsPrefix: string
  toolSchema: ToolSchemaMode
  publicBaseUrl?: string
  streamPath: string
  streamDefaults: { fps: number; quality: number }
  streamEnabled: boolean
  streamFunctions: boolean
  streamTarget: StreamTarget;               // 'local' | 'mediamtx'
  mtxRtspUrl?: string;                      // e.g. rtsp://mediamtx:8554/computer_use
  mtxHlsUrl?: string;                       // optional override play URL (https://.../index.m3u8)
  mtxFps: number;                           // e.g. 25
  mtxBitrateK: number;                      // e.g. 2500
  audioSource: 'none' | 'anullsrc' | 'pulse'; // how to provide audio
  previewPath?: string
  chromePath?: string
  ffmpegPath: string
  xvfbPath: string
  displayBase: number
  pointerTool?: string
  blankPageUrl: string
  imageOutputFormat: ImageOutputFormat
  postActionDelayMs: number
  actionScreenshotMode: 'auto' | 'manual'
}

interface ActionResult {
  screenshot?: { buffer: Buffer; contentType: string }
  description: string
}

type HlsRecorder = {
  process: ChildProcess
  dir: string
  options: { fps: number; quality: number }
}

type RtspPublisher = {
  process: ChildProcess
  rtspUrl: string
  opts: { fps: number; bitrateK: number; audioSource: 'none'|'anullsrc'|'pulse' }
  heartbeatInterval?: NodeJS.Timeout
  restartCount: number
  lastRestartTime: number
}

interface ServerContext {
  config: Config
  sessionManager: ComputerSessionManager
  streamManager: StreamManager
}

// -----------------------------------------------------------------------------
// Virtual Display (Xvfb) Management
// -----------------------------------------------------------------------------
class VirtualDisplay {
  private process?: ChildProcess

  constructor(
    private readonly displayNumber: number,
    private readonly width: number,
    private readonly height: number,
    private readonly xvfbPath: string
  ) {}

  async start(): Promise<void> {
    if (this.process) return
    const args = [
      `:${this.displayNumber}`,
      '-screen',
      '0',
      `${this.width}x${this.height}x24`,
      '-nolisten',
      'tcp',
      '-dpi',
      '96',
      '-ac',
    ]
    const child = spawn(this.xvfbPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.process = child
    this.process.stderr?.on('data', data => {
      const text = data.toString()
      if (text.trim()) {
        console.debug(`[computer-mcp] [Xvfb :${this.displayNumber}] ${text.trim()}`)
      }
    })
    this.process.on('exit', (code, signal) => {
      console.debug(`[computer-mcp] Xvfb :${this.displayNumber} exited (code=${code ?? 'n/a'}, signal=${signal ?? 'n/a'})`)
      this.process = undefined
    })
    const errorPromise = new Promise<never>((_, reject) => {
      child.once('error', err => {
        reject(new Error(`Failed to launch Xvfb (${this.xvfbPath}): ${err instanceof Error ? err.message : String(err)}`))
      })
    })
    try {
      await Promise.race([this.waitForSocket(), errorPromise])
    } catch (err) {
      await this.stop().catch(() => {})
      throw err
    }
  }

  get displayEnv(): string {
    return `:${this.displayNumber}`
  }

  async stop(): Promise<void> {
    if (!this.process) return
    try {
      this.process.kill('SIGTERM')
    } catch {}
    try {
      await once(this.process, 'exit')
    } catch {}
    this.process = undefined
  }

  private async waitForSocket(timeoutMs = 5000): Promise<void> {
    const socketPath = `/tmp/.X11-unix/X${this.displayNumber}`
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        await fs.access(socketPath)
        return
      } catch {
        await delay(100)
      }
    }
    throw new Error(`Xvfb :${this.displayNumber} did not start within ${timeoutMs}ms`)
  }
}

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------
const XDOToolKeyAliases: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'Super_L',
  command: 'Super_L',
  meta: 'Super_L',
  win: 'Super_L',
  option: 'alt',
  alt: 'alt',
  shift: 'shift',
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'space',
  spacebar: 'space',
  backspace: 'BackSpace',
  del: 'Delete',
  delete: 'Delete',
  pageup: 'Page_Up',
  pagedown: 'Page_Down',
  page_down: 'Page_Down',
  page_up: 'Page_Up',
  home: 'Home',
  end: 'End',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
}

function normalizeXdotoolKey(rawKey: string): string | null {
  const key = rawKey.trim()
  if (!key) return null
  const aliasLookup = XDOToolKeyAliases[key.toLowerCase()]
  if (aliasLookup) return aliasLookup
  if (key.length === 1) return key
  return key
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function ensureLeadingSlash(path: string): string {
  if (!path.startsWith('/')) return `/${path}`
  return path
}

function normalizeRoutePath(value: string | undefined, fallback: string): string {
  if (!value || !value.trim()) return fallback
  const trimmed = stripTrailingSlash(value.trim())
  const ensured = ensureLeadingSlash(trimmed)
  return ensured === '' ? fallback : ensured
}

function resolveBaseUrl(config: Config): string {
  if (config.publicBaseUrl && config.publicBaseUrl.trim()) {
    return stripTrailingSlash(config.publicBaseUrl.trim())
  }
  return `http://localhost:${config.port}`
}

function humanActionSummary(action: ComputerAction): string {
  switch (action.type) {
    case 'click':
      return `click ${action.button} at (${action.x}, ${action.y})`
    case 'double_click':
      return `double_click left at (${action.x}, ${action.y})`
    case 'drag':
      return `drag through ${action.path.length} points`
    case 'keypress':
      return `keypress ${action.keys.join(' + ')}`
    case 'move':
      return `move pointer to (${action.x}, ${action.y})`
    case 'screenshot':
      return 'screenshot'
    case 'scroll':
      return `scroll by (x:${action.scroll_x}, y:${action.scroll_y})`
    case 'type':
      return `type ${action.text.length} characters`
    case 'wait':
      return 'wait 1000 ms'
  }
  const exhaustive: never = action
  throw new Error(`Unsupported action type: ${(exhaustive as { type: string }).type}`)
}

// -----------------------------------------------------------------------------
// Computer session management (Puppeteer-backed virtual browser)
// -----------------------------------------------------------------------------
class ComputerSession {
  private browser?: BrowserBackend
  private page?: BrowserPage
  private playwrightContext?: PlaywrightBrowserContext
  private playwrightProfileDir?: string
  private puppeteerProfileDir?: string
  private playwrightModule?: PlaywrightModule
  private playwrightLaunchLogged = false
  private readonly typingKeyIntervalMs = 12
  private queue: Promise<unknown> = Promise.resolve()
  private hlsRecorder?: HlsRecorder
  private readonly display: VirtualDisplay
  private rtsp?: RtspPublisher
  private readonly instrumentedPages = new WeakSet<BrowserPage>()
  private readonly instrumentedPlaywrightContexts = new WeakSet<PlaywrightBrowserContext>()
  private readonly onPlaywrightPage = (page: PlaywrightPage) => {
    this.attachPageEventListeners(page)
  }
  private readonly onPuppeteerTarget = async (target: unknown) => {
    if (!target || typeof (target as { type?: () => string }).type !== 'function') {
      return
    }
    let targetType: string | undefined
    try {
      targetType = (target as { type: () => string }).type()
    } catch {
      return
    }
    if (targetType !== 'page') return
    try {
      const pageFn = (target as { page?: () => Promise<unknown> }).page
      if (typeof pageFn !== 'function') return
      const newPage = await pageFn.call(target)
      if (!newPage) return
      this.attachPageEventListeners(newPage as BrowserPage)
    } catch (err) {
      console.warn(`[computer-mcp] (${this.memoryKey}) failed to attach console listeners for new page:`, err)
    }
  }

  constructor(private readonly memoryKey: string, private readonly config: Config, displayNumber: number) {
    this.display = new VirtualDisplay(displayNumber, config.displayWidth, config.displayHeight, config.xvfbPath)
  }

  async perform(action: ComputerAction): Promise<ActionResult> {
    const description = humanActionSummary(action)
    const screenshot = await this.enqueue(async () => {
      await this.ensureEnvironment()
      await this.applyAction(this.page, action)

      const shouldDelay =
        this.config.postActionDelayMs > 0 &&
        !['wait', 'screenshot'].includes(action.type)
      if (shouldDelay) {
        await delay(this.config.postActionDelayMs)
      }

      const shouldCapture =
        action.type === 'screenshot' || this.config.actionScreenshotMode === 'auto'
      if (!shouldCapture) return undefined

      return await this.captureDisplay()
    })
    return { screenshot, description }
  }

  async close() {
    await this.enqueue(async () => {
      await this.stopHlsRecorder()
      await this.stopRtspPublisher()
      if (this.config.automationDriver === 'playwright') {
        try {
          await this.playwrightContext?.close()
        } catch {}
        this.playwrightContext = undefined
        if (this.playwrightProfileDir) {
          try {
            await fs.rm(this.playwrightProfileDir, { recursive: true, force: true })
          } catch {}
          this.playwrightProfileDir = undefined
        }
      } else {
        try {
          await (this.page as PuppeteerPage | undefined)?.close()
        } catch {}
        if (this.puppeteerProfileDir) {
          try {
            await fs.rm(this.puppeteerProfileDir, { recursive: true, force: true })
          } catch {}
          this.puppeteerProfileDir = undefined
        }
      }
      this.page = undefined
      try {
        await this.browser?.close()
      } catch {}
      this.browser = undefined
      await this.display.stop()
      this.playwrightLaunchLogged = false
    })
  }

  private async moveSystemPointer(x: number, y: number) {
    await this.runXdotool(['mousemove', `${Math.round(x)}`, `${Math.round(y)}`])
  }

  private async runXdotool(args: string[]) {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn('xdotool', args, {
        env: { ...process.env, DISPLAY: this.display.displayEnv },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      proc.stderr?.on('data', data => { stderr += data.toString() })
      proc.on('error', reject)
      proc.on('exit', code => {
        if (code === 0) resolve()
        else reject(new Error(stderr.trim() || `xdotool exited with code ${code}`))
      })
    }).catch(err => {
      console.warn(`[computer-mcp] (${this.memoryKey}) xdotool ${args.join(' ')} failed:`, err)
    })
  }

  private normalizeVideoOptions(options: { fps: number; quality: number }): { fps: number; quality: number } {
    const fps = Math.max(1, Math.min(30, Math.round(options.fps)))
    const quality = Math.max(10, Math.min(100, Math.round(options.quality)))
    return { fps, quality }
  }

  private buildKeySequenceForChar(char: string): string[][] | null {
    if (!char) return null
    if (char === '\r') return []
    const lower = char.toLowerCase()
    const baseKeyMap: Record<string, string> = {
      ' ': 'space',
      '\n': 'Return',
      '\t': 'Tab',
      '-': 'minus',
      '=': 'equal',
      '[': 'bracketleft',
      ']': 'bracketright',
      '\\': 'backslash',
      ';': 'semicolon',
      '\'': 'apostrophe',
      ',': 'comma',
      '.': 'period',
      '/': 'slash',
      '`': 'grave',
    }
    const shiftedKeyMap: Record<string, string> = {
      '!': '1',
      '@': '2',
      '#': '3',
      '$': '4',
      '%': '5',
      '^': '6',
      '&': '7',
      '*': '8',
      '(': '9',
      ')': '0',
      '_': 'minus',
      '+': 'equal',
      '{': 'bracketleft',
      '}': 'bracketright',
      '|': 'backslash',
      ':': 'semicolon',
      '"': 'apostrophe',
      '<': 'comma',
      '>': 'period',
      '?': 'slash',
      '~': 'grave',
    }

    if (char >= 'a' && char <= 'z') {
      return [
        ['keydown', char],
        ['keyup', char],
      ]
    }
    if (char >= '0' && char <= '9') {
      return [
        ['keydown', char],
        ['keyup', char],
      ]
    }
    if (char >= 'A' && char <= 'Z') {
      const key = lower
      return [
        ['keydown', 'Shift_L'],
        ['keydown', key],
        ['keyup', key],
        ['keyup', 'Shift_L'],
      ]
    }
    if (char in shiftedKeyMap) {
      const key = shiftedKeyMap[char]
      return [
        ['keydown', 'Shift_L'],
        ['keydown', key],
        ['keyup', key],
        ['keyup', 'Shift_L'],
      ]
    }
    const baseKey = baseKeyMap[char]
    if (baseKey) {
      return [
        ['keydown', baseKey],
        ['keyup', baseKey],
      ]
    }
    return null
  }

  private async typeWithXdotool(text: string) {
    for (const char of text) {
      const sequence = this.buildKeySequenceForChar(char)
      if (sequence === null) {
        await this.runXdotool(['type', '--delay', '0', '--', char])
        await delay(this.typingKeyIntervalMs)
        continue
      }
      if (sequence.length === 0) continue
      for (const args of sequence) {
        await this.runXdotool(args)
        await delay(this.typingKeyIntervalMs)
      }
    }
  }

  private async ensureEnvironment(): Promise<void> {
    await this.display.start()
    if (!this.browser || !this.page || this.page.isClosed()) {
      await this.launchBrowser()
    }
  }

  async ensureRtspPublisher(
    rtspUrl: string,
    opts: { fps: number; bitrateK: number; audioSource: 'none' | 'anullsrc' | 'pulse' }
  ) {
    await this.ensureEnvironment()
    if (
      this.rtsp &&
      this.rtsp.rtspUrl === rtspUrl &&
      this.rtsp.opts.fps === opts.fps &&
      this.rtsp.opts.bitrateK === opts.bitrateK &&
      this.rtsp.opts.audioSource === opts.audioSource
    ) {
      return
    }
    await this.stopRtspPublisher().catch(() => {})

    const inputTarget = `${this.display.displayEnv}+0,0`

    // NOTE: only change is the position of -draw_mouse (must be before -i)
    const vIn = [
      '-f', 'x11grab',
      '-video_size', `${this.config.displayWidth}x${this.config.displayHeight}`,
      '-draw_mouse', '1',
      '-i', inputTarget,
    ]

    const aIn =
      opts.audioSource === 'pulse'    ? ['-f','pulse','-i','default'] :
      opts.audioSource === 'anullsrc' ? ['-f','lavfi','-i','anullsrc=r=48000:cl=stereo'] :
      []

    const ffArgs = [
      '-loglevel','error','-nostdin',
      ...vIn, ...aIn,
      '-c:v','libx264','-preset','veryfast','-tune','zerolatency',
      '-profile:v','baseline','-level','3.1','-pix_fmt','yuv420p',
      '-r', String(opts.fps),
      '-g', String(opts.fps), '-keyint_min', String(opts.fps), '-sc_threshold','0',
      '-b:v', `${opts.bitrateK}k`,
      '-maxrate', `${Math.round(opts.bitrateK*1.2)}k`,
      '-bufsize', `${Math.round(opts.bitrateK*0.6)}k`,
      ...(aIn.length ? ['-c:a','aac','-b:a','128k','-ar','48000','-ac','2'] : []),
      '-fflags','+genpts',
      '-f','rtsp','-rtsp_transport','tcp', rtspUrl,
    ]

    const env = { ...process.env, DISPLAY: this.display.displayEnv }
    const proc = spawn(this.config.ffmpegPath, ffArgs, { env, stdio: ['ignore','pipe','pipe'] })

    const now = Date.now()
    const publisher: RtspPublisher = {
      process: proc,
      rtspUrl,
      opts,
      restartCount: 0,
      lastRestartTime: now,
    }

    // Monitor stderr for errors (use console.error so it shows in production)
    // NOTE: FFmpeg is silent during normal streaming, stderr only has errors
    proc.stderr?.on('data', d => {
      const t = d.toString().trim()
      if (t) {
        console.error(`[computer-mcp] (${this.memoryKey}) ffmpeg rtsp stderr: ${t}`)
      }
    })

    // Monitor stdout (rarely used by ffmpeg)
    proc.stdout?.on('data', d => {
      const t = d.toString().trim()
      if (t) {
        console.log(`[computer-mcp] (${this.memoryKey}) ffmpeg rtsp stdout: ${t}`)
      }
    })

    // Handle process exit with auto-restart
    proc.on('exit', (code, signal) => {
      console.error(`[computer-mcp] (${this.memoryKey}) ffmpeg rtsp exited (code=${code ?? 'n/a'}, signal=${signal ?? 'n/a'})`)

      if (this.rtsp?.process === proc) {
        clearInterval(this.rtsp.heartbeatInterval)
        this.rtsp = undefined

        // Auto-restart logic with backoff
        const timeSinceLastRestart = Date.now() - publisher.lastRestartTime
        const shouldRestart = publisher.restartCount < 5 || timeSinceLastRestart > 60000 // Reset count after 1min

        if (shouldRestart) {
          const restartDelay = Math.min(1000 * Math.pow(2, publisher.restartCount), 30000) // Exponential backoff, max 30s
          console.warn(`[computer-mcp] (${this.memoryKey}) Restarting ffmpeg rtsp in ${restartDelay}ms (attempt ${publisher.restartCount + 1})`)

          setTimeout(() => {
            this.ensureRtspPublisher(rtspUrl, opts).catch(err => {
              console.error(`[computer-mcp] (${this.memoryKey}) Failed to restart ffmpeg rtsp:`, err)
            })
          }, restartDelay)
        } else {
          console.error(`[computer-mcp] (${this.memoryKey}) ffmpeg rtsp exceeded restart limit (5 attempts), giving up`)
        }
      }
    })

    // Heartbeat monitor: just log that stream is running
    // NOTE: We don't kill on silence because FFmpeg is normally silent during healthy streaming!
    const heartbeatInterval = setInterval(() => {
      // Check if process is still running
      if (proc.exitCode === null && !proc.killed) {
        console.log(`[computer-mcp] (${this.memoryKey}) ffmpeg rtsp heartbeat: streaming (pid=${proc.pid})`)
      }
    }, 30000) // Check every 30s

    publisher.heartbeatInterval = heartbeatInterval
    this.rtsp = publisher

    console.log(`[computer-mcp] (${this.memoryKey}) ffmpeg rtsp publisher started (${opts.fps}fps, ${opts.bitrateK}kbps)`)
  }

  async stopRtspPublisher() {
    const pub = this.rtsp
    if (!pub) return
    this.rtsp = undefined
    if (pub.heartbeatInterval) clearInterval(pub.heartbeatInterval)
    try { pub.process.kill('SIGTERM') } catch {}
    try { await once(pub.process, 'exit') } catch {}
    console.log(`[computer-mcp] (${this.memoryKey}) ffmpeg rtsp publisher stopped`)
  }

  async ensureHlsRecorder(dir: string, options: { fps: number; quality: number }): Promise<void> {
    await this.ensureEnvironment()
    const normalized = this.normalizeVideoOptions(options)
    if (this.hlsRecorder) {
      if (this.hlsRecorder.options.fps === normalized.fps && this.hlsRecorder.options.quality === normalized.quality && this.hlsRecorder.dir === dir) {
        return
      }
      await this.stopHlsRecorder()
    }

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(dir, { recursive: true })

    const bitrate = Math.max(300_000, Math.round((normalized.quality / 100) * 3_000_000))
    const gop = Math.max(1, normalized.fps) * 2
    const inputTarget = `${this.display.displayEnv}+0,0`
    const playlist = path.join(dir, 'index.m3u8')
    const segmentPattern = path.join(dir, 'segment_%05d.ts')

    const args = [
      '-loglevel', 'error',
      '-nostdin',
      '-f', 'x11grab',
      '-video_size', `${this.config.displayWidth}x${this.config.displayHeight}`,
      '-i', inputTarget,
      '-draw_mouse', '1',
      '-vf', 'format=yuv420p',
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-level', '3.0',
      '-b:v', `${bitrate}`,
      '-maxrate', `${Math.round(bitrate * 1.2)}`,
      '-bufsize', `${bitrate * 2}`,
      '-g', `${gop}`,
      '-keyint_min', `${gop}`,
      '-sc_threshold', '0',
      '-hls_time', '2',
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+omit_endlist',
      '-hls_segment_filename', segmentPattern,
      playlist,
    ]

    const env = { ...process.env, DISPLAY: this.display.displayEnv }
    const proc = spawn(this.config.ffmpegPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })

    let stderrLog = ''
    proc.stderr?.on('data', data => {
      const text = data.toString()
      stderrLog += text
      if (text.trim()) {
        console.debug(`[computer-mcp] (${this.memoryKey}) ffmpeg (hls): ${text.trim()}`)
      }
    })

    proc.on('exit', (code, signal) => {
      const msg = stderrLog.trim()
      if (msg) {
        console.error(`[computer-mcp] (${this.memoryKey}) ffmpeg (hls) stderr before exit: ${msg}`)
      }
      console.error(`[computer-mcp] (${this.memoryKey}) ffmpeg (hls) exited (code=${code ?? 'n/a'}, signal=${signal ?? 'n/a'})`)
      if (this.hlsRecorder && this.hlsRecorder.process === proc) {
        this.hlsRecorder = undefined
      }
    })

    // Wait for playlist to appear to avoid races
    await this.waitForHlsManifest(playlist, proc)

    this.hlsRecorder = { process: proc, dir, options: normalized }
  }

  private async waitForHlsManifest(manifestPath: string, proc: ChildProcess, timeoutMs = 8_000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        await fs.access(manifestPath)
        const { size } = await fs.stat(manifestPath)
        if (size > 0) {
          return
        }
      } catch {}
      if (proc.exitCode !== null) {
        throw new Error('ffmpeg exited before HLS manifest was created')
      }
      await delay(100)
    }
    throw new Error('Timed out waiting for HLS manifest to be generated')
  }

  async stopHlsRecorder() {
    const recorder = this.hlsRecorder
    if (!recorder) return
    this.hlsRecorder = undefined
    try {
      recorder.process.kill('SIGTERM')
    } catch {}
    try {
      await once(recorder.process, 'exit')
    } catch {}
    try {
      await fs.rm(recorder.dir, { recursive: true, force: true })
    } catch {}
  }

  private async captureDisplay(): Promise<{ buffer: Buffer; contentType: string }> {
    await this.ensureEnvironment()
    const inputTarget = `${this.display.displayEnv}+0,0`
    const args = [
      '-loglevel', 'error',
      '-nostdin',
      '-f', 'x11grab',
      '-video_size', `${this.config.displayWidth}x${this.config.displayHeight}`,
      '-i', inputTarget,
      '-draw_mouse', '1',
      '-frames:v', '1',
      '-an',
      '-f', 'image2',
      '-vcodec', 'png',
      'pipe:1',
    ]
    const env = { ...process.env, DISPLAY: this.display.displayEnv }
    const proc = spawn(this.config.ffmpegPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))

    let stderr = ''
    proc.stderr?.on('data', data => { stderr += data.toString() })
    const exitCode: number | null = await new Promise(resolve => proc.on('close', resolve))

    if (exitCode !== 0 || chunks.length === 0) {
      throw new Error(`Failed to capture display screenshot (exit=${exitCode ?? 'n/a'}): ${stderr.trim() || 'unknown error'}`)
    }

    return { buffer: Buffer.concat(chunks), contentType: 'image/png' }
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  private attachPlaywrightContextListeners(context: PlaywrightBrowserContext) {
    if (this.instrumentedPlaywrightContexts.has(context)) {
      return
    }
    this.instrumentedPlaywrightContexts.add(context)
    context.on('page', this.onPlaywrightPage)
    for (const page of context.pages()) {
      this.attachPageEventListeners(page)
    }
  }

  private attachPageEventListeners(page: BrowserPage) {
    if (this.instrumentedPages.has(page)) {
      return
    }
    this.instrumentedPages.add(page)

    if (this.config.automationDriver === 'playwright') {
      const playwrightPage = page as PlaywrightPage
      playwrightPage.on('console', message => {
        try {
          this.logBrowserConsoleMessage(message.type(), message.text())
        } catch (err) {
          console.warn(`[computer-mcp] (${this.memoryKey}) failed to log Playwright console message:`, err)
        }
      })
      playwrightPage.on('pageerror', error => {
        console.error(`[computer-mcp] (${this.memoryKey}) [browser] pageerror:`, error)
      })
      playwrightPage.on('requestfailed', request => {
        const failure = request.failure()
        console.warn(
          `[computer-mcp] (${this.memoryKey}) [browser] requestfailed ${request.url()} (${request.method()}): ${failure?.errorText ?? 'unknown error'}`
        )
      })
      return
    }

    const puppeteerPage = page as PuppeteerPage
    puppeteerPage.on('console', message => {
      try {
        this.logBrowserConsoleMessage(message.type(), message.text())
      } catch (err) {
        console.warn(`[computer-mcp] (${this.memoryKey}) failed to log Puppeteer console message:`, err)
      }
    })
    puppeteerPage.on('pageerror', error => {
      console.error(`[computer-mcp] (${this.memoryKey}) [browser] pageerror:`, error)
    })
    puppeteerPage.on('requestfailed', request => {
      const failure = typeof request.failure === 'function' ? request.failure() : undefined
      const method = typeof request.method === 'function' ? request.method() : 'UNKNOWN'
      const url = typeof request.url === 'function' ? request.url() : 'unknown'
      console.warn(
        `[computer-mcp] (${this.memoryKey}) [browser] requestfailed ${url} (${method}): ${failure?.errorText ?? 'unknown error'}`
      )
    })
  }

  private logBrowserConsoleMessage(type: string | undefined, rawText: string | undefined) {
    const normalizedType = type || 'log'
    const prefix = `[computer-mcp] (${this.memoryKey}) [browser console.${normalizedType}]`
    const message = rawText ?? ''
    const output = message ? `${prefix} ${message}` : `${prefix} (no message)`
    switch (normalizedType) {
      case 'error':
        console.error(output)
        break
      case 'warning':
      case 'warn':
        console.warn(output)
        break
      case 'debug':
      case 'trace':
        console.debug(output)
        break
      case 'info':
        console.info(output)
        break
      default:
        console.log(output)
        break
    }
  }

  private async loadPlaywrightModule(): Promise<PlaywrightModule> {
    if (this.config.automationDriver !== 'playwright') {
      throw new Error('Playwright module requested but automationDriver is not "playwright".')
    }
    if (this.playwrightModule) {
      return this.playwrightModule
    }
    const moduleName = this.config.stealth ? 'patchright' : 'playwright'
    try {
      const module = (await import(moduleName)) as PlaywrightModule
      this.playwrightModule = module
      return module
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to load ${moduleName}. Ensure the dependency is installed. ${message}`)
    }
  }

  private async ensurePlaywrightProfileDir(): Promise<string> {
    if (this.playwrightProfileDir) {
      return this.playwrightProfileDir
    }
    // Use /app/user-data in production (containers), /tmp locally
    const baseDir = process.env.FLY_APP_NAME ? '/app/user-data' : os.tmpdir()
    const dir = await fs.mkdtemp(path.join(baseDir, `computer-mcp-playwright-${this.memoryKey}-`))
    this.playwrightProfileDir = dir
    return dir
  }

  private async ensurePuppeteerProfileDir(): Promise<string> {
    if (this.puppeteerProfileDir) {
      return this.puppeteerProfileDir
    }
    // Use /app/user-data in production (containers), /tmp locally
    const baseDir = process.env.FLY_APP_NAME ? '/app/user-data' : os.tmpdir()
    const dir = await fs.mkdtemp(path.join(baseDir, `computer-mcp-puppeteer-${this.memoryKey}-`))
    this.puppeteerProfileDir = dir
    return dir
  }

  private async writeDefaultSearchPreferences(userDataDir: string): Promise<void> {
    const defaultDir = path.join(userDataDir, 'Default')
    await fs.mkdir(defaultDir, { recursive: true })

    const preferencesPath = path.join(defaultDir, 'Preferences')

    // Chrome Preferences structure for default search provider
    const preferences = {
      search: {
        suggest_enabled: true
      },
      default_search_provider_data: {
        template_url_data: {
          short_name: 'DuckDuckGo',
          keyword: 'duckduckgo.com',
          url: 'https://duckduckgo.com/?q={searchTerms}',
          suggestions_url: 'https://duckduckgo.com/ac/?q={searchTerms}',
          favicon_url: 'https://duckduckgo.com/favicon.ico',
          new_tab_url: 'https://duckduckgo.com/',
          prepopulate_id: 92,
          safe_for_autoreplace: true,
          date_created: '13334258984390133',
          last_modified: '13334258984390133',
        }
      },
      homepage: 'https://duckduckgo.com/',
      homepage_is_newtabpage: false,
    }

    await fs.writeFile(preferencesPath, JSON.stringify(preferences, null, 2))
  }

  private async launchBrowser() {
    await this.display.start()

    if (this.browser) {
      if (this.config.automationDriver === 'playwright') {
        try {
          await this.playwrightContext?.close()
        } catch {}
        this.playwrightContext = undefined
        if (this.playwrightProfileDir) {
          try {
            await fs.rm(this.playwrightProfileDir, { recursive: true, force: true })
          } catch {}
          this.playwrightProfileDir = undefined
        }
      } else {
        try {
          await (this.page as PuppeteerPage | undefined)?.close()
        } catch {}
      }
      try {
        await this.browser.close()
      } catch {}
      this.browser = undefined
      this.page = undefined
      this.playwrightLaunchLogged = false
    }

    const viewport = { width: this.config.displayWidth, height: this.config.displayHeight }
    const targetUrl = this.config.defaultUrl?.trim() || this.config.blankPageUrl

    const args: string[] = [
      '--start-maximized',
      '--window-position=0,0',
      `--window-size=${viewport.width},${viewport.height}`,
      '--test-type',
    ]

    if (this.config.stealth) {
      args.push('--disable-dev-shm-usage')
    } else {
      args.push(
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-client-side-phishing-detection',
        '--disable-popup-blocking',
        '--disable-default-apps',
        '--disable-translate',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-blink-features=AutomationControlled',
        '--disable-search-engine-choice-screen'
      )
    }

    // Add disk cache dir for better container support
    if (process.env.FLY_APP_NAME) {
      args.push('--disk-cache-dir=/tmp/chrome-cache')
    }

    const requiresNoSandbox = typeof process.geteuid === 'function' && process.geteuid() === 0
    if (requiresNoSandbox) {
      args.push('--no-sandbox')
    }
    const env = { ...process.env, DISPLAY: this.display.displayEnv }

    if (this.config.headless) {
      console.warn('[computer-mcp] Headless mode requested but full-browser streaming requires a headful Chrome window; launching headful anyway.')
    }

    if (this.config.automationDriver === 'playwright') {
      const playwright = await this.loadPlaywrightModule()
      const chromiumSandbox = typeof process.getuid === 'function' && process.getuid() === 0 ? false : undefined

      if (this.config.stealth) {
        // Stealth mode requires persistent context - DuckDuckGo set via Chrome policies (see Dockerfile)
        const userDataDir = await this.ensurePlaywrightProfileDir()
        const context = await playwright.chromium.launchPersistentContext(userDataDir, {
          headless: false,
          executablePath: this.config.chromePath,
          channel: this.config.chromePath ? undefined : 'chrome',
          viewport: null,
          chromiumSandbox,
          env,
          args,
          ignoreDefaultArgs: ['--enable-automation'],
          timeout: 120000, // 120s timeout for testing Xvfb readiness
        })

        const browser = context.browser()
        const pages = context.pages()
        const page = pages.length ? pages[0] : await context.newPage()

        this.playwrightContext = context
        this.browser = browser ?? (context as unknown as BrowserBackend)
        this.page = page
        this.attachPlaywrightContextListeners(context)
        if (!this.playwrightLaunchLogged) {
          const moduleName = this.config.stealth ? 'patchright' : 'playwright'
          let executable: string | undefined
          try {
            executable = this.config.chromePath ?? (typeof playwright.chromium.executablePath === 'function' ? playwright.chromium.executablePath() : undefined)
          } catch {}
          console.log(`[computer-mcp] (${this.memoryKey}) ${moduleName} persistent context ready (${executable ?? 'channel:chrome'})`)
          this.playwrightLaunchLogged = true
        }

        try {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        } catch (err) {
          console.warn(`[computer-mcp] (${this.memoryKey}) failed to open initial url ${targetUrl}:`, err)
        }
        try {
          await page.bringToFront()
        } catch {}
        return
      }

      // Non-stealth Playwright - DuckDuckGo set via Chrome policies (see Dockerfile)
      const userDataDir = await this.ensurePlaywrightProfileDir()
      const context = await playwright.chromium.launchPersistentContext(userDataDir, {
        headless: false,
        executablePath: this.config.chromePath,
        channel: this.config.chromePath ? undefined : 'chrome',
        viewport: null,
        chromiumSandbox,
        env,
        args,
        ignoreDefaultArgs: ['--enable-automation'],
        timeout: 120000, // 120s timeout for testing Xvfb readiness
      })

      const browser = context.browser()
      const pages = context.pages()
      const page = pages.length ? pages[0] : await context.newPage()

      this.browser = browser ?? (context as unknown as BrowserBackend)
      this.playwrightContext = context
      this.page = page
      this.attachPlaywrightContextListeners(context)
      if (!this.playwrightLaunchLogged) {
        const moduleName = this.config.stealth ? 'patchright' : 'playwright'
        let executable: string | undefined
        try {
          executable = this.config.chromePath ?? (typeof playwright.chromium.executablePath === 'function' ? playwright.chromium.executablePath() : undefined)
        } catch {}
        console.log(`[computer-mcp] (${this.memoryKey}) ${moduleName} context ready (${executable ?? 'channel:chrome'})`)
        this.playwrightLaunchLogged = true
      }

      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      } catch (err) {
        console.warn(`[computer-mcp] (${this.memoryKey}) failed to open initial url ${targetUrl}:`, err)
      }
      try {
        await page.bringToFront()
      } catch {}
      return
    }

    // Launch without user data dir - DuckDuckGo set via Chrome policies (see Dockerfile)
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: this.config.chromePath,
      defaultViewport: null,
      args,
      ignoreDefaultArgs: ['--enable-automation'],
      env: { ...process.env, DISPLAY: this.display.displayEnv },
      timeout: 120000, // 120s timeout for testing Xvfb readiness
    })

    this.browser = browser
    const pages = await browser.pages()
    const page = pages.length ? pages[0] : await browser.newPage()
    this.page = page
    for (const existing of pages) {
      this.attachPageEventListeners(existing)
    }
    this.attachPageEventListeners(page)
    browser.on('targetcreated', this.onPuppeteerTarget)
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch (err) {
      console.warn(`[computer-mcp] (${this.memoryKey}) failed to open initial url ${targetUrl}:`, err)
    }
    try {
      await page.bringToFront()
    } catch {}
  }

  private async applyAction(_page: BrowserPage | undefined, action: ComputerAction) {
    switch (action.type) {
      case 'click':
        await this.moveSystemPointer(action.x, action.y)
        await this.runXdotool(['click', this.resolveMouseButton(action.button)])
        return
      case 'double_click':
        await this.moveSystemPointer(action.x, action.y)
        await this.runXdotool(['click', '--repeat', '2', '--delay', '120', '1'])
        return
      case 'drag': {
        const [start, ...rest] = action.path
        if (!start) return
        await this.moveSystemPointer(start.x, start.y)
        await this.runXdotool(['mousedown', '1'])
        for (const point of rest) {
          await this.moveSystemPointer(point.x, point.y)
        }
        await this.runXdotool(['mouseup', '1'])
        return
      }
      case 'keypress': {
        const normalized = action.keys.map(normalizeXdotoolKey).filter(Boolean) as string[]
        if (!normalized.length) return
        await this.runXdotool(['key', '--clearmodifiers', normalized.join('+')])
        return
      }
      case 'move':
        await this.moveSystemPointer(action.x, action.y)
        return
      case 'screenshot':
        return
      case 'scroll':
        await this.moveSystemPointer(action.x, action.y)
        await this.performScroll(action.scroll_x, action.scroll_y)
        return
      case 'type':
        await this.typeWithXdotool(action.text)
        return
      case 'wait':
        await delay(1000)
        return
      default:
        throw new Error(`Unsupported action type: ${(action as { type: string }).type}`)
    }
  }

  private resolveMouseButton(button: 'left' | 'right' | 'wheel' | 'back' | 'forward'): string {
    switch (button) {
      case 'left':
        return '1'
      case 'right':
        return '3'
      case 'wheel':
        return '2'
      case 'back':
        return '8'
      case 'forward':
        return '9'
      default:
        return '1'
    }
  }

  private async performScroll(scrollX: number, scrollY: number) {
    const normalize = (value: number) => Math.min(100, Math.max(0, Math.round(Math.abs(value)) || (value !== 0 ? 1 : 0)))
    const verticalSteps = normalize(scrollY / 120)
    const horizontalSteps = normalize(scrollX / 120)

    if (verticalSteps > 0) {
      const button = scrollY < 0 ? '4' : '5'
      await this.runXdotool(['click', '--repeat', String(verticalSteps), '--delay', '20', button])
    }

    if (horizontalSteps > 0) {
      const button = scrollX < 0 ? '6' : '7'
      await this.runXdotool(['click', '--repeat', String(horizontalSteps), '--delay', '20', button])
    }
  }
}

class ComputerSessionManager {
  private session: ComputerSession | undefined
  private nextDisplay: number

  constructor(private readonly config: Config) {
    this.nextDisplay = config.displayBase
  }

  private createSession(): ComputerSession {
    return new ComputerSession('default', this.config, this.nextDisplay++)
  }

  get(): ComputerSession {
    if (!this.session) {
      this.session = this.createSession()
    }
    return this.session
  }

  peek(): ComputerSession | undefined {
    return this.session
  }

  async release(): Promise<void> {
    if (!this.session) return
    const current = this.session
    this.session = undefined
    await current.close().catch(err => {
      console.error('[computer-mcp] failed to close session:', err)
    })
  }

  async closeAll() {
    if (!this.session) return
    await this.session.close().catch(err => {
      console.error('[computer-mcp] failed to close session:', err)
    })
    this.session = undefined
  }
}

// -----------------------------------------------------------------------------
// Stream manager (HLS over HTTP)
// -----------------------------------------------------------------------------
interface StreamRequest {
  streamId: string
  fps: number
  quality: number
  createdAt: number
  dir: string
  closed: boolean
}

class StreamManager {
  private current?: StreamRequest         // used only for local HLS
  private readonly baseUrlFactory: () => string
  private readonly hlsRoot: string

  constructor(
    private readonly config: Config,
    private readonly sessionManager: ComputerSessionManager,
    options: { baseUrlFactory: () => string }
  ) {
    this.baseUrlFactory = options.baseUrlFactory
    this.hlsRoot = path.join(os.tmpdir(), 'computer-mcp-hls')
    fs.mkdir(this.hlsRoot, { recursive: true }).catch(() => {})
  }

  attachRoutes(app: Application) {
    // Routes are only useful for local HLS. Keeping them doesn’t hurt for mediamtx (they’ll just 404).
    app.get(`${this.config.streamPath}/:id/index.m3u8`, async (req: Request, res: ExpressResponse) => {
      try {
        const stream = this.current
        if (!stream || stream.closed || req.params.id !== stream.streamId) {
          res.status(404).json({ error: 'Stream not found' })
          return
        }
        const playlistPath = path.join(stream.dir, 'index.m3u8')
        const data = await fs.readFile(playlistPath, 'utf8')
        res.setHeader('Cache-Control', 'no-store')
        res.type('application/vnd.apple.mpegurl').send(data)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[computer-mcp] HLS playlist error:', message)
        res.status(500).json({ error: 'Failed to read playlist' })
      }
    })

    app.get(`${this.config.streamPath}/:id/:segment`, async (req: Request, res: ExpressResponse) => {
      try {
        const stream = this.current
        if (!stream || stream.closed || req.params.id !== stream.streamId) {
          res.status(404).json({ error: 'Stream not found' })
          return
        }
        const segmentName = req.params.segment
        if (!/^[\w\-\.]+$/.test(segmentName)) {
          res.status(400).json({ error: 'Invalid segment name' })
          return
        }
        const segmentPath = path.join(stream.dir, segmentName)
        const data = await fs.readFile(segmentPath)
        res.setHeader('Cache-Control', 'no-store')
        res.type(segmentName.endsWith('.ts') ? 'video/MP2T' : 'application/octet-stream').send(data)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[computer-mcp] HLS segment error:', message)
        res.status(404).json({ error: 'Segment not found' })
      }
    })
  }

  // ---------- public API ----------
  async startStream(options?: { fps?: number; quality?: number }) {
    return this.config.streamTarget === 'mediamtx'
      ? this.startMediaMtxHls()
      : this.startLocalHls(options)
  }

  async getStream(options?: { fps?: number; quality?: number }) {
    if (this.config.streamTarget === 'mediamtx') {
      return this.startMediaMtxHls() // idempotent: re-ensures publisher, returns URL
    }
    return this.startLocalHls(options)
  }

  async stopStream(_streamId?: string) {
    if (this.config.streamTarget === 'mediamtx') {
      const session = this.sessionManager.peek()
      if (session) await session.stopRtspPublisher()
      return { stopped: true, streamId: 'mediamtx' }
    }
    const stream = this.current
    if (!stream || stream.closed) return { stopped: false }
    stream.closed = true
    this.current = undefined
    const session = this.sessionManager.peek()
    if (session) await session.stopHlsRecorder()
    try { await fs.rm(stream.dir, { recursive: true, force: true }) } catch {}
    return { stopped: true, streamId: stream.streamId }
  }

  async stopAll() { await this.stopStream() }

  getActiveStreamSummary(): { streamId: string; url: string } | undefined {
    if (this.config.streamTarget === 'mediamtx') {
      const url = this.resolveMediaMtxHlsUrl()
      return url ? { streamId: 'mediamtx', url } : undefined
    }
    const stream = this.current
    if (stream && !stream.closed) return { streamId: stream.streamId, url: this.streamUrl(stream.streamId) }
    return undefined
  }

  // ---------- implementations ----------
  private async startLocalHls(options?: { fps?: number; quality?: number }) {
    const existing = this.current
    if (existing && !existing.closed) {
      if (options?.fps !== undefined) existing.fps = options.fps
      if (options?.quality !== undefined) existing.quality = options.quality
      return { streamId: existing.streamId, url: this.streamUrl(existing.streamId), created: false }
    }

    const streamId = 'default'
    const dir = path.join(this.hlsRoot, streamId)
    const session = this.sessionManager.get()
    await session.ensureHlsRecorder(dir, {
      fps: options?.fps ?? this.config.streamDefaults.fps,
      quality: options?.quality ?? this.config.streamDefaults.quality,
    })

    const stream: StreamRequest = {
      streamId,
      fps: options?.fps ?? this.config.streamDefaults.fps,
      quality: options?.quality ?? this.config.streamDefaults.quality,
      createdAt: Date.now(),
      dir,
      closed: false,
    }
    this.current = stream
    return { streamId, url: this.streamUrl(streamId), created: true }
  }

  private async startMediaMtxHls() {
    if (!this.config.mtxRtspUrl) {
      throw new Error('mtxRtspUrl is required for streamTarget=mediamtx')
    }
    const session = this.sessionManager.get()
    await session.ensureRtspPublisher(this.config.mtxRtspUrl, {
      fps: this.config.mtxFps,
      bitrateK: this.config.mtxBitrateK,
      audioSource: this.config.audioSource,
    })
    const url = this.resolveMediaMtxHlsUrl()
    return { streamId: 'mediamtx', url, created: true }
  }

  // ---------- helpers ----------
  private streamUrl(streamId: string): string {
    return `${this.baseUrlFactory()}${this.config.streamPath}/${streamId}/index.m3u8`
  }

  private resolveMediaMtxHlsUrl(): string {
    if (this.config.mtxHlsUrl && this.config.mtxHlsUrl.trim()) return this.config.mtxHlsUrl.trim()
    // fallback: rtsp://host:8554/path  ->  https://host:8888/path/index.m3u8
    return this.config.mtxRtspUrl!
      .replace(/^rtsp:\/\//i, 'https://')
      .replace(':8554/', ':8888/')
      .replace(/\/$/, '') + '/index.m3u8'
  }
}

// -----------------------------------------------------------------------------
// MCP Server registration
// -----------------------------------------------------------------------------
function buildComputerCallResult(
  _action: ComputerAction,
  base64Image: string,
  mimeType: string,
  format: ImageOutputFormat
) {
  if (format === 'openai-responses-api') {
    // OpenAI Responses API: input_image object
    return {
      structuredContent: {
        content: [
          {
            type: 'input_image' as const,
            image_url: `data:${mimeType};base64,${base64Image}`,
            // detail/file_id omitted intentionally
          },
        ],
      },
      content: [
        {
          type: 'text' as const,
          text: 'Here’s a screenshot.',
        },
      ],
    }
  }

  // Default MCP spec content
  return {
    content: [
      {
        type: 'image' as const,
        data: base64Image,
        mimeType: mimeType || 'image/png',
      },
    ],
  }
}

function buildStreamResult(payload: Record<string, unknown>) {
  return {
    structuredContent: payload,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}

function createComputerUseServer(context: ServerContext): McpServer {
  const { config, sessionManager, streamManager } = context
  const server = new McpServer({
    name: 'Computer MCP Server',
    version: '1.0.0',
  })

  const handleComputerCall = async ({ action }: { action: ComputerAction }) => {
    console.log(`[computer-mcp] action -> ${humanActionSummary(action)}`)
    const session = sessionManager.get()
    const result = await session.perform(action)

    if (!result.screenshot) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Done.',
          },
        ],
      }
    }

    const base64Image = result.screenshot.buffer.toString('base64')
    return buildComputerCallResult(action, base64Image, result.screenshot.contentType, config.imageOutputFormat)
  }

  if (config.toolSchema === 'strict') {
    server.registerTool(
      `${config.toolsPrefix}call`,
      {
        description: 'Perform an action on the virtual computer and return a screenshot.',
        inputSchema: { action: actionSchema },
      },
      handleComputerCall
    )
  } else {
    server.registerTool(
      `${config.toolsPrefix}call`,
      {
        description: 'Perform an action on the virtual computer and return a screenshot.',
        inputSchema: { action: looseActionInputSchema },
      },
      handleComputerCall
    )
  }

  if (config.streamFunctions) {
    server.tool(
      `${config.toolsPrefix}start_stream`,
      'Begin an HLS stream for the current session. Returns a URL to view the live browser.',
      {
        fps: z.number().int().min(1).max(30).optional(),
        quality: z.number().int().min(10).max(100).optional(),
        // TODO: remove optional comment workaround once MCP SDK bug is fixed
        comment: z.string().optional(),
      },
      async (args) => {
        const stream = await streamManager.startStream({ fps: args.fps, quality: args.quality })
        return buildStreamResult({
          type: 'computer_stream_started',
          stream_id: stream.streamId,
          stream_url: stream.url,
          stream_mime_type: 'application/vnd.apple.mpegurl',
          created: stream.created,
        })
      }
    )

    server.tool(
      `${config.toolsPrefix}get_stream`,
      'Ensure an HLS stream is active and return its URL.',
      {
        fps: z.number().int().min(1).max(30).optional(),
        quality: z.number().int().min(10).max(100).optional(),
        comment: z.string().optional(),
      },
      async (args) => {
        const stream = await streamManager.getStream({ fps: args.fps, quality: args.quality })
        return buildStreamResult({
          type: 'computer_stream_ready',
          stream_id: stream.streamId,
          stream_url: stream.url,
          stream_mime_type: 'application/vnd.apple.mpegurl',
          created: stream.created,
        })
      }
    )

    server.tool(
      `${config.toolsPrefix}stop_stream`,
      'Stop the active HLS stream for the current session.',
      {
        streamId: z.string().optional(),
        comment: z.string().optional(),
      },
      async (args) => {
        const stopped = await streamManager.stopStream(args.streamId)
        return buildStreamResult({
          type: 'computer_stream_stopped',
          stopped: stopped.stopped,
          stream_id: stopped.streamId,
        })
      }
    )
  }

  return server
}

// -----------------------------------------------------------------------------
// Transport helpers
// -----------------------------------------------------------------------------
function httpRequestMetadata(req: Request) {
  return {
    method: req.method,
    path: req.originalUrl || req.url,
    sessionId: req.headers['mcp-session-id'] ?? null,
    contentType: req.headers['content-type'] ?? null,
    contentLength: req.headers['content-length'] ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    remote: req.ip,
  }
}

function logHttpEvent(req: Request, message: string, extra?: Record<string, unknown>) {
  const meta = httpRequestMetadata(req)
  const { method, path, ...rest } = meta
  const payload = extra ? { ...rest, ...extra } : rest
  console.log(`[computer-mcp] [http] ${method} ${path} ${message}`, payload)
}

function registerPreviewPage(app: Application, streams: StreamManager, routePath: string) {
  app.get(routePath, (_req: Request, res: ExpressResponse) => {
    const defaultStream = streams.getActiveStreamSummary()
    const initialUrl = defaultStream?.url || ''
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Computer Stream Preview</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js"></script>
    <style>
      :root { color-scheme: dark light; }
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #111; color: #f7f7f7; }
      main { max-width: 960px; margin: 0 auto; }
      h1 { margin-top: 0; font-size: 1.75rem; }
      .viewer { border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; min-height: 360px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.04); overflow: hidden; }
      .viewer video { max-width: 100%; width: 100%; background: black; display: none; border-radius: 8px; }
      .placeholder { opacity: 0.7; text-align: center; padding: 40px 20px; }
      .info { font-size: 0.9rem; opacity: 0.75; margin-top: 12px; }
      a { color: #9cc4ff; }
    </style>
  </head>
  <body>
    <main>
      <h1>Computer Stream Preview</h1>
      <div class="viewer">
        <video id="streamVideo" autoplay playsinline muted controls></video>
        <div id="placeholder" class="placeholder">${defaultStream ? 'Loading shared browser stream…' : 'No active stream. Start one with the MCP tools or enable --stream auto.'}</div>
      </div>
      <p class="info">The preview shows the shared browser stream returned by the MCP server.</p>
    </main>
    <script>
      (function() {
        var initialUrl = ${JSON.stringify(initialUrl)};
        var video = document.getElementById('streamVideo');
        var placeholder = document.getElementById('placeholder');
        var hlsInstance = null;

        function destroyHls() {
          if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
          }
        }

        function setStatus(message) {
          placeholder.textContent = message;
          placeholder.style.display = 'block';
          video.style.display = 'none';
        }

        function playStream(url) {
          destroyHls();
          if (!url) {
            video.removeAttribute('src');
            video.load();
            setStatus('No active stream. Start one with the MCP tools or enable --stream auto.');
            return;
          }

          placeholder.style.display = 'none';
          video.style.display = 'block';

          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            video.play().catch(function() {
              setStatus('Autoplay blocked. Press play on the video to start streaming.');
            });
            return;
          }

          if (window.Hls && window.Hls.isSupported()) {
            hlsInstance = new Hls({ lowLatencyMode: true, backBufferLength: 60, enableWorker: true });
            hlsInstance.on(Hls.Events.ERROR, function(event, data) {
              if (data && data.fatal) {
                var detail = (data && data.details) || (data && data.type) || 'unknown';
                setStatus('Stream error: ' + detail);
                destroyHls();
              }
            });
            hlsInstance.loadSource(url);
            hlsInstance.attachMedia(video);
            hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
              video.play().catch(function() {
                setStatus('Autoplay blocked. Press play on the video to start streaming.');
              });
            });
            return;
          }

          setStatus('HLS playback is not supported in this browser. Try Safari or install an MSE-capable browser.');
        }

        video.addEventListener('error', function() {
          setStatus('Unable to load stream. Ensure the server is hosting HLS segments.');
        });

        if (initialUrl) {
          playStream(initialUrl);
        } else {
          setStatus('No active stream. Start one with the MCP tools or enable --stream auto.');
        }

        window.addEventListener('beforeunload', function() {
          destroyHls();
        });
      })();
    </script>
  </body>
</html>`
    res.type('html').send(html)
  })
}

function registerBlankPage(app: Application) {
  app.get('/blank', (_req: Request, res: ExpressResponse) => {
    res
      .type('html')
      .send('<!doctype html><html><head><meta charset="utf-8" /><title>Blank</title><style>body{margin:0;background:#0e1014;color:#f0f3f7;font-family:system-ui,Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;}span{opacity:0.2;letter-spacing:0.3em;text-transform:uppercase;font-size:12px;}</style></head><body><span>Superstream</span></body></html>')
  })
}

// -----------------------------------------------------------------------------
// Entrypoint
// -----------------------------------------------------------------------------
async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('port', { type: 'number', default: 8000 })
    .option('transport', { type: 'string', choices: ['sse', 'stdio', 'http'], default: 'http' })
    .option('automationDriver', {
      type: 'string',
      choices: ['puppeteer', 'playwright'],
      default: 'puppeteer',
      describe: 'Automation backend used to control the browser.',
    })
    .option('stealth', {
      type: 'boolean',
      default: false,
      describe: 'Enable stealth browser patches (requires --automationDriver puppeteer or playwright).',
    })
    .option('displayWidth', { type: 'number', default: 1280 })
    .option('displayHeight', { type: 'number', default: 720 })
    .option('environment', { type: 'string', default: 'browser' })
    .option('headless', { type: 'boolean', default: false })
    .option('defaultUrl', { type: 'string' })
    .option('toolsPrefix', { type: 'string', default: 'computer_' })
    .option('toolSchema', {
      type: 'string',
      choices: ['strict', 'loose'],
      default: 'strict',
      describe: 'Validation mode for tool input. Use loose to auto-correct common mistakes.',
    })
    .option('publicBaseUrl', { type: 'string' })
    .option('streamFps', { type: 'number', default: 2 })
    .option('streamQuality', { type: 'number', default: 80 })
    .option('streamPath', { type: 'string', default: '/streams' })
    .option('stream', {
      type: 'array',
      string: true,
      describe: 'Enable streaming features (e.g. --stream auto --stream functions).',
    })
    .option('streamTarget', { type: 'string', choices: ['local', 'mediamtx'], default: 'local' })
    .option('mtxRtspUrl', { type: 'string', describe: 'RTSP publish URL for MediaMTX (when --streamTarget mediamtx)' })
    .option('mtxHlsUrl', { type: 'string', describe: 'Explicit HLS playback URL for MediaMTX (optional)' })
    .option('mtxFps', { type: 'number', default: 25 })
    .option('mtxBitrateK', { type: 'number', default: 2500 })
    .option('audioSource', { type: 'string', choices: ['none','anullsrc','pulse'], default: 'anullsrc' })
    .option('previewPath', { type: 'string', describe: 'Mount an HTML preview page at the given path (requires --stream).' })
    .option('chromePath', { type: 'string', describe: 'Path to Chrome/Chromium executable launched by Puppeteer (default: bundled binary).' })
    .option('ffmpegPath', { type: 'string', describe: 'Path to ffmpeg binary used for display capture (default: ffmpeg).' })
    .option('xvfbPath', { type: 'string', describe: 'Path to Xvfb binary used for virtual display (default: Xvfb).' })
    .option('displayStart', { type: 'number', default: 90, describe: 'Base X display number for virtual browser sessions.' })
    .option('imageOutputFormat', {
      type: 'string',
      choices: ['mcp-spec', 'openai-responses-api'],
      default: 'mcp-spec',
      describe: 'Format of screenshot in tool result content.',
    })
    .option('postActionDelayMs', {
      type: 'number',
      default: 1000,
      describe: 'Delay in milliseconds after actions before capturing a screenshot (set to 0 to disable).',
    })
    .option('actionScreenshotMode', {
      type: 'string',
      choices: ['auto', 'manual'],
      default: 'auto',
      describe: 'Screenshot behavior for non-screenshot actions (auto captures every action, manual requires explicit screenshots tool).',
    })
    .help()
    .parseSync()

  if (argv.environment !== 'browser') {
    console.error(`Unsupported environment: ${argv.environment}. Only "browser" is supported.`)
    process.exit(1)
  }

  const streamModeInputs = (argv.stream ?? []).map((mode) => mode.toLowerCase())
  const validStreamModes = new Set(['auto', 'functions'])
  for (const mode of streamModeInputs) {
    if (!validStreamModes.has(mode)) {
      console.error(`Error: unknown --stream mode "${mode}". Expected one of: auto, functions.`)
      process.exit(1)
    }
  }

  const streamModes = new Set(streamModeInputs)
  const streamAutoEnabled = streamModes.has('auto')
  const streamFunctionsEnabled = streamModes.has('functions')
  const streamEnabled = streamAutoEnabled || streamFunctionsEnabled

  if (argv.previewPath && !streamEnabled) {
    console.error('Error: --previewPath requires --stream to be enabled.')
    process.exit(1)
  }

  const streamPath = normalizeRoutePath(argv.streamPath, '/streams')
  // const internalOrigin = `http://127.0.0.1:${argv.port}`
  const blankPageUrl = 'https://superhero.sh/chat'
          // `${internalOrigin}/blank`
  const automationDriver: Config['automationDriver'] =
    typeof argv.automationDriver === 'string' && argv.automationDriver.toLowerCase() === 'playwright'
      ? 'playwright'
      : 'puppeteer'
  const stealth = Boolean(argv.stealth)
  if (stealth && !['playwright', 'puppeteer'].includes(automationDriver)) {
    console.error('Error: --stealth requires --automationDriver puppeteer or playwright.')
    process.exit(1)
  }
  const postActionDelayMs =
    typeof argv.postActionDelayMs === 'number' && Number.isFinite(argv.postActionDelayMs)
      ? Math.max(0, argv.postActionDelayMs)
      : 1000
  const actionScreenshotMode: Config['actionScreenshotMode'] =
    typeof argv.actionScreenshotMode === 'string' && argv.actionScreenshotMode.toLowerCase() === 'manual'
      ? 'manual'
      : 'auto'
  const toolSchema: ToolSchemaMode =
    typeof argv.toolSchema === 'string' && argv.toolSchema.toLowerCase() === 'loose'
      ? 'loose'
      : 'strict'
  const chromePathArg = typeof argv.chromePath === 'string' && argv.chromePath.trim() ? argv.chromePath.trim() : undefined
  const envChromePath = typeof process.env.CHROME_PATH === 'string' && process.env.CHROME_PATH.trim()
    ? process.env.CHROME_PATH.trim()
    : undefined
  let chromeExecutable: string | undefined
  if (chromePathArg) {
    chromeExecutable = chromePathArg
  } else if (envChromePath) {
    chromeExecutable = envChromePath
  } else if (automationDriver === 'playwright') {
    const candidateChromePaths = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-beta',
    ]
    for (const candidate of candidateChromePaths) {
      try {
        await fs.access(candidate, fsConstants.X_OK)
        chromeExecutable = candidate
        break
      } catch {}
    }
  }

  if (!chromeExecutable && automationDriver === 'puppeteer') {
    try {
      chromeExecutable = executablePath()
    } catch (err) {
      console.warn('[computer-mcp] Unable to determine Chrome executable path automatically:', err)
      chromeExecutable = undefined
    }
  }

  const previewRoute = argv.previewPath && argv.previewPath.trim() ? normalizeRoutePath(argv.previewPath.trim(), '/preview') : undefined

  const config: Config = {
    port: argv.port,
    transport: argv.transport as Config['transport'],
    automationDriver,
    stealth,
    displayWidth: argv.displayWidth,
    displayHeight: argv.displayHeight,
    environment: 'browser',
    headless: argv.headless,
    defaultUrl: argv.defaultUrl,
    toolsPrefix: argv.toolsPrefix ?? 'computer_',
    toolSchema,
    publicBaseUrl: argv.publicBaseUrl,
    streamPath,
    streamDefaults: {
      fps: Math.max(1, Math.min(30, argv.streamFps ?? 2)),
      quality: Math.max(10, Math.min(100, argv.streamQuality ?? 80)),
    },
    streamEnabled,
    streamFunctions: streamFunctionsEnabled,
    streamTarget: (argv.streamTarget as StreamTarget) ?? 'local',
    mtxRtspUrl: argv.mtxRtspUrl,
    mtxHlsUrl: argv.mtxHlsUrl,
    mtxFps: Math.max(1, Math.min(60, argv.mtxFps ?? 25)),
    mtxBitrateK: Math.max(200, Math.min(20000, argv.mtxBitrateK ?? 2500)),
    audioSource: (argv.audioSource as 'none'|'anullsrc'|'pulse') ?? 'anullsrc',
    previewPath: previewRoute,
    chromePath: chromeExecutable,
    ffmpegPath: argv.ffmpegPath && argv.ffmpegPath.trim() ? argv.ffmpegPath.trim() : 'ffmpeg',
    xvfbPath: argv.xvfbPath && argv.xvfbPath.trim() ? argv.xvfbPath.trim() : 'Xvfb',
    displayBase: Math.max(1, Math.min(60000, argv.displayStart ?? 90)),
    blankPageUrl,
    imageOutputFormat: (argv.imageOutputFormat as ImageOutputFormat) ?? 'mcp-spec',
    postActionDelayMs,
    actionScreenshotMode,
  }

  console.log('[computer-mcp] startup config', {
    transport: config.transport,
    port: config.port,
    automationDriver: config.automationDriver,
    stealth: config.stealth,
    displayWidth: config.displayWidth,
    displayHeight: config.displayHeight,
    headless: config.headless,
    defaultUrl: config.defaultUrl,
    toolsPrefix: config.toolsPrefix,
    toolSchema: config.toolSchema,
    postActionDelayMs: config.postActionDelayMs,
    actionScreenshotMode: config.actionScreenshotMode,
    streamEnabled: config.streamEnabled,
    streamFunctions: config.streamFunctions,
    streamTarget: config.streamTarget,
    chromePath: config.chromePath,
    ffmpegPath: config.ffmpegPath,
    xvfbPath: config.xvfbPath,
  })

  const baseUrl = resolveBaseUrl(config)
  const sessionManager = new ComputerSessionManager(config)
  const streamManager = new StreamManager(config, sessionManager, { baseUrlFactory: () => baseUrl })

  const context: ServerContext = { config, sessionManager, streamManager }

  const createServer = () => createComputerUseServer(context)

  if (streamAutoEnabled) {
    void streamManager
      .startStream()
      .then((stream) => {
        const location = stream.url ?? `${stream.streamId}`
        console.log(`[computer-mcp] default stream ready (${location})`)
      })
      .catch((err) => {
        console.error('[computer-mcp] failed to start default stream:', err)
      })
  }

  let httpServer: Server | undefined
  const sockets = new Set<Socket>()
  let shuttingDown = false
  let sessionCleanupInterval: NodeJS.Timeout | undefined

  const cleanup = async () => {
    if (shuttingDown) return
    shuttingDown = true
    if (sessionCleanupInterval) {
      clearInterval(sessionCleanupInterval)
      sessionCleanupInterval = undefined
    }
    await streamManager.stopAll()
    await sessionManager.closeAll()
    if (httpServer) {
      for (const socket of sockets) {
        try {
          socket.destroy()
        } catch {}
      }
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()))
      sockets.clear()
      httpServer = undefined
    }
  }

  const handleSignal = (signal: string) => {
    console.log(`[computer-mcp] Received ${signal}, shutting down…`)
    void cleanup().finally(() => process.exit(0))
  }

  process.on('SIGINT', () => handleSignal('SIGINT'))
  process.on('SIGTERM', () => handleSignal('SIGTERM'))

  if (config.transport === 'stdio') {
    const server = createServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.log('[computer-mcp] Listening on stdio')

    const app = express()
    app.get('/healthz', (_req, res) => {
      res.json({ ok: true })
    })
    if (config.streamEnabled || config.previewPath) {
      streamManager.attachRoutes(app)
    }
    registerBlankPage(app)
    if (config.previewPath) {
      registerPreviewPage(app, streamManager, config.previewPath)
    }
    httpServer = app.listen(config.port, () => {
      console.log(`[computer-mcp] Serving media endpoints on port ${config.port}`)
    })
    httpServer.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    return
  }

  const app = express()

  // Attach shared routes first
  app.get('/healthz', (_req: Request, res: ExpressResponse) => {
    res.json({ ok: true })
  })
  if (config.streamEnabled || config.previewPath) {
    streamManager.attachRoutes(app)
  }
  registerBlankPage(app)
  if (config.previewPath) {
    registerPreviewPage(app, streamManager, config.previewPath)
  }

  if (config.transport === 'http') {
    // Allow raw body for root; parse JSON elsewhere
    app.use((req, res, next) => {
      if (req.path === '/') return next()
      express.json()(req, res, next)
    })

    interface HttpSession {
      server: McpServer
      transport: StreamableHTTPServerTransport
      lastActivity: number
    }

    const sessions = new Map<string, HttpSession>()
    const eventStore = new InMemoryEventStore()

    // Session cleanup: remove inactive sessions every minute
    const SESSION_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour
    sessionCleanupInterval = setInterval(() => {
      const now = Date.now()
      const toDelete: string[] = []
      for (const [sessionId, session] of sessions.entries()) {
        if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
          toDelete.push(sessionId)
        }
      }
      for (const sessionId of toDelete) {
        sessions.delete(sessionId)
        console.log(`[computer-mcp] Session ${sessionId} expired (inactive for 1h)`)
      }
      if (toDelete.length > 0) {
        console.log(`[computer-mcp] Cleaned up ${toDelete.length} expired sessions (${sessions.size} remaining)`)
      }
    }, 60000) // Check every minute

    app.post('/', async (req: Request, res: ExpressResponse) => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined
        logHttpEvent(req, 'POST / received', {
          hasSessionHeader: Boolean(sessionId),
          knownSessions: sessions.size,
        })
        if (sessionId && sessions.has(sessionId)) {
          logHttpEvent(req, 'using existing session', { sessionId })
          const session = sessions.get(sessionId)!
          session.lastActivity = Date.now() // Update activity timestamp
          await session.transport.handleRequest(req, res)
          return
        }

        if (sessionId && !sessions.has(sessionId)) {
          logHttpEvent(req, 'initializing new session for provided id', { sessionId })
        }

        const server = createServer()
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId ?? randomUUID(),
          eventStore,
          onsessioninitialized: (newId: string) => {
            sessions.set(newId, { server, transport, lastActivity: Date.now() })
            console.log(`[computer-mcp] [${newId}] HTTP session initialized (shared)`)
          },
        })

        transport.onclose = () => {
          const sid = transport.sessionId
          const entry = sid ? sessions.get(sid) : undefined
          if (sid && entry) {
            sessions.delete(sid)
            console.log(`[computer-mcp] [${sid ?? 'unknown'}] Streamable transport closed`)
          }
          setImmediate(async () => {
            try {
              await server.close()
            } catch (err) {
              console.error(`[computer-mcp] [${sid ?? 'unknown'}] server close error:`, err)
            }
            if (entry) {
              if (!config.streamEnabled) {
                try {
                  await context.streamManager.stopStream()
                } catch (err) {
                  console.error('[computer-mcp] stopStream after close error:', err)
                }
              }
            }
          })
        }

        await server.connect(transport)
        logHttpEvent(req, 'established new session', {})
        await transport.handleRequest(req, res)
      } catch (err) {
        logHttpEvent(req, 'POST / handler failed', { error: err instanceof Error ? err.message : String(err) })
        console.error('[computer-mcp] HTTP POST / error:', err)
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: (req as any)?.body?.id,
          })
        }
      }
    })

    app.get('/', async (req: Request, res: ExpressResponse) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (!sessionId || !sessions.has(sessionId)) {
        logHttpEvent(req, 'GET / rejected: unknown or missing session', {
          sessionId: sessionId ?? null,
          knownSessions: sessions.size,
        })
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: (req as any)?.body?.id,
        })
        return
      }
      try {
        const session = sessions.get(sessionId)!
        session.lastActivity = Date.now() // Update activity timestamp
        logHttpEvent(req, 'GET / streaming response', { sessionId })
        await session.transport.handleRequest(req, res)
      } catch (err) {
        logHttpEvent(req, 'GET / handler failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
        console.error(`[computer-mcp] [${sessionId}] GET / error:`, err)
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: (req as any)?.body?.id,
          })
        }
      }
    })

    app.delete('/', async (req: Request, res: ExpressResponse) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (!sessionId || !sessions.has(sessionId)) {
        logHttpEvent(req, 'DELETE / rejected: unknown or missing session', {
          sessionId: sessionId ?? null,
          knownSessions: sessions.size,
        })
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: (req as any)?.body?.id,
        })
        return
      }
      try {
        const { transport } = sessions.get(sessionId)!
        logHttpEvent(req, 'DELETE / terminating session', { sessionId })
        await transport.handleRequest(req, res)
      } catch (err) {
        logHttpEvent(req, 'DELETE / handler failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
        console.error(`[computer-mcp] [${sessionId}] DELETE / error:`, err)
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Error handling session termination' },
            id: (req as any)?.body?.id,
          })
        }
      }
    })

    app.use((err: unknown, req: Request, res: ExpressResponse, next: NextFunction) => {
      if (res.headersSent) return next(err)
      const message = err instanceof Error ? err.message : String(err)
      const status = err instanceof SyntaxError ? 400 : 500
      logHttpEvent(req, 'express middleware error', {
        status,
        error: message,
      })
      if (req.path === '/' && req.method === 'POST') {
        res.status(status).json({
          jsonrpc: '2.0',
          error: {
            code: status === 400 ? -32700 : -32603,
            message: status === 400 ? 'Bad Request: Invalid JSON payload' : 'Internal server error',
          },
          id: (req as any)?.body?.id,
        })
        return
      }
      res.status(status).json({ error: message })
    })

    httpServer = app.listen(config.port, () => {
      console.log(`[computer-mcp] Listening on port ${config.port} (http)`)
    })
    httpServer.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    return
  }

  // SSE transport
  app.use((req, res, next) => {
    if (req.path === '/message') return next()
    express.json()(req, res, next)
  })

  interface SseSession {
    server: McpServer
    transport: SSEServerTransport
    sessionId: string
  }

  let sessions: SseSession[] = []

  app.get('/', async (req: Request, res: ExpressResponse) => {
    const server = createServer()
    const transport = new SSEServerTransport('/message', res)
    await server.connect(transport)
    const sessionId = transport.sessionId

    sessions.push({ server, transport, sessionId })
    console.log(`[computer-mcp] [${sessionId}] SSE connected (shared)`)

    transport.onclose = async () => {
      const index = sessions.findIndex((s) => s.transport === transport)
      const closed = index >= 0 ? sessions[index] : undefined
      if (index >= 0) sessions.splice(index, 1)
      setImmediate(async () => {
        try {
          await server.close()
        } catch (err) {
          console.error(`[computer-mcp] [${sessionId}] SSE server close error:`, err)
        }
        if (closed) {
          if (!config.streamEnabled) {
            try {
              await context.streamManager.stopStream()
            } catch (err) {
              console.error('[computer-mcp] SSE stopStream error:', err)
            }
          }
        }
      })
      console.log(`[computer-mcp] [${sessionId}] SSE closed`)
    }

    transport.onerror = (err: Error) => {
      console.error(`[computer-mcp] [${sessionId}] SSE error:`, err)
    }

    req.on('close', () => {
      sessions = sessions.filter((s) => s.transport !== transport)
    })
  })

  app.post('/message', async (req: Request, res: ExpressResponse) => {
    const sessionId = req.query.sessionId as string
    if (!sessionId) {
      res.status(400).send({ error: 'Missing sessionId' })
      return
    }
    const target = sessions.find((s) => s.sessionId === sessionId)
    if (!target) {
      res.status(404).send({ error: 'No active session' })
      return
    }
    try {
      await target.transport.handlePostMessage(req, res)
    } catch (err) {
      console.error(`[computer-mcp] [${sessionId}] Error handling /message:`, err)
      res.status(500).send({ error: 'Internal error' })
    }
  })

  httpServer = app.listen(config.port, () => {
    console.log(`[computer-mcp] Listening on port ${config.port} (sse)`)
  })
  httpServer.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
}

main().catch((err) => {
  console.error('[computer-mcp] Fatal error:', err)
  process.exit(1)
})
