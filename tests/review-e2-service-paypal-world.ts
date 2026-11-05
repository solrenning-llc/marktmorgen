import type { Store } from "../lib/store";
export const store = { sid: "d".repeat(32), statsId: "e".repeat(32), handle: "synthetic-payout" } as Store;
export const payout = { calls: 0 };
export async function guardStoreWrite() { return { ok: true, ref: "synthetic@example.com|synthetic-payout", store, body: { op: "pay" } }; }
export async function storeForEmail() { return store; }
export function text(value: unknown, length: number) { return typeof value === "string" ? value.slice(0, length) : ""; }
export function affiliatesOn() { return true; }
export async function payWithPayPal() { payout.calls += 1; return { ok: true }; }
export async function connectPayPal() { throw Error("Unexpected connection"); }
export async function disconnectPayPal() { throw Error("Unexpected disconnect"); }
export async function readPayPal() { throw Error("Unexpected read"); }
export async function setAutoPay() { throw Error("Unexpected auto change"); }
export async function settlePayPal() { throw Error("Unexpected settlement"); }
