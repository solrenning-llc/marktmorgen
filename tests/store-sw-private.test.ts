/**
 * The store's service worker (public/sw.js, scope "/") copies every same-origin GET that answers OK into Cache
 * Storage and serves that copy when the network fails. Pages drawn for the signed-in viewer were missing from its
 * private list: a members-only letter (its whole body and the reader's email), an invitation (the signed-in
 * email), a signing or paying page's state, and a draft podcast shown to its owner. On a shared computer, after
 * signing out or losing access, the next person offline got them from the cache (#4615). They are private now,
 * on both addresses a store has, and the cache's new name empties the copies already kept.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { done, is, part } from "./check";

const source = readFileSync("public/sw.js", "utf8");
const ORIGIN = "https://marktmorgen.com";

type FetchEvent = { request: { method: string; url: string }; respondWith: (r: unknown) => void };
const handlers: Record<string, (event: FetchEvent) => void> = {};
const self = {
  location: { origin: ORIGIN },
  addEventListener: (name: string, fn: (event: FetchEvent) => void) => {
    handlers[name] = fn;
  },
  skipWaiting: () => Promise.resolve(),
  clients: { claim: () => Promise.resolve() },
};
const caches = { open: () => Promise.resolve({ put: () => Promise.resolve(), add: () => Promise.resolve() }), match: () => Promise.resolve(undefined), keys: () => Promise.resolve([]), delete: () => Promise.resolve(true) };
vm.runInNewContext(source, { self, caches, fetch: () => Promise.resolve({ ok: true, clone: () => ({}) }), URL, Promise });

/** Whether the worker takes the request on (and so caches its answer). */
function handled(path: string): boolean {
  let taken = false;
  handlers.fetch({ request: { method: "GET", url: `${ORIGIN}${path}` }, respondWith: () => (taken = true) });
  return taken;
}

part("Pages drawn for the signed-in viewer are never cached");
const privatePaths = ["/@shop/letters/abc", "/letters/abc", "/@shop/letters", "/invite/abc", "/@shop/sign/abc", "/sign/abc", "/@shop/pay/abc", "/pay/abc", "/@shop/podcast/abc", "/podcast/abc"];
is("none of them", privatePaths.filter(handled), []);
is("nor the ones already private", ["/@shop/thanks", "/@shop/course/x", "/studio", "/library", "/@shop/review/x"].filter(handled), []);

part("Public pages still work offline");
is("a store's front page, a product page and the site's home", ["/@shop", "/@shop/p/abc", "/", "/pricing", "/@shop/shop", "/@shop/lettersx"].map(handled), [true, true, true, true, true, true]);

part("The copies already kept go");
is("the cache has a new name", /const CACHE = "nimbus-v8";/.test(source), true);

done();
