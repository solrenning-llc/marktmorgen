/**
 * Imported first by tests/r34-hook-own-id.test.ts: Next's request storage reads globalThis.AsyncLocalStorage
 * once, when its module loads, as Next's own server sets it before any route. With it, a route's after() runs
 * inside the request scope the test opens, as it does in a request.
 */
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
