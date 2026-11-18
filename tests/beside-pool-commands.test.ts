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
import * as storeModule from "@/lib/store";
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
// The sweep's batch (lib/store.ts, moveBesideToPool; Claude 4's MEDIUM on #4847): the lock taken and let go, the store
// read, the pool's fields and the room's slots read, the lock held on, then the pool's TAKE_DATA for its shares and the
// room's TAKE_DATA giving them back, each counted at its inner commands. The room's key may list expiring months, so its
// script also reads and removes the months that are over and rewrites the list: 7 + 2 a slot (takeDataCommands).
const st = storeModule as unknown as { MOVE_BESIDE_BATCH: number; MOVE_BESIDE_BATCH_COMMANDS: number };
const dd = data as unknown as { takeDataCommands?: (slots: number) => number; DATA_EXPIRED_COMMANDS: number };
is("a room take costs its EVAL, its 4 fixed commands, the months that are over, and 2 a slot", dd.takeDataCommands?.(1), 1 + 4 + dd.DATA_EXPIRED_COMMANDS + 2);
is(
  "a sweep batch is priced at both scripts' inner commands",
  st.MOVE_BESIDE_BATCH_COMMANDS,
  3 + 1 + 2 + 1 + (d.poolTakeCommands?.(st.MOVE_BESIDE_BATCH) ?? 0) + (dd.takeDataCommands?.(st.MOVE_BESIDE_BATCH) ?? 0),
);
done();
