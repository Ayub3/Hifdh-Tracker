import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, getWorkspaceKey, listAll } from '../src/api.js';

let values;
beforeEach(() => {
  values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
});

test('workspace keys are random, persistent, and different in another browser', () => {
  const first = getWorkspaceKey();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(getWorkspaceKey(), first);
  values.clear();
  assert.notEqual(getWorkspaceKey(), first);
});

test('blocked storage prevents creating an inaccessible workspace', () => {
  globalThis.localStorage.setItem = () => { throw new Error('Blocked'); };
  assert.throws(getWorkspaceKey, /Allow browser storage/);
});

test('requests carry the workspace key, JSON, and idempotency headers without login', async () => {
  let request;
  const api = createApi('https://api.example.com/', async (url, options) => {
    request = { url, ...options };
    return new Response(JSON.stringify({ id: 'session-1' }), { status: 201 });
  });
  assert.deepEqual(await api('/api/v1/plans/plan-1/sessions', { method: 'POST', body: '{}', headers: { 'Idempotency-Key': 'retry-1' } }), { id: 'session-1' });
  assert.equal(request.url, 'https://api.example.com/api/v1/plans/plan-1/sessions');
  assert.equal(request.headers.get('X-Workspace-Key'), getWorkspaceKey());
  assert.equal(request.headers.get('Idempotency-Key'), 'retry-1');
  assert.equal(request.headers.get('Content-Type'), 'application/json');
  assert.equal(request.headers.has('Authorization'), false);
  assert.equal(request.cache, 'no-store');
});

test('API and network failures are reported', async () => {
  await assert.rejects(createApi('', async () => new Response('{"detail":"Plan not found"}', { status: 404 }))('/missing'), /Plan not found/);
  await assert.rejects(createApi('', async () => { throw new Error('Offline'); })('/missing'), /Could not reach/);
  await assert.rejects(createApi('', async () => new Response('<html>wrong origin</html>'))('/missing'), /unexpected response/);
});

test('session and plan lists fetch all pages for accurate dashboard totals', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(url.endsWith('offset=0') ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }]));
  };
  try {
    assert.equal((await listAll('/api/v1/plans')).length, 101);
    assert.equal(urls.length, 2);
    assert.ok(urls[1].endsWith('limit=100&offset=100'));
  } finally { globalThis.fetch = originalFetch; }
});
