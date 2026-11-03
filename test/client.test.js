import test from 'node:test'
import assert from 'node:assert/strict'

// Load src/client.js the way the platform does: a module-loader call with a
// require() that resolves 'react'. The React stub only needs the hooks the view
// touches at module scope; the view itself is not rendered here.
let cached = null

function loadClient() {
  if (cached !== null) return Promise.resolve(cached)
  let factory = null
  globalThis.window = {
    __ModuleLoader__: {
      load: (def) => {
        factory = def.factory
      },
    },
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useSyncExternalStore: () => ({ payload: null, failure: null, loading: true }),
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
    memo: (fn) => fn,
  }
  const require = (id) => {
    if (id === 'react') return react
    throw new Error('unexpected require: ' + id)
  }
  return import('../src/client.js').then(() => {
    assert.notEqual(factory, null, 'the bundle must register a factory')
    cached = factory(require)
    return cached
  })
}

test('the bundle registers the windows view beside chat and trajectory', async () => {
  const exports = await loadClient()
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.version, '0.5.2')

  const registered = []
  const slots = {
    inject: (name, fn) => fn(),
    register: (def, component) => {
      registered.push({ def, component })
      return def
    },
  }
  const t = (key) => key
  exports.__test.registerView(slots, () => ({}), t)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].def.name, 'conversation.view')
  assert.equal(registered[0].def.id, 'windows')
  assert.equal(registered[0].def.order, 30)
  assert.equal(registered[0].def.label(), 'view.windows')
})

test('counts are formatted the way the header expects', async () => {
  const exports = await loadClient()
  assert.equal(exports.__test.formatCount(null), '—')
  assert.equal(exports.__test.formatCount(900), '900')
  assert.equal(exports.__test.formatCount(800355), '80.0万')
  assert.equal(exports.__test.formatText('第 {n} 窗', { n: 2 }), '第 2 窗')
})
