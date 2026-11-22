/**
 * A connected Discord server already kept for a store, set up for the tests that read it, check members or switch it:
 * the plain SET the production writer made before it was fenced on the store being live (lib/discord-store.ts,
 * saveServer; Codex L-20261120-0732). A fixture only, never the production writer: the real write is tested through
 * the routes in tests/discord-server-after-erasure.test.ts.
 */
import { redisPipeline } from "@/lib/redis";
import type { DiscordServer } from "@/lib/discord-rules";

export async function seedDiscordServer(room: string, server: DiscordServer): Promise<void> {
  await redisPipeline([["SET", `nl:dc:srv:${room}`, JSON.stringify(server)]]);
}
