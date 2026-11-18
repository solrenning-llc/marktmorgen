/**
 * The beside pool's writes are priced at what Upstash bills: a script's inner commands beside its EVAL
 * (lib/receipt-number.ts counts TAKE_DATA's steps the same way). A product save while the store pays reads which of
 * its products the pool holds (one HMGET), takes the new shares (one TAKE_DATA on the pool key) and, when the room
 * then refuses the write, gives them back (one more). The pool key never lists expiring months, so its TAKE_DATA runs
 * its EVAL, HGET "#", HGET "~", an HGET and a write a slot, and HSET "#": 4 + 2 a slot (poolTakeCommands). The studio
 * line prices BESIDE_SAVE_COMMANDS on every studio request (Claude 4 on #4847: TAKE_DATA's inner commands were counted
 * as one). Synthetic, read through the modules so this file runs, and fails, where the figures are not there yet.
 */
import * as data from "@/lib/store-data";
import * as registry from "./plan-cost-registry";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { done, is } from "./check";

const d = data as unknown as { poolTakeCommands?: (slots: number) => number; BESIDE_SAVE_COMMANDS?: number; TAKE_DATA: string };
const r = registry as unknown as { besideSaveUsd?: (tier: "creator" | "pro" | "scale") => number; COMMAND: number; COST_LINES: { id: string; sources: { file: string; names: string[] }[] }[] };

// The pool's script, on a key with no month list: the commands it reaches, read from its own text.
const script = d.TAKE_DATA;
is("TAKE_DATA reads the total and the month list once each", [script.includes("redis.call('HGET', KEYS[1], '#')"), script.includes("redis.call('HGET', KEYS[1], '~')")], [true, true]);
is("a pool take costs its EVAL and 3 fixed commands, and 2 a slot", [d.poolTakeCommands?.(1), d.poolTakeCommands?.(25), d.poolTakeCommands?.(250)], [6, 54, 504]);
is("a product save adds the pool's read, its take and, refused, its give-back", d.BESIDE_SAVE_COMMANDS, 1 + 2 * 6);
for (const tier of ["creator", "pro", "scale"] as const) {
  is(`priced on every studio request (${tier})`, r.besideSaveUsd?.(tier), STORE_ALLOWANCES[tier].studio * 13 * r.COMMAND);
}
const studio = r.COST_LINES.find((line) => line.id === "studio");
is("the studio line names the pool's commands", Boolean(studio?.sources.some((s) => s.file === "lib/store-data.ts" && s.names.includes("BESIDE_SAVE_COMMANDS"))), true);
done();
