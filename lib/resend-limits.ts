/**
 * How often a buyer's purchase email may be sent again from the studio (app/api/store/resend/route.ts, one sale;
 * lib/sales-bulk.ts, several at once): one sale's in a day, and one store's in an hour. Both ways keep the same
 * two counts, so choosing many orders at once never sends more than choosing them one by one. The single resend's
 * route keeps its own copy of the two numbers (that file is reserved by Codex N for #2674); tests/sales-bulk.test.ts
 * holds them equal.
 */
export const RESEND_PER_SALE_PER_DAY = 3;
export const RESEND_PER_STORE_PER_HOUR = 30;
