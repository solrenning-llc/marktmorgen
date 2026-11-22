/**
 * The daily pass never saves a position its own reader refuses. storesAfter
 * hands back the SCAN reply's cursor as String(reply[0]) unchecked, so a reply
 * such as null became "null|0": every later run then threw on the saved
 * position and the shared numbers expired silently. An unreadable next cursor
 * is unknown: the pass stops without writing, keeping the last good position.
 */
import { sendVerified } from "@/lib/verified-numbers";
import { world } from "./verified-cursor-writer-world";
import { done, is, part } from "./check";

async function run(next: string, delayMs: number, budgetMs: number): Promise<string> {
  world.next = next;
  world.delayMs = delayMs;
  world.commands.length = 0;
  world.walks.length = 0;
  try { return JSON.stringify(await sendVerified(Date.now() + budgetMs)); }
  catch (error) { return error instanceof Error ? error.name : "unexpected rejection"; }
}

const writes = () => world.commands.filter((c) => c[0] === "SET");

async function main(): Promise<void> {
  part("An unreadable next cursor from the scan is never saved as the position");
  for (const next of ["null", "undefined", "", "abc", "01", "-1", "1.5", "18446744073709551616", "[object Object]"]) {
    // The scan takes longer than the run's budget, so the pass stops right after it.
    is(`refused next ${JSON.stringify(next)}`, await run(next, 30, 10), "UnknownReplyError");
    is(`nothing written for next ${JSON.stringify(next)}`, writes(), []);
  }
  part("A readable next cursor is still saved when the budget runs out");
  for (const next of ["17", "18446744073709551615"]) {
    is("the pass ends normally", await run(next, 30, 10), '{"stores":0}');
    is("the next cursor is the saved position", writes(), [["SET", "nl:verified:cursor", `${next}|0`]]);
  }
  part("A complete walk still saves the start");
  is("the pass ends normally", await run("0", 0, 10_000), '{"stores":0}');
  is("the walk restarts from zero next time", writes(), [["SET", "nl:verified:cursor", "0|0"]]);
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
