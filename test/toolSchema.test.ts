import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { ZodError } from 'zod'

import { actionSchema, looseActionInputSchema, parseActionInput } from '../src/lib/actions.js'

test('strict mode rejects click action without button', () => {
  assert.throws(
    () => parseActionInput({ type: 'click', x: 5, y: 10 }, 'strict'),
    (error: unknown) => error instanceof ZodError && error.issues[0]?.path?.[0] === 'button'
  )
})

test('strict mode accepts canonical click action', () => {
  const action = parseActionInput({ type: 'click', x: 5, y: 10, button: 'left' }, 'strict')
  if (action.type !== 'click') {
    throw new Error('expected click action')
  }
  assert.equal(action.button, 'left')
})

test('loose mode defaults click button to left', () => {
  const action = parseActionInput({ type: 'click', x: 100, y: 200 }, 'loose')
  if (action.type !== 'click') {
    throw new Error('expected click action')
  }
  assert.equal(action.button, 'left')
})

test('loose mode understands left_click alias', () => {
  const action = parseActionInput({ type: 'left_click', x: 1, y: 2 }, 'loose')
  if (action.type !== 'click') {
    throw new Error('expected click action')
  }
  assert.equal(action.button, 'left')
})

test('loose mode preserves explicit button on left_click alias', () => {
  const action = parseActionInput({ type: 'left_click', button: 'right', x: 9, y: 4 }, 'loose')
  if (action.type !== 'click') {
    throw new Error('expected click action')
  }
  assert.equal(action.button, 'right')
})

test('loose mode converts keypress text into keys array', () => {
  const action = parseActionInput({ type: 'keypress', text: 'ctrl+t' }, 'loose')
  if (action.type !== 'keypress') {
    throw new Error('expected keypress action')
  }
  assert.deepEqual(action.keys, ['ctrl', 't'])
})

test('loose mode handles key alias with text payload', () => {
  const action = parseActionInput({ type: 'key', text: 'alt+shift+p' }, 'loose')
  if (action.type !== 'keypress') {
    throw new Error('expected keypress action')
  }
  assert.deepEqual(action.keys, ['alt', 'shift', 'p'])
})

test('loose mode resolves right_click alias with default button', () => {
  const action = parseActionInput({ type: 'right_click', x: 42, y: 24 }, 'loose')
  if (action.type !== 'click') {
    throw new Error('expected click action')
  }
  assert.equal(action.button, 'right')
})

test('loose mode requires drag path entries and normalizes tuples', () => {
  const action = parseActionInput({ type: 'drag', path: [[0, 0], [100, 200]] }, 'loose')
  if (action.type !== 'drag') {
    throw new Error('expected drag action')
  }
  assert.deepEqual(action.path, [
    { x: 0, y: 0 },
    { x: 100, y: 200 },
  ])
})

test('loose mode infers scroll deltas from alternatives', () => {
  const action = parseActionInput({ type: 'scroll', x: '12', y: 34, deltaY: '50', deltaX: -5 }, 'loose')
  if (action.type !== 'scroll') {
    throw new Error('expected scroll action')
  }
  assert.equal(action.x, 12)
  assert.equal(action.y, 34)
  assert.equal(action.scroll_x, -5)
  assert.equal(action.scroll_y, 50)
})

test('loose mode accepts pause alias for wait', () => {
  const action = parseActionInput({ type: 'pause' }, 'loose')
  assert.equal(action.type, 'wait')
})

test('loose mode pulls type payload from value field', () => {
  const action = parseActionInput({ type: 'type', value: 'hello world' }, 'loose')
  if (action.type !== 'type') {
    throw new Error('expected type action')
  }
  assert.equal(action.text, 'hello world')
})

test('loose mode accepts keypress array with End key', () => {
  const action = parseActionInput({ type: 'keypress', keys: ['End'] }, 'loose')
  if (action.type !== 'keypress') {
    throw new Error('expected keypress action')
  }
  assert.deepEqual(action.keys, ['End'])
})

