/** A malformed saved position must not restart a walk or overwrite its old cursor. */
import { sendVerified } from "@/lib/verified-numbers";
import { world } from "./verified-cursor-world";
import { done, is, part } from "./check";

async function run(saved: unknown): Promise<string> {
  world.saved = saved;
  world.commands.length = 0;
  world.walks.length = 0;
  try { return JSON.stringify(await sendVerified(Date.now() + 10_000)); }
  catch (error) { return error instanceof Error ? error.name : "unexpected rejection"; }
}

async function main(): Promise<void> {
  part("Malformed saved cursors stop before walking or writing");
  for (const saved of [
    "", "broken", "0", "0|", "|0", "0|0|1", "garbage|0", "01|0", "0|01",
    "-1|0", "0|-1", "0|1.5", "0|1e2", "0|NaN", "0|Infinity", " 0|0", "0|0\n",
    "18446744073709551616|0", "0|9007199254740992",
  ]) {
    is(`refused: ${JSON.stringify(saved)}`, await run(saved), "UnknownReplyError");
    is("no store scan and no checkpoint write after an unreadable position", [world.walks, world.commands], [[], [["GET", "nl:verified:cursor"]]]);
  }
  part("Initial and valid saved cursors keep the normal walk");
  for (const [saved, cursor] of [[null, "0"], ["0|0", "0"], ["17|2", "17"], ["18446744073709551615|0", "18446744073709551615"]] as const) {
    is("the normal empty page completes", await run(saved), '{"stores":0}');
    is("the exact cursor reaches the scanner", world.walks, [cursor]);
    is("the existing checkpoint is written normally", world.commands, [["GET", "nl:verified:cursor"], ["SET", "nl:verified:cursor", "0|0"]]);
  }
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
