import { state } from './service-counter-admission-world';
import type { Store } from '@/lib/store';

export const events: string[] = [];
export const shop = { sid: 'c'.repeat(32), statsId: 'c'.repeat(32), handle: 'synthetic-shop' } as Store;
export const calls = { pay: 0, connect: 0 };
export function resetRoute() { events.length = 0; calls.pay = 0; calls.connect = 0; }
export async function guardStoreWrite(request: Request) {
  return { ok: true as const, body: await request.json(), ref: 'operator@example.test' };
}
export const text = (value: unknown, maximum: number) => typeof value === 'string' ? value.slice(0, maximum) : '';
export async function storeForEmail() { return shop; }
export const affiliatesOn = () => true;
export async function payWithPayPal() {
  calls.pay += 1; events.push('pay');
  if (state.quotaCalls !== 1 || state.commands.length !== 2) throw new Error('Payment preceded confirmed admission');
  return { ok: true, sent: 1 };
}
export async function connectPayPal() {
  calls.connect += 1; events.push('connect');
  if (state.quotaCalls !== 1 || state.commands.length !== 2) throw new Error('Connection preceded confirmed admission');
  return { ok: true };
}
export async function readPayPal() { return { client: 'synthetic' }; }
export async function disconnectPayPal() { throw new Error('Unexpected disconnect'); }
export async function setAutoPay() { throw new Error('Unexpected auto'); }
export async function settlePayPal() { throw new Error('Unexpected settlement'); }
