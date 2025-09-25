#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { Socket } from 'node:net'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import express, { type Application, type NextFunction, type Request, type Response as ExpressResponse } from 'express'
import puppeteer, { executablePath, type Browser, type KeyInput, type MouseButton, type Page } from 'puppeteer'
import { hideBin } from 'yargs/helpers'
import yargs from 'yargs'
import { z } from 'zod'

import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

// -----------------------------------------------------------------------------
// Configuration Types
// -----------------------------------------------------------------------------
interface Config {
  port: number
  transport: 'sse' | 'stdio' | 'http'
  displayWidth: number
  displayHeight: number
  environment: 'browser'
  headless: boolean
  defaultUrl?: string
  toolsPrefix: string
  publicBaseUrl?: string
  streamPath: string
  streamDefaults: { fps: number; quality: number }
  enablePreview: boolean
  chromePath?: string
  ffmpegPath: string
  xvfbPath: string
  displayBase: number
  pointerTool?: string
  blankPageUrl: string
}

interface ActionResult {
  screenshot: { buffer: Buffer; contentType: string }
  description: string
}

type HlsRecorder = {
  process: ChildProcess
  dir: string
  options: { fps: number; quality: number }
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
// Schemas for Computer Use actions
// -----------------------------------------------------------------------------
const clickActionSchema = z.object({
  type: z.literal('click'),
  x: z.number(),
  y: z.number(),
  button: z.enum(['left', 'right', 'wheel', 'back', 'forward']),
})

const doubleClickActionSchema = z.object({
  type: z.literal('double_click'),
  x: z.number(),
  y: z.number(),
})

const dragActionSchema = z.object({
  type: z.literal('drag'),
  path: z.array(z.object({ x: z.number(), y: z.number() })).min(1),
})

const keyPressActionSchema = z.object({
  type: z.literal('keypress'),
  keys: z.array(z.string()).min(1),
})

const moveActionSchema = z.object({
  type: z.literal('move'),
  x: z.number(),
  y: z.number(),
})

const screenshotActionSchema = z.object({
  type: z.literal('screenshot'),
})

const scrollActionSchema = z.object({
  type: z.literal('scroll'),
  x: z.number(),
  y: z.number(),
  scroll_x: z.number(),
  scroll_y: z.number(),
})

const typeActionSchema = z.object({
  type: z.literal('type'),
  text: z.string(),
})

const waitActionSchema = z.object({
  type: z.literal('wait'),
})

const actionSchema = z.discriminatedUnion('type', [
  clickActionSchema,
  doubleClickActionSchema,
  dragActionSchema,
  keyPressActionSchema,
  moveActionSchema,
  screenshotActionSchema,
  scrollActionSchema,
  typeActionSchema,
  waitActionSchema,
])

type ComputerAction = z.infer<typeof actionSchema>

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------
function mapMouseButton(button: 'left' | 'right' | 'wheel' | 'back' | 'forward'): MouseButton {
  if (button === 'wheel') return 'middle'
  return button
}

const KEY_ALIASES: Record<string, KeyInput> = {
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  win: 'Meta',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: ' ',
  spacebar: ' ',
  backspace: 'Backspace',
  del: 'Delete',
  delete: 'Delete',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
}

function normalizeKey(rawKey: string): KeyInput {
  const key = rawKey.trim()
  if (!key) return ' ' as KeyInput
  const aliasLookup = KEY_ALIASES[key.toLowerCase()]
  if (aliasLookup) return aliasLookup
  if (key.length === 1) return key as KeyInput
  return key as KeyInput
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

function humanActionSummary(action: z.infer<typeof actionSchema>): string {
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
// Screenshot storage (in-memory with TTL) so we can serve via HTTP
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// Computer session management (Puppeteer-backed virtual browser)
// -----------------------------------------------------------------------------
class ComputerSession {
  private browser?: Browser
  private page?: Page
  private queue: Promise<unknown> = Promise.resolve()
  private hlsRecorder?: HlsRecorder
  private readonly display: VirtualDisplay

  constructor(private readonly memoryKey: string, private readonly config: Config, displayNumber: number) {
    this.display = new VirtualDisplay(displayNumber, config.displayWidth, config.displayHeight, config.xvfbPath)
  }

  async perform(action: ComputerAction): Promise<ActionResult> {
    const description = humanActionSummary(action)
    const capture = await this.enqueue(async () => {
      await this.ensureEnvironment()
      const page = this.page as Page
      await this.applyAction(page, action)
      return await this.captureDisplay()
    })
    return { screenshot: capture, description }
  }

  async close() {
    await this.enqueue(async () => {
      await this.stopHlsRecorder()
      try {
        await this.page?.close()
      } catch {}
      this.page = undefined
      try {
        await this.browser?.close()
      } catch {}
      this.browser = undefined
      await this.display.stop()
    })
  }

  private async moveSystemPointer(x: number, y: number) {
    const tool = 'xdotool'
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(tool, ['mousemove', `${Math.round(x)}`, `${Math.round(y)}`], {
          env: { ...process.env, DISPLAY: this.display.displayEnv },
          stdio: ['ignore', 'ignore', 'pipe'],
        })
        let stderr = ''
        proc.stderr?.on('data', data => { stderr += data.toString() })
        proc.on('error', reject)
        proc.on('exit', code => {
          if (code === 0) resolve()
          else reject(new Error(stderr.trim() || `pointer tool exited with code ${code}`))
        })
      })
    } catch (err) {
      console.warn(`[computer-mcp] (${this.memoryKey}) pointer tool failed:`, err)
    }
  }

  private normalizeVideoOptions(options: { fps: number; quality: number }): { fps: number; quality: number } {
    const fps = Math.max(1, Math.min(30, Math.round(options.fps)))
    const quality = Math.max(10, Math.min(100, Math.round(options.quality)))
    return { fps, quality }
  }

  private async ensureEnvironment(): Promise<void> {
    await this.display.start()
    if (!this.browser || !this.page || this.page.isClosed()) {
      await this.launchBrowser()
    }
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

  private async launchBrowser() {
    await this.display.start()

    if (this.browser) {
      try {
        await this.browser.close()
      } catch {}
      this.browser = undefined
      this.page = undefined
    }

    const viewport = { width: this.config.displayWidth, height: this.config.displayHeight }
    const args = [
      '--no-sandbox',
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
      '--start-maximized',
      `--window-size=${viewport.width},${viewport.height}`,
    ]

    if (this.config.headless) {
      console.warn('[computer-mcp] Headless mode requested but full-browser streaming requires a headful Chrome window; launching headful anyway.')
    }

    const browser = await puppeteer.launch({
      headless: false,
      executablePath: this.config.chromePath,
      defaultViewport: viewport,
      args,
      env: { ...process.env, DISPLAY: this.display.displayEnv },
    })

    this.browser = browser
    const pages = await browser.pages()
    this.page = pages.length ? pages[0] : await browser.newPage()
    await this.page.setViewport({ ...viewport, deviceScaleFactor: 1 })
    const targetUrl = this.config.defaultUrl?.trim() || this.config.blankPageUrl
    try {
      await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch (err) {
      console.warn(`[computer-mcp] (${this.memoryKey}) failed to open initial url ${targetUrl}:`, err)
    }
    try {
      await this.page.bringToFront()
    } catch {}
  }

  private async applyAction(page: Page, action: z.infer<typeof actionSchema>) {
    switch (action.type) {
      case 'click':
        await this.moveSystemPointer(action.x, action.y)
        await page.mouse.click(action.x, action.y, { button: mapMouseButton(action.button) })
        return
      case 'double_click':
        await this.moveSystemPointer(action.x, action.y)
        await page.mouse.click(action.x, action.y, { button: 'left', clickCount: 2 })
        return
      case 'drag': {
        const [start, ...rest] = action.path
        await this.moveSystemPointer(start.x, start.y)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        for (const point of rest) {
          await this.moveSystemPointer(point.x, point.y)
          await page.mouse.move(point.x, point.y, { steps: 10 })
        }
        await page.mouse.up()
        return
      }
      case 'keypress': {
        const downKeys: KeyInput[] = []
        const normalized = action.keys.map(normalizeKey)
        const keyboard = page.keyboard
        for (let i = 0; i < normalized.length; i += 1) {
          const key = normalized[i]
          const isLast = i === normalized.length - 1
          if (isLast) {
            await keyboard.press(key)
          } else {
            await keyboard.down(key)
            downKeys.push(key)
          }
        }
        for (const key of downKeys.reverse()) {
          await keyboard.up(key)
        }
        return
      }
      case 'move':
        await this.moveSystemPointer(action.x, action.y)
        await page.mouse.move(action.x, action.y, { steps: 15 })
        return
      case 'screenshot':
        return
      case 'scroll':
        await this.moveSystemPointer(action.x, action.y)
        await page.mouse.move(action.x, action.y, { steps: 5 })
        await page.mouse.wheel({ deltaX: action.scroll_x, deltaY: action.scroll_y })
        return
      case 'type':
        await page.keyboard.type(action.text)
        return
      case 'wait': {
        await delay(1000)
        return
      }
      default:
        throw new Error(`Unsupported action type: ${(action as { type: string }).type}`)
    }
  }
}

class ComputerSessionManager {
  private sessions = new Map<string, ComputerSession>()
  private nextDisplay: number

  constructor(private readonly config: Config) {
    this.nextDisplay = config.displayBase
  }

  private allocateDisplayNumber(): number {
    return this.nextDisplay++
  }

  get(memoryKey: string): ComputerSession {
    let session = this.sessions.get(memoryKey)
    if (!session) {
      session = new ComputerSession(memoryKey, this.config, this.allocateDisplayNumber())
      this.sessions.set(memoryKey, session)
    }
    return session
  }

  peek(memoryKey: string): ComputerSession | undefined {
    return this.sessions.get(memoryKey)
  }

  async release(memoryKey: string) {
    const session = this.sessions.get(memoryKey)
    if (!session) return
    this.sessions.delete(memoryKey)
    try {
      await session.close()
    } catch (err) {
      console.error(`[computer-mcp] (${memoryKey}) failed to close session:`, err)
    }
  }

  async closeAll() {
    const sessions = Array.from(this.sessions.values())
    this.sessions.clear()
    await Promise.allSettled(sessions.map(session => session.close()))
  }
}

// -----------------------------------------------------------------------------
// Stream manager (MJPEG over HTTP)
// -----------------------------------------------------------------------------
interface StreamRequest {
  streamId: string
  memoryKey: string
  fps: number
  quality: number
  createdAt: number
  dir: string
  closed: boolean
}

class StreamManager {
  private streamsById = new Map<string, StreamRequest>()
  private streamsByMemory = new Map<string, StreamRequest>()
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
    app.get(`${this.config.streamPath}/:id/index.m3u8`, async (req: Request, res: ExpressResponse) => {
      try {
        const stream = this.streamsById.get(req.params.id)
        if (!stream || stream.closed) {
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
        const stream = this.streamsById.get(req.params.id)
        if (!stream || stream.closed) {
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

  async startStream(memoryKey: string, options?: { fps?: number; quality?: number }): Promise<{ streamId: string; url: string; created: boolean }> {
    const existing = this.streamsByMemory.get(memoryKey)
    if (existing && !existing.closed) {
      if (options?.fps) existing.fps = options.fps
      if (options?.quality) existing.quality = options.quality
      return { streamId: existing.streamId, url: `${this.baseUrlFactory()}${this.config.streamPath}/${existing.streamId}/index.m3u8`, created: false }
    }
    const streamId = randomUUID()
    const dir = path.join(this.hlsRoot, streamId)
    const session = this.sessionManager.get(memoryKey)
    await session.ensureHlsRecorder(dir, { fps: options?.fps ?? this.config.streamDefaults.fps, quality: options?.quality ?? this.config.streamDefaults.quality })
    const stream: StreamRequest = {
      streamId,
      memoryKey,
      fps: options?.fps ?? this.config.streamDefaults.fps,
      quality: options?.quality ?? this.config.streamDefaults.quality,
      createdAt: Date.now(),
      dir,
      closed: false,
    }
    this.streamsById.set(streamId, stream)
    this.streamsByMemory.set(memoryKey, stream)
    return { streamId, url: `${this.baseUrlFactory()}${this.config.streamPath}/${streamId}/index.m3u8`, created: true }
  }

  async getStream(memoryKey: string, options?: { fps?: number; quality?: number }): Promise<{ streamId: string; url: string; created: boolean }> {
    const existing = this.streamsByMemory.get(memoryKey)
    if (existing && !existing.closed) {
      if (options?.fps !== undefined || options?.quality !== undefined) {
        return this.startStream(memoryKey, options)
      }
      return { streamId: existing.streamId, url: `${this.baseUrlFactory()}${this.config.streamPath}/${existing.streamId}/index.m3u8`, created: false }
    }
    return this.startStream(memoryKey, options)
  }

  getActiveStreamSummary(memoryKey?: string): { streamId: string; url: string } | undefined {
    if (memoryKey) {
      const stream = this.streamsByMemory.get(memoryKey)
      if (stream && !stream.closed) {
        return { streamId: stream.streamId, url: `${this.baseUrlFactory()}${this.config.streamPath}/${stream.streamId}/index.m3u8` }
      }
      return undefined
    }
    for (const stream of this.streamsByMemory.values()) {
      if (!stream.closed) {
        return { streamId: stream.streamId, url: `${this.baseUrlFactory()}${this.config.streamPath}/${stream.streamId}/index.m3u8` }
      }
    }
    return undefined
  }

  async stopStream(memoryKey: string, streamId?: string): Promise<{ stopped: boolean; streamId?: string }> {
    const stream = streamId ? this.streamsById.get(streamId) : this.streamsByMemory.get(memoryKey)
    if (!stream) {
      return { stopped: false }
    }
    stream.closed = true
    this.streamsById.delete(stream.streamId)
    this.streamsByMemory.delete(stream.memoryKey)
    const session = this.sessionManager.peek(stream.memoryKey)
    if (session) {
      await session.stopHlsRecorder()
    }
    try {
      await fs.rm(stream.dir, { recursive: true, force: true })
    } catch {}
    return { stopped: true, streamId: stream.streamId }
  }

  async stopAll() {
    const streams = Array.from(this.streamsById.values())
    await Promise.allSettled(streams.map(stream => this.stopStream(stream.memoryKey, stream.streamId)))
    this.streamsById.clear()
    this.streamsByMemory.clear()
  }
}

// -----------------------------------------------------------------------------
// MCP Server registration
// -----------------------------------------------------------------------------
function buildComputerCallResult(_action: ComputerAction, base64Image: string) {
  return {
    content: [
      {
        type: 'image' as const,
        data: base64Image,
        mimeType: 'image/png',
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

function createComputerUseServer(memoryKey: string, context: ServerContext): McpServer {
  const { config, sessionManager, streamManager } = context
  const server = new McpServer({
    name: `Computer MCP Server (key=${memoryKey})`,
    version: '1.0.0',
  })

  server.registerTool(
    `${config.toolsPrefix}call`,
    {
      description: 'Perform an action on the virtual computer and return a screenshot.',
      inputSchema: { action: actionSchema },
    },
    async ({ action }) => {
      const session = sessionManager.get(memoryKey)
      const result = await session.perform(action)
      const base64Image = result.screenshot.buffer.toString('base64')
      return buildComputerCallResult(action, base64Image)
    }
  )

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
      const stream = await streamManager.startStream(memoryKey, { fps: args.fps, quality: args.quality })
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
      const stream = await streamManager.getStream(memoryKey, { fps: args.fps, quality: args.quality })
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
      const stopped = await streamManager.stopStream(memoryKey, args.streamId)
      return buildStreamResult({
        type: 'computer_stream_stopped',
        stopped: stopped.stopped,
        stream_id: stopped.streamId,
      })
    }
  )

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

function registerPreviewPage(app: Application, streams: StreamManager, defaultMemoryKey: string) {
  app.get('/preview', (req: Request, res: ExpressResponse) => {
    const streamUrlParam = typeof req.query.url === 'string' ? req.query.url : ''
    const memoryKeyParam = typeof req.query.key === 'string' ? req.query.key : undefined
    const defaultStream = streams.getActiveStreamSummary(memoryKeyParam ?? defaultMemoryKey)
    const initialUrl = streamUrlParam || defaultStream?.url || ''
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
      form { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 16px; }
      label { font-weight: 600; }
      input[type="url"] { flex: 1; min-width: 260px; padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.25); background: rgba(17,17,17,0.9); color: inherit; }
      button { padding: 8px 16px; border: none; border-radius: 6px; background: #2f80ed; color: white; font-weight: 600; cursor: pointer; }
      button:hover { background: #1d6fd8; }
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
      <form id="streamForm">
        <label for="streamUrl">Stream URL</label>
        <input type="url" id="streamUrl" name="url" placeholder="Paste the HLS playlist URL" autocomplete="off" />
        <button type="submit">Load Stream</button>
      </form>
      <div class="viewer">
        <video id="streamVideo" autoplay playsinline muted controls></video>
        <div id="placeholder" class="placeholder">${defaultStream ? 'An active stream was detected automatically. Paste another URL or click “Load Stream” to reconnect.' : 'Paste a stream URL returned by the MCP server to preview the browser.'}</div>
      </div>
      <p class="info">Tip: Use the <code>get_stream</code> or <code>start_stream</code> MCP tools to retrieve the HLS playlist URL, then paste it here.</p>
    </main>
    <script>
      (function() {
        var initialUrl = ${JSON.stringify(initialUrl)};
        var initialKey = ${JSON.stringify(memoryKeyParam ?? '')};
        var defaultDetected = ${defaultStream ? 'true' : 'false'} === 'true';
        var form = document.getElementById('streamForm');
        var input = document.getElementById('streamUrl');
        var video = document.getElementById('streamVideo');
        var placeholder = document.getElementById('placeholder');
        var loadTimer;
        var hlsInstance = null;

        function destroyHls() {
          if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
          }
        }

        function normalizeUrl(rawUrl) {
          if (!rawUrl) return '';
          var trimmed = rawUrl.trim();
          try {
            var target = new URL(trimmed, window.location.href);
            if (target.pathname.indexOf('/streams/') === 0 && target.pathname.indexOf('/index.m3u8', target.pathname.length - '/index.m3u8'.length) === -1) {
              while (target.pathname.length > 1 && target.pathname.charAt(target.pathname.length - 1) === '/') {
                target.pathname = target.pathname.slice(0, -1);
              }
              target.pathname += '/index.m3u8';
            }
            return target.toString();
          } catch (err) {
            return trimmed;
          }
        }

        function syncQuery(url) {
          try {
            var current = new URL(window.location.href);
            if (url) {
              current.searchParams.set('url', url);
            } else {
              current.searchParams.delete('url');
            }
            if (initialKey) {
              current.searchParams.set('key', initialKey);
            }
            window.history.replaceState(null, '', current.toString());
          } catch (err) {
            console.warn('Unable to update URL parameters:', err);
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
            setStatus('Paste a stream URL returned by the MCP server to preview the browser.');
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

        form.addEventListener('submit', function(event) {
          event.preventDefault();
          var url = normalizeUrl(input.value);
          playStream(url);
          syncQuery(url);
        });

        input.addEventListener('input', function() {
          var value = input.value;
          if (!value) {
            clearTimeout(loadTimer);
            playStream('');
            syncQuery('');
            return;
          }
          clearTimeout(loadTimer);
          loadTimer = setTimeout(function() {
            var normalized = normalizeUrl(value);
            playStream(normalized);
            syncQuery(normalized);
          }, 250);
        });

        video.addEventListener('error', function() {
          setStatus('Unable to load stream. Verify the URL is reachable from this server.');
        });

        var bootstrapUrl = normalizeUrl(initialUrl || '');
        if (bootstrapUrl) {
          input.value = bootstrapUrl;
          playStream(bootstrapUrl);
          syncQuery(bootstrapUrl);
        } else if (defaultDetected) {
          setStatus('An active stream was detected automatically. Paste another URL or click “Load Stream” to reconnect.');
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
    res.type('html').send('<!doctype html><html><head><meta charset="utf-8" /><title>Blank</title><style>body{margin:0;background:#0e1014;color:#f0f3f7;font-family:system-ui,Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;}span{opacity:0.2;letter-spacing:0.3em;text-transform:uppercase;font-size:12px;}</style></head><body><span>Ready</span></body></html>')
  })
}

// -----------------------------------------------------------------------------
// Entrypoint
// -----------------------------------------------------------------------------
async function main() {
  const SHARED_MEMORY_KEY = 'shared'
  const argv = yargs(hideBin(process.argv))
    .option('port', { type: 'number', default: 8000 })
    .option('transport', { type: 'string', choices: ['sse', 'stdio', 'http'], default: 'http' })
    .option('displayWidth', { type: 'number', default: 1280 })
    .option('displayHeight', { type: 'number', default: 720 })
    .option('environment', { type: 'string', default: 'browser' })
    .option('headless', { type: 'boolean', default: true })
    .option('defaultUrl', { type: 'string' })
    .option('toolsPrefix', { type: 'string', default: 'computer_' })
    .option('publicBaseUrl', { type: 'string' })
    .option('streamFps', { type: 'number', default: 2 })
    .option('streamQuality', { type: 'number', default: 80 })
    .option('streamPath', { type: 'string', default: '/streams' })
    .option('enablePreview', { type: 'boolean', default: false, describe: 'Serve the /preview helper page to visualize HLS streams.' })
    .option('chromePath', { type: 'string', describe: 'Path to Chrome/Chromium executable launched by Puppeteer (default: bundled binary).' })
    .option('ffmpegPath', { type: 'string', describe: 'Path to ffmpeg binary used for display capture (default: ffmpeg).' })
    .option('xvfbPath', { type: 'string', describe: 'Path to Xvfb binary used for virtual display (default: Xvfb).' })
    .option('displayStart', { type: 'number', default: 90, describe: 'Base X display number for virtual browser sessions.' })
    .help()
    .parseSync()

  if (argv.environment !== 'browser') {
    console.error(`Unsupported environment: ${argv.environment}. Only "browser" is supported.`)
    process.exit(1)
  }

  const streamPath = normalizeRoutePath(argv.streamPath, '/streams')
  const internalOrigin = `http://127.0.0.1:${argv.port}`
  const blankPageUrl = `${internalOrigin}/blank`
  let chromeExecutable: string | undefined
  try {
    chromeExecutable = argv.chromePath && argv.chromePath.trim()
      ? argv.chromePath.trim()
      : executablePath()
  } catch (err) {
    console.warn('[computer-mcp] Unable to determine Chrome executable path automatically:', err)
    chromeExecutable = argv.chromePath?.trim()
  }

  const config: Config = {
    port: argv.port,
    transport: argv.transport as Config['transport'],
    displayWidth: argv.displayWidth,
    displayHeight: argv.displayHeight,
    environment: 'browser',
    headless: argv.headless,
    defaultUrl: argv.defaultUrl,
    toolsPrefix: argv.toolsPrefix ?? 'computer_',
    publicBaseUrl: argv.publicBaseUrl,
    streamPath,
    streamDefaults: {
      fps: Math.max(1, Math.min(30, argv.streamFps ?? 2)),
      quality: Math.max(10, Math.min(100, argv.streamQuality ?? 80)),
    },
    enablePreview: argv.enablePreview ?? false,
    chromePath: chromeExecutable,
    ffmpegPath: argv.ffmpegPath && argv.ffmpegPath.trim() ? argv.ffmpegPath.trim() : 'ffmpeg',
    xvfbPath: argv.xvfbPath && argv.xvfbPath.trim() ? argv.xvfbPath.trim() : 'Xvfb',
    displayBase: Math.max(1, Math.min(60000, argv.displayStart ?? 90)),
    blankPageUrl,
  }

  const baseUrl = resolveBaseUrl(config)
  const sessionManager = new ComputerSessionManager(config)
  const streamManager = new StreamManager(config, sessionManager, { baseUrlFactory: () => baseUrl })

  const context: ServerContext = { config, sessionManager, streamManager }

  const createServer = () => createComputerUseServer(SHARED_MEMORY_KEY, context)

  let httpServer: Server | undefined
  const sockets = new Set<Socket>()
  let shuttingDown = false

  const cleanup = async () => {
    if (shuttingDown) return
    shuttingDown = true
    await streamManager.stopAll()
    await sessionManager.closeAll()
    if (httpServer) {
      for (const socket of sockets) {
        try {
          socket.destroy()
        } catch {}
      }
      await new Promise<void>(resolve => httpServer?.close(() => resolve()))
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
    streamManager.attachRoutes(app)
    registerBlankPage(app)
    if (config.enablePreview) {
      registerPreviewPage(app, streamManager, SHARED_MEMORY_KEY)
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
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true })
  })
  streamManager.attachRoutes(app)
  registerBlankPage(app)
  if (config.enablePreview) {
    registerPreviewPage(app, streamManager, SHARED_MEMORY_KEY)
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
    }

    const sessions = new Map<string, HttpSession>()
    const eventStore = new InMemoryEventStore()

    app.post('/', async (req: Request, res: ExpressResponse) => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined
        logHttpEvent(req, 'POST / received', {
          hasSessionHeader: Boolean(sessionId),
          knownSessions: sessions.size,
        })
        if (sessionId && sessions.has(sessionId)) {
          logHttpEvent(req, 'using existing session', { sessionId })
          const { transport } = sessions.get(sessionId)!
          await transport.handleRequest(req, res)
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
            sessions.set(newId, { server, transport })
            console.log(`[computer-mcp] [${newId}] HTTP session initialized (shared)`)
          },
        })

        transport.onclose = () => {
          const sid = transport.sessionId
          const entry = sid ? sessions.get(sid) : undefined
          if (sid && entry) {
            sessions.delete(sid)
            console.log(`[computer-mcp] [${sid}] Streamable transport closed`)
          }
          setImmediate(async () => {
            try {
              await server.close()
            } catch (err) {
              console.error(`[computer-mcp] [${sid ?? 'unknown'}] server close error:`, err)
            }
            if (entry) {
              try {
                await context.streamManager.stopStream(SHARED_MEMORY_KEY)
              } catch (err) {
                console.error(`[computer-mcp] (${SHARED_MEMORY_KEY}) stopStream after close error:`, err)
              }
            }
          })
        }

        await server.connect(transport)
        logHttpEvent(req, 'established new session', { memoryKey: SHARED_MEMORY_KEY })
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
        const { transport } = sessions.get(sessionId)!
        logHttpEvent(req, 'GET / streaming response', { sessionId })
        await transport.handleRequest(req, res)
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
      const index = sessions.findIndex(s => s.transport === transport)
      const closed = index >= 0 ? sessions[index] : undefined
      if (index >= 0) sessions.splice(index, 1)
      setImmediate(async () => {
        try {
          await server.close()
        } catch (err) {
          console.error(`[computer-mcp] [${sessionId}] SSE server close error:`, err)
        }
        if (closed) {
          try {
            await context.streamManager.stopStream(SHARED_MEMORY_KEY)
          } catch (err) {
            console.error(`[computer-mcp] (${SHARED_MEMORY_KEY}) SSE stopStream error:`, err)
          }
        }
      })
      console.log(`[computer-mcp] [${sessionId}] SSE closed`)
    }

    transport.onerror = (err: Error) => {
      console.error(`[computer-mcp] [${sessionId}] SSE error:`, err)
    }

    req.on('close', () => {
      sessions = sessions.filter(s => s.transport !== transport)
    })
  })

  app.post('/message', async (req: Request, res: ExpressResponse) => {
    const sessionId = req.query.sessionId as string
    if (!sessionId) {
      res.status(400).send({ error: 'Missing sessionId' })
      return
    }
    const target = sessions.find(s => s.sessionId === sessionId)
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

main().catch(err => {
  console.error('[computer-mcp] Fatal error:', err)
  process.exit(1)
})
