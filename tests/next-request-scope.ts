/**
 * Imported first by a test that draws a page reading headers(): gives Next
 * the AsyncLocalStorage its own server sets up before any of its modules
 * load, so the test can run the page inside a request scope made with
 * Next's own stores (workAsyncStorage, workUnitAsyncStorage), as a real
 * request would. Nothing else changes: outside such a scope every store
 * is empty, as before.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const global = globalThis as { AsyncLocalStorage?: unknown };
global.AsyncLocalStorage ??= AsyncLocalStorage;
