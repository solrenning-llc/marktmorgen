import { MemoryRedis } from "@/lib/redis-memory";
import type { Member, CommunityConfig } from "@/lib/community";
import type { CommunityEvent } from "@/lib/community-events";
import type { Store } from "@/lib/store";

export const db = new MemoryRedis();
export const commandsSeen: (string | number)[][] = [];
export const sent: unknown[][] = [];
export let readReply: (() => unknown) | null = null;
export const setReadReply = (reply: (() => unknown) | null) => { readReply = reply; };
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  commandsSeen.push(...commands);
  if (commands.length === 1 && commands[0][0] === "LRANGE" && readReply) return readReply() as unknown[];
  return db.pipeline(commands);
}
export const members = ["a", "b"].map((letter, i): Member => ({
  k: letter.repeat(32), e: `member${i}@example.com`, n: "Synthetic member", h: "", dir: false,
  mail: true, at: 1, seen: 0, muted: false, removed: false, t: letter.repeat(40), q: [], qq: [], qa: 0, s: [],
}));
export const config = { name: "Synthetic community", access: [] } as unknown as CommunityConfig;
export const event = { id: "c".repeat(12), title: "Synthetic event", start: Date.now() + 86_400_000,
  minutes: 30, tz: "UTC", only: [], cancelled: false, about: "", cap: 0, where: "room", meet: null,
  room: "synthetic-room", link: "", replay: null, post: "", at: 1, moves: 0, v: 1 } satisfies CommunityEvent;
export const store = { handle: "synthetic", name: "Synthetic store", email: "owner@example.com", language: "en",
  community: { id: "d".repeat(32), on: true }, mail: { fromName: "Synthetic store" } } as Store;
export const readConfig = async () => config;
export const readMembers = async (_community: string, keys: string[]) => new Map(members.filter(m => keys.includes(m.k)).map(m => [m.k, m]));
export const mailableMembers = async () => members;
export const readMember = async () => null;
export const setMail = async () => {};
export const setMemberToken = async () => {};
export const holdsTicket = async () => true;
export const mayAttend = async () => true;
export const readEvent = async () => event;
export const rsvpList = async () => members.map(m => ({ key: m.k }));
export const rsvpNumbers = async () => ({ going: 2 });
export const stillGoing = async () => new Set(members.map(m => m.k));
export const EVENT_QUEUE = "nl:cm:evq";
export const eventAddress = () => "https://example.com/event";
export const eventTimeIn = () => "November 6, 2026";
export const lengthIn = () => "30 minutes";
export const isSenderConfigured = () => true;
export const sendBatch = async (messages: unknown[]) => { sent.push(messages); return "sent"; };
export const BATCH_SIZE = 100;
export const CHECKED_BATCH_SIZE = 25;
export const SENDER_WAIT_NOTE = "Waiting for the sender.";
export const canWrite = () => true;
export const fromLine = () => "Synthetic <sender@example.com>";
export const storeSender = fromLine;
export const monthlyAllowance = () => 100;
export const reserve = async () => "ok";
export const release = async () => {};
export const render = (_store: unknown, subject: string, text: string) => ({ subject, text, html: text, headers: {} });
export const bodyHtml = (text: string) => text;
export const orderWrite = async () => {};
export const alertCreator = async () => false;

export function reset(): void {
  db.clear(); commandsSeen.length = 0; sent.length = 0; readReply = null;
}
