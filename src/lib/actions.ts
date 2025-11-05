import { z } from 'zod'

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

export const actionSchema = z.discriminatedUnion('type', [
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

export type ComputerAction = z.infer<typeof actionSchema>
export type ToolSchemaMode = 'strict' | 'loose'

type ClickButton = z.infer<typeof clickActionSchema>['button']

const BUTTON_ALIASES: Record<string, ClickButton> = {
  left: 'left',
  primary: 'left',
  right: 'right',
  secondary: 'right',
  middle: 'wheel',
  wheel: 'wheel',
  mousewheel: 'wheel',
  scroll: 'wheel',
  back: 'back',
  forward: 'forward',
}

const CLICK_TYPE_DEFAULTS: Record<string, ClickButton> = {
  click: 'left',
  left_click: 'left',
  leftclick: 'left',
  right_click: 'right',
  rightclick: 'right',
  middle_click: 'wheel',
  middleclick: 'wheel',
}

const KEYS_SPLIT_REGEX = /[+\s]+/

function coerceNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) {
      const parsed = Number(trimmed)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }
  throw new Error(`Expected ${field} to be a number`)
}

function coerceButton(value: unknown): ClickButton | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }
  return BUTTON_ALIASES[normalized]
}

function coerceKeys(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const keys = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0)
    return keys.length > 0 ? keys : undefined
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return undefined
    }
    const keys = trimmed.split(KEYS_SPLIT_REGEX).filter((item) => item.length > 0)
    return keys.length > 0 ? keys : undefined
  }
  return undefined
}

function coerceText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  return undefined
}

function coercePoint(value: unknown, index: number): { x: number; y: number } {
  if (Array.isArray(value) && value.length >= 2) {
    const [x, y] = value
    return {
      x: coerceNumber(x, `path[${index}].x`),
      y: coerceNumber(y, `path[${index}].y`),
    }
  }
  if (typeof value === 'object' && value !== null) {
    const point = value as Record<string, unknown>
    const x = coerceNumber(point.x ?? point.X ?? point[0], `path[${index}].x`)
    const y = coerceNumber(point.y ?? point.Y ?? point[1], `path[${index}].y`)
    return { x, y }
  }
  throw new Error(`Expected path[${index}] to contain point coordinates`)
}

function coerceCoordinate(value: unknown): { x: number; y: number } {
  if (Array.isArray(value) && value.length >= 2) {
    const [x, y] = value
    return { x: coerceNumber(x, 'x'), y: coerceNumber(y, 'y') }
  }
  if (typeof value === 'object' && value !== null) {
    const point = value as Record<string, unknown>
    const x = coerceNumber(point.x ?? point.X ?? point[0], 'x')
    const y = coerceNumber(point.y ?? point.Y ?? point[1], 'y')
    return { x, y }
  }
  throw new Error('Coordinates must include x and y values')
}

function resolveCoordinates(
  input: Record<string, unknown>,
  fallback: unknown,
  { requireBoth = true, defaultX, defaultY }: { requireBoth?: boolean; defaultX?: number; defaultY?: number } = {}
): { x: number; y: number } {
  const xRaw = input.x ?? input.X
  const yRaw = input.y ?? input.Y
  let x = xRaw !== undefined ? coerceNumber(xRaw, 'x') : undefined
  let y = yRaw !== undefined ? coerceNumber(yRaw, 'y') : undefined

  if ((x === undefined || y === undefined) && fallback !== undefined) {
    const point = coerceCoordinate(fallback)
    if (x === undefined) x = point.x
    if (y === undefined) y = point.y
  }

  if (x === undefined) x = defaultX
  if (y === undefined) y = defaultY

  if (requireBoth && (x === undefined || y === undefined)) {
    throw new Error('Coordinates must include both x and y')
  }

  return { x: x ?? 0, y: y ?? 0 }
}

