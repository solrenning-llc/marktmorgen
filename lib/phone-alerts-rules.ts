/**
 * The phone-notification figures a page may show without loading
 * lib/phone-alerts.ts (which reaches Redis and the web-push keys): the
 * studio's panel and the public feature page read the same one the server
 * keeps to. Browser-safe.
 */

/** Devices one person may have on one store. */
export const MAX_DEVICES = 10;