test('loose mode accepts keypress array with return key', () => {
  const action = parseActionInput({ type: 'keypress', keys: ['return'] }, 'loose')
  if (action.type !== 'keypress') {
    throw new Error('expected keypress action')
  }
  assert.deepEqual(action.keys, ['return'])
})

test('loose mode accepts keypress array with modifier chord', () => {
  const action = parseActionInput({ type: 'keypress', keys: ['ctrl', 'a'] }, 'loose')
  if (action.type !== 'keypress') {
    throw new Error('expected keypress action')
  }
  assert.deepEqual(action.keys, ['ctrl', 'a'])
})

test('loose mode accepts keypress array with page_down alias', () => {
  const action = parseActionInput({ type: 'keypress', keys: ['page_down'] }, 'loose')
  if (action.type !== 'keypress') {
    throw new Error('expected keypress action')
  }
  assert.deepEqual(action.keys, ['page_down'])
})

test('loose mode accepts keypress array with Home key', () => {
  const action = parseActionInput({ type: 'keypress', keys: ['Home'] }, 'loose')
  if (action.type !== 'keypress') {
    throw new Error('expected keypress action')
  }
  assert.deepEqual(action.keys, ['Home'])
})

test('loose mode accepts keypress array with Page_Down key', () => {
  const action = parseActionInput({ type: 'keypress', keys: ['Page_Down'] }, 'loose')
  if (action.type !== 'keypress') {
    throw new Error('expected keypress action')
  }
  assert.deepEqual(action.keys, ['Page_Down'])
})

test('loose mode splits space-delimited key text', () => {
  const action = parseActionInput({ type: 'key', text: 'Down Down Down Down Down' }, 'loose')
  if (action.type !== 'keypress') {
    throw new Error('expected keypress action')
  }
  assert.deepEqual(action.keys, ['Down', 'Down', 'Down', 'Down', 'Down'])
})

test('loose mode accepts single return key text', () => {
  const action = parseActionInput({ type: 'key', text: 'Return' }, 'loose')
  if (action.type !== 'keypress') {
    throw new Error('expected keypress action')
  }
  assert.deepEqual(action.keys, ['Return'])
})

test('loose mode accepts click coordinate array alias', () => {
  const action = parseActionInput({ type: 'left_click', coordinate: [650, 126] }, 'loose')
  if (action.type !== 'click') {
    throw new Error('expected click action')
  }
  assert.equal(action.button, 'left')
  assert.equal(action.x, 650)
  assert.equal(action.y, 126)
})

test('loose mode derives scroll direction when deltas missing', () => {
  const action = parseActionInput(
    {
      type: 'scroll',
      x: 0,
      y: 0,
      scroll_x: 0,
      scroll_y: 0,
      direction: 'down',
    },
    'loose'
  )
  if (action.type !== 'scroll') {
    throw new Error('expected scroll action')
  }
  assert.equal(action.scroll_x, 0)
  assert.equal(action.scroll_y, 120)
})

test('loose mode throws for unsupported action types', () => {
  assert.throws(() => parseActionInput({ type: 'triple_click', x: 5, y: 10 }, 'loose'))
})

test('loose mode throws when drag path is empty', () => {
  assert.throws(() => parseActionInput({ type: 'drag', path: [] }, 'loose'))
})

test('strict mode rejects unknown action type', () => {
  assert.throws(() => parseActionInput({ type: 'pause' }, 'strict'))
})

test('loose action schema produces canonical ComputerAction instances', () => {
  const payload = { type: 'click', x: 10, y: 20 }
  const viaSchema = looseActionInputSchema.parse(payload)
  const viaParser = parseActionInput(payload, 'loose')
  const canonical = actionSchema.parse({ type: 'click', x: 10, y: 20, button: 'left' })

  assert.deepEqual(viaSchema, canonical)
  assert.deepEqual(viaSchema, viaParser)
})
