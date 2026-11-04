import test from 'node:test';
import assert from 'node:assert/strict';
import { countSesSent, sesSentLast24h, sesBulkRoom, type SesState } from '../lib/ses';
import { store as redis } from './redis-stub';

const HOUR = 3_600_000;
const AT = Date.UTC(2032, 0, 15, 12, 30);
const hourKey = (at: number) => `nl:ses:h:${new Date(at).toISOString().slice(0, 13)}`;
const state: SesState = { ready: true, why: '', rate: 14, max24: 1000, at: AT / 1000, hold: 0 };
const clear = () => redis.run(['DEL', ...Array.from({ length: 27 }, (_, i) => hourKey(AT - i * HOUR))]);

test('accepted sends in the first partial hour still occupy the existing 80 percent bulk share', async () => {
  clear();
  const sentAt = AT - 1425 * 60_000;
  assert.ok(sentAt > AT - 24 * HOUR);
  await countSesSent(800, sentAt);
  assert.equal(await sesSentLast24h(AT), 800);
  assert.equal(await sesBulkRoom(state, AT), 0);
});

test('the 24 hour boundary stays counted and 25 hours ago is outside the grouped observation', async () => {
  clear();
  await countSesSent(800, AT - 24 * HOUR);
  await countSesSent(900, AT - 25 * HOUR);
  assert.equal(await sesSentLast24h(AT), 800);
  assert.equal(await sesBulkRoom(state, AT), 0);
  clear();
  await countSesSent(900, AT - 25 * HOUR);
  assert.equal(await sesSentLast24h(AT), 0);
  assert.equal(await sesBulkRoom(state, AT), 800);
});

test('the first whole bucket may overcount by less than an hour but never omit a recent send', async () => {
  clear();
  await countSesSent(800, AT - 24 * HOUR - 29 * 60_000);
  assert.equal(await sesSentLast24h(AT), 800);
  assert.equal(await sesBulkRoom(state, AT), 0);
});

test('one grouped read contains the current hour and every preceding 24 hour bucket', async () => {
  clear();
  const pipeline = redis.pipeline;
  const seen: (string | number)[][][] = [];
  redis.pipeline = async commands => {
    seen.push(commands.map(command => [...command]));
    return pipeline.call(redis, commands);
  };
  try { assert.equal(await sesSentLast24h(AT), 0); }
  finally { redis.pipeline = pipeline; }
  assert.deepEqual(seen, [Array.from({ length: 25 }, (_, i) => ['GET', hourKey(AT - i * HOUR)])]);
});

test('each of the 25 explicit counters contributes and an unsafe sum remains unknown', async () => {
  clear();
  for (let i = 0; i < 25; i++) redis.run(['SET', hourKey(AT - i * HOUR), String(i + 1)]);
  assert.equal(await sesSentLast24h(AT), 325);
  clear();
  redis.run(['SET', hourKey(AT - 24 * HOUR), String(Number.MAX_SAFE_INTEGER)]);
  assert.equal(await sesSentLast24h(AT), Number.MAX_SAFE_INTEGER);
  redis.run(['SET', hourKey(AT), '1']);
  assert.equal(await sesSentLast24h(AT), null);
});

test('missing or malformed grouped evidence never becomes known zero', async () => {
  const pipeline = redis.pipeline;
  let getters = 0;
  const accessor = Array(25).fill(null);
  Object.defineProperty(accessor, '24', { get() { getters++; return '0'; } });
  const sparse = Array(25).fill(null); delete sparse[24];
  for (const answer of [Array(24).fill(null), Array(26).fill(null), sparse, accessor,
    [...Array(24).fill(null), 'unknown'], [...Array(24).fill(null), '-1']]) {
    redis.pipeline = async () => answer;
    try {
      assert.equal(await sesSentLast24h(AT), null);
      assert.equal(await sesBulkRoom(state, AT), null);
    } finally { redis.pipeline = pipeline; }
  }
  assert.equal(getters, 0);
});

test('an inherited descriptor value cannot turn an accessor counter into known zero', async () => {
  const pipeline = redis.pipeline;
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
  let inheritedReads = 0, counterReads = 0;
  const rows = Array(25).fill(null);
  Object.defineProperty(rows, '24', { get() { counterReads++; return '0'; }, enumerable: true });
  redis.pipeline = async () => rows;
  let observed: number | null = -1, room: number | null = -1;
  try {
    Object.defineProperty(Object.prototype, 'value', {
      configurable: true,
      get() { inheritedReads++; return '0'; },
    });
    observed = await sesSentLast24h(AT);
    room = await sesBulkRoom(state, AT);
  } finally {
    Reflect.deleteProperty(Object.prototype, 'value');
    if (previous) Object.defineProperty(Object.prototype, 'value', previous);
    redis.pipeline = pipeline;
  }
  assert.equal(observed, null);
  assert.equal(room, null);
  assert.equal(counterReads, 0);
  assert.equal(inheritedReads, 0);
});
