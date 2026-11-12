import assert from 'node:assert/strict';
import test from 'node:test';
import {captureCustomerTaxInput, customerTaxCollectionState, type CustomerTaxInput} from '../lib/customer-tax-review';
import {txCustomerFixture} from './customer-tax-review-fixture';
import {contractTaxFixture} from './contract-tax-fixture';

/* The detach in lib/customer-tax-review.ts skips the per-node structuredClone
 * on plain data and replays the checked pass on a Proxy or an Error. This file
 * keeps the previous implementation verbatim as the reference and requires the
 * same result AND the same caller-visible side effects (Proxy traps, getters,
 * mutations made from traps) for every generated input. */

// Reference: lib/customer-tax-review.ts detached() before the fast pass.
function referenceDetached(value: unknown): unknown {
  let nodes = 0, bytes = 0;
  const active = new Set<object>();
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 30_000 || depth > 12) throw Error('review work bound');
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v === 'string') {
      bytes += v.length;
      if (v.length > 32_768 || bytes > 512_000) throw Error('review bytes');
      return v;
    }
    if (!v || typeof v !== 'object' || active.has(v)) throw Error('review data');
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (proto !== (array ? Array.prototype : Object.prototype) && !(proto === null && !array)) throw Error('prototype');
    if (array) {
      const length = Object.getOwnPropertyDescriptor(v, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 1200) throw Error('array bound');
    }
    active.add(v);
    const keys = Reflect.ownKeys(v);
    if (keys.some(k => typeof k !== 'string')) throw Error('symbol');
    if (keys.length > (array ? 1201 : 32)) throw Error('field bound');
    const own = (key: string) => {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !Object.hasOwn(d, 'value')) throw Error('accessor or missing');
      if (!(array && key === 'length') && !d.enumerable) throw Error('non-enumerable fiscal data');
      return d.value;
    };
    let out: unknown;
    if (array) {
      const length = own('length');
      if (!Number.isSafeInteger(length) || length < 0 || length > 1200 || keys.length !== length + 1) throw Error('array bound');
      const items: unknown[] = [];
      for (let i = 0; i < length; i++) items.push(copy(own(String(i)), depth + 1));
      out = items;
    } else {
      if (keys.length > 32) throw Error('field bound');
      const record = Object.create(null) as Record<string, unknown>;
      for (const key of keys as string[]) record[key] = copy(own(key), depth + 1);
      out = record;
    }
    structuredClone(v);
    active.delete(v);
    return out;
  }
  return copy(value, 0);
}
// Reference captureCustomerTaxInput, unchanged except for the detach it calls.
function referenceCapture(value: unknown): CustomerTaxInput | null {
  try {
    const copy = referenceDetached(value);
    if (!copy || typeof copy !== 'object' || Array.isArray(copy) || Object.keys(copy).length !== 2 ||
        !Object.hasOwn(copy, 'taxReview') || !Object.hasOwn(copy, 'taxContext')) return null;
    const input = copy as CustomerTaxInput;
    if (!input.taxReview || typeof input.taxReview !== 'object' || Array.isArray(input.taxReview) ||
        !input.taxContext || typeof input.taxContext !== 'object' || Array.isArray(input.taxContext)) return null;
    return input;
  } catch { return null; }
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type World = {value: unknown; log: string[]; kinds: Set<string>};
/** Builds the same graph, with fresh objects and a fresh log, for one seed. */
function world(seed: number): World {
  const r = rng(seed), log: string[] = [], kinds = new Set<string>(), pool: object[] = [];
  const int = (n: number) => Math.floor(r() * n);
  const chance = (p: number) => r() < p;
  const big = chance(0.03), many = chance(0.02);
  let budget = 60 + int(240);
  // Half the worlds carry no hazard at all, so successful copies are compared too.
  const hazard = chance(0.5);
  const risk = (p: number) => hazard && chance(p);
  const str = () => {
    const roll = r();
    const length = roll < 0.9 ? int(24) : roll < 0.985 || !hazard ? 17_900 + int(3_000) : 32_760 + int(20);
    return 'x'.repeat(length) + String(int(1000));
  };
  function primitive(): unknown {
    switch (int(12)) {
      case 0: return null;
      case 1: return chance(0.5);
      case 2: return [0, -0, NaN, Infinity, 1e308, -1, 2 ** 53, 0.1][int(8)];
      case 3: case 4: case 5: case 6: return str();
      case 7: return risk(0.03) ? undefined : int(1_000_000);
      case 8: return risk(0.03) ? BigInt(int(9)) : 'plain';
      case 9: return risk(0.02) ? Symbol('s') : int(5);
      case 10: return risk(0.02) ? () => 1 : 'text';
      default: return int(100);
    }
  }
  function proxied(target: object, depth: number): object {
    kinds.add('proxy');
    const id = pool.length, mutate = chance(0.4);
    const note = (trap: string, key?: PropertyKey) => {
      log.push(`${id}:${trap}${key === undefined ? '' : ':' + String(key)}`);
      if (mutate && pool.length && trap === 'ownKeys') {
        // A trap that rewrites an earlier branch: a getter, a hidden field or a swap.
        const victim = pool[int(pool.length)];
        if (!Object.isFrozen(victim) && !Array.isArray(victim)) {
          const mode = int(3);
          log.push(`${id}:mutate:${mode}`);
          try {
            if (mode === 0) Object.defineProperty(victim, 'late', {get() { log.push('late getter'); return 1; }, enumerable: true, configurable: true});
            else if (mode === 1) (victim as Record<string, unknown>).late = {plain: str()};
            else Object.defineProperty(victim, 'late', {value: 2, enumerable: false, configurable: true});
          } catch (error) { log.push(`${id}:mutate-failed:${(error as Error).name}`); }
        }
      }
    };
    const handler: ProxyHandler<object> = {
      getPrototypeOf: t => { note('getPrototypeOf'); return Reflect.getPrototypeOf(t); },
      ownKeys: t => {
        note('ownKeys');
        const keys = Reflect.ownKeys(t);
        return chance(0.3) ? keys.filter((_, i) => i !== 0 || Array.isArray(t)) : keys;
      },
      getOwnPropertyDescriptor: (t, k) => { note('gopd', k); return Reflect.getOwnPropertyDescriptor(t, k); },
      get: (t, k, receiver) => { note('get', k); return Reflect.get(t, k, receiver); },
      has: (t, k) => { note('has', k); return Reflect.has(t, k); },
    };
    if (chance(0.1)) {
      const {proxy, revoke} = Proxy.revocable(target, handler);
      kinds.add('revoked');
      if (chance(0.5)) revoke();
      return proxy;
    }
    void depth;
    return new Proxy(target, handler);
  }
  function node(depth: number, ancestors: object[]): unknown {
    if (--budget < 0 || depth > (hazard ? 14 : 11) || (depth > 2 && chance(0.35))) return primitive();
    const roll = r();
    if (roll < 0.03 && pool.length) { kinds.add('shared'); return pool[int(pool.length)]; }
    if (roll < 0.045 && hazard && ancestors.length) { kinds.add('cycle'); return ancestors[int(ancestors.length)]; }
    if (roll < 0.06 && hazard) {
      kinds.add('exotic');
      switch (int(7)) {
        case 0: { const e = new Error('e'); if (chance(0.5)) { delete (e as {stack?: string}).stack; Object.setPrototypeOf(e, Object.prototype); } return e; }
        case 1: { const w = new WeakMap(); Object.setPrototypeOf(w, Object.prototype); return w; }
        case 2: { const d = new Date(0); if (chance(0.5)) Object.setPrototypeOf(d, Object.prototype); return d; }
        case 3: { const m = new Map([[1, 2]]); if (chance(0.5)) Object.setPrototypeOf(m, Object.prototype); return m; }
        case 4: return new (class Box { a = 1; })();
        case 5: { const p = Promise.resolve(1); Object.setPrototypeOf(p, Object.prototype); return p; }
        default: { const t = new Uint8Array(2); Object.setPrototypeOf(t, Object.prototype); return t; }
      }
    }
    const array = depth > 1 && chance(0.3);
    let target: object;
    if (array) {
      const length = many ? 1_200 : big && chance(0.2) ? 1_190 + int(15) : int(5);
      const items: unknown[] = [];
      const self: unknown[] = items;
      for (let i = 0; i < length; i++) items.push(many || (big && length > 6) ? [int(9), int(9), [int(3), int(3)], int(9), [1, 2, [3, 4, [5]]], int(9), int(9), int(9), int(9), int(9), int(9), int(9), int(9), int(9), int(9), int(9), int(9), int(9), int(9), int(9), int(9), int(9), int(9)] : node(depth + 1, [...ancestors, self]));
      if (risk(0.02)) { kinds.add('hole'); items.length += 1; }
      if (risk(0.02)) { kinds.add('extra'); (items as unknown as Record<string, unknown>).extra = 1; }
      target = items;
    } else {
      const record: Record<string, unknown> = chance(0.15) ? Object.create(null) : {};
      const count = chance(0.03) ? (hazard ? 31 + int(4) : 31 + int(2)) : int(6);
      for (let i = 0; i < count; i++) record[`k${i}`] = node(depth + 1, [...ancestors, record]);
      if (risk(0.02)) { kinds.add('getter'); Object.defineProperty(record, 'g', {get() { log.push('getter'); return 1; }, enumerable: true}); }
      if (risk(0.02)) { kinds.add('hidden'); Object.defineProperty(record, 'h', {value: 1, enumerable: false}); }
      if (risk(0.02)) { kinds.add('symbol'); (record as Record<symbol, unknown>)[Symbol('s')] = 1; }
      target = record;
    }
    if (chance(0.05)) Object.freeze(target);
    pool.push(target);
    return risk(0.08) ? proxied(target, depth) : target;
  }
  const pair = () => chance(0.95) ? node(1, []) : primitive();
  const value = chance(0.97) ? {taxReview: pair(), taxContext: pair()} : node(0, []);
  return {value, log, kinds};
}

function outcome(capture: (value: unknown) => CustomerTaxInput | null, seed: number) {
  const w = world(seed);
  const result = capture(w.value);
  return {result, log: w.log, kinds: w.kinds};
}

test('the fast detach returns exactly what the per-node structuredClone detach returned, with the same side effects', () => {
  const seen = new Map<string, number>();
  let copies = 0, refusals = 0;
  for (let seed = 1; seed <= 4_000; seed++) {
    const before = outcome(referenceCapture, seed), after = outcome(captureCustomerTaxInput, seed);
    assert.deepStrictEqual(after.result, before.result, `seed ${seed}: result`);
    assert.deepStrictEqual(after.log, before.log, `seed ${seed}: caller-visible effects`);
    if (before.result) copies++; else refusals++;
    for (const kind of before.kinds) seen.set(kind, (seen.get(kind) ?? 0) + 1);
  }
  // Guard against a generator that only exercises one side.
  assert.ok(copies > 500 && refusals > 500, `copies ${copies}, refusals ${refusals}`);
  for (const kind of ['proxy', 'revoked', 'exotic', 'shared', 'cycle', 'hole', 'extra', 'getter', 'hidden', 'symbol'])
    assert.ok((seen.get(kind) ?? 0) > 5, `generator covers ${kind}: ${seen.get(kind) ?? 0}`);
});

test('an Error whose clone runs inherited getters is still copied through the checked pass, with the same effects', () => {
  const run = (capture: (value: unknown) => CustomerTaxInput | null) => {
    const log: string[] = [];
    const later = {a: 1};
    const descriptors = ['name', 'stack'].map(key => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const);
    try {
      for (const key of ['name', 'stack']) Object.defineProperty(Object.prototype, key, {configurable: true, get() {
        log.push(key);
        // A getter that rewrites a branch the detach has not reached yet.
        if (key === 'name') Object.defineProperty(later, 'a', {configurable: true, enumerable: true, get() { log.push('later'); return 2; }});
        return key;
      }});
      const error = new Error('e');
      delete (error as {stack?: string}).stack;
      delete (error as {message?: string}).message;
      Object.setPrototypeOf(error, Object.prototype);
      return {result: capture({taxReview: {error}, taxContext: {later}}), log};
    } finally {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
        else delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  };
  const before = run(referenceCapture), after = run(captureCustomerTaxInput);
  assert.deepStrictEqual(after, before);
  assert.ok(before.log.length > 0, 'the reference ran the inherited getter');
});

test('real review fixtures detach identically through both implementations', () => {
  const row = txCustomerFixture();
  const pair = {taxReview: row.taxReview, taxContext: row.taxContext};
  const expected = referenceCapture(pair);
  assert.ok(expected);
  assert.deepStrictEqual(captureCustomerTaxInput(pair), expected);
  const contract = contractTaxFixture();
  const scenarios = contract.review.scenarios as Record<string, {taxReview?: unknown; taxContext?: unknown}>;
  let compared = 0;
  for (const scenario of Object.values(scenarios)) {
    if (!scenario || !Object.hasOwn(scenario, 'taxReview')) continue;
    const input = {taxReview: scenario.taxReview, taxContext: scenario.taxContext};
    const reference = referenceCapture(input);
    assert.ok(reference);
    assert.deepStrictEqual(captureCustomerTaxInput(input), reference);
    compared++;
  }
  assert.ok(compared > 0);
  assert.equal(customerTaxCollectionState(contract.review), 'tx');
});
