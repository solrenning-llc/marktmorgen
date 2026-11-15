/** Synthetic world for tests/ap1-e-access-ending-send.test.ts: memory Redis, a stubbed Stripe and mailer. No real I/O. */
import { MemoryRedis } from "@/lib/redis-memory";

export const memory = new MemoryRedis();
export const isRedisConfigured = () => true;
export const isSenderConfigured = () => true;
export const platformKey = () => "synthetic";
export const tokensFor = async (_list: string, emails: string[]) => new Map(emails.filter((e) => e !== "left@example.com").map((e) => [e, `stop-${e}`]));
export const readListings = async () => [{ id: "prod000001", title: "Pottery Club" }];
export const storeBase = () => "https://marktmorgen.com/@kiln";
export const fromLine = () => "Kiln Works <kiln@example.com>";
export const render = (store: { mail?: { address?: string } }, subject: string, text: string) => ({ subject, text: `${text}\n\n${store.mail?.address ?? ""}`, headers: {} });
export const productOfSub = () => "prod000001";
export const endsAtOf = (sub: { cancel_at?: number | null }) => (typeof sub.cancel_at === "number" && sub.cancel_at > 0 ? sub.cancel_at : null);

export const mails: { to: string; subject: string; text: string; meter: unknown }[] = [];
export let sendOk = true;
export const sendEmail = async (m: { to: string; subject: string; text: string; meter: unknown }) => { if (!sendOk) return false; mails.push(m); return true; };

/** What Stripe says when a subscription is read again just before sending; by id. */
export const fresh = new Map<string, unknown>();
export const onAccount = async (_method: string, _account: string, path: string) => {
  const id = path.split("/").pop()!;
  if (!fresh.has(id)) throw new Error("synthetic unreadable subscription");
  return fresh.get(id);
};

export function reset(): void { memory.clear(); mails.length = 0; fresh.clear(); sendOk = true; }
export function failSends(): void { sendOk = false; }
export const redisPipeline = (commands: (string | number)[][]) => memory.pipeline(commands);
