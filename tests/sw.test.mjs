import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const projectScope = 'https://example.github.io/phone-notes/';

function createWorker(scope = projectScope) {
  const listeners = new Map();
  const stores = new Map();
  const calls = { skipped: 0, claimed: 0, deleted: [], requests: [] };
  let network = async (request) => new Response(`installed: ${new URL(request.url).pathname}`);
  let rejectCacheWrites = false;

  function storeFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  const context = {
    URL, Request, Response, Set, Promise,
    self: {
      registration: { scope },
      addEventListener: (name, handler) => listeners.set(name, handler),
      skipWaiting: () => { calls.skipped++; },
      clients: { claim: async () => { calls.claimed++; } },
    },
    fetch: async (request) => {
      calls.requests.push(request);
      return network(request);
    },
    caches: {
      keys: async () => [...stores.keys()],
      delete: async (name) => {
        calls.deleted.push(name);
        return stores.delete(name);
      },
      open: async (name) => {
        const entries = storeFor(name);
        return {
          addAll: async (requests) => {
            const pending = await Promise.all(requests.map(async (request) => {
              const response = await context.fetch(request);
              if (!response.ok) throw new TypeError('Precache request failed');
              return [request.url, response.clone()];
            }));
            pending.forEach(([url, response]) => entries.set(url, response));
          },
          match: async (key) => entries.get(typeof key === 'string' ? key : key.url)?.clone(),
          put: async (key, response) => {
            if (rejectCacheWrites) throw new Error('Device storage is full');
            entries.set(typeof key === 'string' ? key : key.url, response.clone());
          },
        };
      },
    },
  };
  vm.runInNewContext(workerSource, context, { filename: 'sw.js' });

  return {
    calls,
    stores,
    setNetwork: (handler) => { network = handler; },
    failCacheWrites: () => { rejectCacheWrites = true; },
    async lifecycle(name) {
      const pending = [];
      listeners.get(name)({ waitUntil: (promise) => pending.push(promise) });
      await Promise.all(pending);
    },
    message: (data) => listeners.get('message')({ data }),
    request(url, { method = 'GET', navigate = false } = {}) {
      const request = new Request(url, { method });
      // Native Node Request forbids creating navigation requests; the event's
      // mode is the only browser-specific property needed by the worker.
      if (navigate) Object.defineProperty(request, 'mode', { value: 'navigate' });
      let response = null;
      listeners.get('fetch')({ request, respondWith: (promise) => { response = promise; } });
      return response;
    },
  };
}

test('installation prepares a complete project-subpath app without forcing an open app to update', async () => {
  const worker = createWorker();
  await worker.lifecycle('install');
  const entries = [...worker.stores.values()][0];
  for (const path of ['index.html', 'styles.css', 'app.js', 'store.js', 'manifest.webmanifest', 'assets/icon-180.png', 'assets/icon-192.png', 'assets/icon-512.png']) {
    assert.ok(entries.has(`${projectScope}${path}`), `${path} is available offline`);
  }
  assert.ok([...entries.keys()].every((url) => url.startsWith(projectScope)));
  assert.equal(worker.calls.skipped, 0);
  assert.equal(worker.calls.claimed, 0);
  assert.ok(worker.calls.requests.every((request) => request.cache === 'reload'));
});

test('an interrupted installation does not force activation', async () => {
  const worker = createWorker();
  worker.setNetwork(async () => { throw new TypeError('Connection lost'); });
  await assert.rejects(worker.lifecycle('install'), /Connection lost/);
  assert.equal(worker.calls.skipped, 0);
  assert.equal(worker.calls.claimed, 0);
});

test('root and project Pages URLs both open from cache while offline, including home-screen query strings', async () => {
  for (const scope of ['https://example.github.io/', projectScope]) {
    const worker = createWorker(scope);
    await worker.lifecycle('install');
    worker.setNetwork(async () => { throw new TypeError('Offline'); });
    for (const url of [scope, `${scope}?from=homescreen`, `${scope}index.html?from=homescreen`]) {
      const response = await worker.request(url, { navigate: true });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), `installed: ${new URL(`${scope}index.html`).pathname}`);
    }
    const script = await worker.request(`${scope}app.js?v=1`);
    assert.equal(await script.text(), `installed: ${new URL(`${scope}app.js`).pathname}`);
  }
});

test('a successful online response refreshes the next offline response', async () => {
  const worker = createWorker();
  await worker.lifecycle('install');
  worker.setNetwork(async () => new Response('updated application', { status: 200 }));
  const online = await worker.request(`${projectScope}app.js`);
  assert.equal(await online.text(), 'updated application');
  worker.setNetwork(async () => { throw new TypeError('Offline'); });
  const offline = await worker.request(`${projectScope}app.js`);
  assert.equal(await offline.text(), 'updated application');
});

test('temporary server errors use the last working application instead of poisoning its cache', async () => {
  const worker = createWorker();
  await worker.lifecycle('install');
  worker.setNetwork(async () => new Response('Unavailable', { status: 503 }));
  const response = await worker.request(projectScope, { navigate: true });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'installed: /phone-notes/index.html');
});

test('a full device cache still allows the current online application to load', async () => {
  const worker = createWorker();
  await worker.lifecycle('install');
  worker.failCacheWrites();
  worker.setNetwork(async () => new Response('fresh despite full cache'));
  const response = await worker.request(`${projectScope}styles.css`);
  assert.equal(await response.text(), 'fresh despite full cache');
});

test('only known GET assets in this app are intercepted', () => {
  const worker = createWorker();
  const excluded = [
    ['https://another.example/phone-notes/app.js', {}],
    ['https://example.github.io/another-app/app.js', {}],
    ['https://example.github.io/phone-notes-elsewhere/app.js', {}],
    [`${projectScope}private.json`, {}],
    [`${projectScope}unrelated-page`, { navigate: true }],
    [`${projectScope}app.js`, { method: 'POST' }],
    [`${projectScope}app.js`, { method: 'HEAD' }],
  ];
  for (const [url, options] of excluded) assert.equal(worker.request(url, options), null, url);
  assert.equal(worker.calls.requests.length, 0);
  assert.equal(worker.stores.size, 0);
});

test('an upgrade removes this app’s obsolete cache while preserving other apps and its current cache', async () => {
  const worker = createWorker();
  await worker.lifecycle('install');
  const currentName = [...worker.stores.keys()][0];
  const obsoleteName = `yohaku:${projectScope}:obsolete-version`;
  const otherProject = 'yohaku:https://example.github.io/another-app/:v1';
  const unrelated = 'another-application-cache';
  worker.stores.set(obsoleteName, new Map());
  worker.stores.set(otherProject, new Map());
  worker.stores.set(unrelated, new Map());
  await worker.lifecycle('activate');
  assert.deepEqual(worker.calls.deleted, [obsoleteName]);
  assert.ok(worker.stores.has(currentName));
  assert.ok(worker.stores.has(otherProject));
  assert.ok(worker.stores.has(unrelated));
  assert.equal(worker.calls.claimed, 1);
  assert.equal(worker.calls.skipped, 0);
});

test('an open app updates early only after receiving the explicit update message', () => {
  const worker = createWorker();
  worker.message(undefined);
  worker.message({ type: 'UNRELATED_MESSAGE' });
  assert.equal(worker.calls.skipped, 0);
  worker.message({ type: 'SKIP_WAITING' });
  assert.equal(worker.calls.skipped, 1);
});