function normalizeLooseAction(input: Record<string, unknown>): ComputerAction {
  const typeRaw = typeof input.type === 'string' ? input.type.trim() : ''
  if (!typeRaw) {
    throw new Error('Action.type must be a string')
  }
  const type = typeRaw.toLowerCase()

  switch (type) {
    case 'click':
    case 'left_click':
    case 'leftclick':
    case 'right_click':
    case 'rightclick':
    case 'middle_click':
    case 'middleclick': {
      const coordinateSource =
        input.coordinate ??
        input.coordinates ??
        input.position ??
        input.pos ??
        input.point
      const { x, y } = resolveCoordinates(input, coordinateSource, { requireBoth: true })
      const providedButton = coerceButton(input.button ?? input.Button)
      const defaultButton = CLICK_TYPE_DEFAULTS[type] ?? 'left'
      const button = providedButton ?? defaultButton
      return actionSchema.parse({ type: 'click', x, y, button })
    }
    case 'double_click':
    case 'doubleclick': {
      const coordinateSource =
        input.coordinate ??
        input.coordinates ??
        input.position ??
        input.pos ??
        input.point
      const { x, y } = resolveCoordinates(input, coordinateSource, { requireBoth: true })
      return actionSchema.parse({ type: 'double_click', x, y })
    }
    case 'drag': {
      const rawPath = Array.isArray(input.path)
        ? input.path
        : Array.isArray(input.points)
          ? input.points
          : undefined
      if (!rawPath || rawPath.length === 0) {
        throw new Error('Drag action requires a non-empty path')
      }
      const path = rawPath.map((point, index) => coercePoint(point, index))
      return actionSchema.parse({ type: 'drag', path })
    }
    case 'keypress':
    case 'key':
    case 'key_press':
    case 'key-press':
    case 'keyevent':
    case 'key_event': {
      const keys =
        coerceKeys(input.keys) ??
        coerceKeys(input.key) ??
        coerceKeys(input.text) ??
        coerceKeys(input.value) ??
        coerceKeys(input.sequence)
      if (!keys) {
        throw new Error('Keypress action requires keys array or text string')
      }
      return actionSchema.parse({ type: 'keypress', keys })
    }
    case 'move': {
      const x = coerceNumber(input.x ?? input.X, 'x')
      const y = coerceNumber(input.y ?? input.Y, 'y')
      return actionSchema.parse({ type: 'move', x, y })
    }
    case 'screenshot': {
      return actionSchema.parse({ type: 'screenshot' })
    }
    case 'scroll':
    case 'mouse_scroll':
    case 'wheel': {
      const coordinateSource =
        input.coordinate ??
        input.coordinates ??
        input.position ??
        input.pos ??
        input.point
      const { x, y } = resolveCoordinates(input, coordinateSource, {
        requireBoth: false,
        defaultX: 0,
        defaultY: 0,
      })

      const scrollXRaw =
        input.scroll_x ?? input.scrollX ?? input.delta_x ?? input.deltaX ?? input.dx
      const scrollYRaw =
        input.scroll_y ?? input.scrollY ?? input.delta_y ?? input.deltaY ?? input.dy

      let scroll_x =
        scrollXRaw !== undefined ? coerceNumber(scrollXRaw, 'scroll_x') : 0
      let scroll_y =
        scrollYRaw !== undefined ? coerceNumber(scrollYRaw, 'scroll_y') : 0

      const direction =
        typeof input.direction === 'string' ? input.direction.trim().toLowerCase() : undefined
      if (direction && scroll_x === 0 && scroll_y === 0) {
        switch (direction) {
          case 'up':
            scroll_y = -120
            break
          case 'down':
            scroll_y = 120
            break
          case 'left':
            scroll_x = -120
            break
          case 'right':
            scroll_x = 120
            break
        }
      }
      return actionSchema.parse({ type: 'scroll', x, y, scroll_x, scroll_y })
    }
    case 'type':
    case 'input':
    case 'text': {
      const text =
        coerceText(input.text) ??
        coerceText(input.value) ??
        coerceText(input.input) ??
        coerceText(input.characters)
      if (!text) {
        throw new Error('Type action requires a text value')
      }
      return actionSchema.parse({ type: 'type', text })
    }
    case 'wait':
    case 'pause': {
      return actionSchema.parse({ type: 'wait' })
    }
    default:
      throw new Error(`Unsupported action type "${typeRaw}"`)
  }
}

function parseLooseAction(action: unknown): ComputerAction {
  const strictResult = actionSchema.safeParse(action)
  if (strictResult.success) {
    return strictResult.data
  }
  if (typeof action !== 'object' || action === null) {
    throw new Error('Action payload must be an object')
  }
  try {
    return normalizeLooseAction(action as Record<string, unknown>)
  } catch (err) {
    if (err instanceof Error) {
      throw err
    }
    throw new Error('Invalid action payload')
  }
}

export function parseActionInput(action: unknown, mode: ToolSchemaMode): ComputerAction {
  if (mode === 'strict') {
    return actionSchema.parse(action)
  }
  const looseResult = actionSchema.safeParse(action)
  if (looseResult.success) {
    if (typeof action === 'object' && action !== null) {
      const raw = action as Record<string, unknown>
      if (
        typeof raw.type === 'string' &&
        raw.type.trim().toLowerCase() === 'scroll' &&
        typeof raw.direction === 'string'
      ) {
        return normalizeLooseAction(raw)
      }
    }
    return looseResult.data
  }
  return parseLooseAction(action)
}

export const looseActionInputSchema = z.unknown().transform((value, ctx) => {
  try {
    return parseActionInput(value, 'loose')
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : 'Invalid action payload',
    })
    return z.NEVER
  }
})
