/**
 * A free copy refused for an unknown counter says so truthfully (audit SG2,
 * CX-123 rule 24).
 *
 * serveFile (lib/serve-file.ts) asks freeDeliveryPause before a free copy.
 * A counter read past the line pauses it, saying only what is true: the
 * store reached its free download allowance (the creator is written to only
 * past the 200 GB allowance, so the page never says they were told);
 * a counter that could not be read, or came back in another shape, also
 * refuses it, but never says the store gave away too much or that the
 * creator was told: it says the download could not be checked. A free copy
 * whose delivery could not be counted (INCRBY unknown or failing) is refused
 * the same way, so an uncounted free copy never goes out. A paid file goes
 * out whatever the counter says, as before.
 *
 * Only the signed token Blob's API would issue is a stand-in
 * (tests/blob-download-attachment-world.ts); Redis is the in-memory one.
 */
import { serveFile } from "@/lib/serve-file";
import { REDIRECT_ABOVE_BYTES, type ProductFile } from "@/lib/product-file";
import { FREE_PAUSE_ABOVE_BYTES } from "@/lib/delivery";
import { store as redis } from "./redis-stub";
import { resetBlobWorld } from "./blob-download-attachment-world";
import { done, is, part } from "./check";

const UNKNOWN = "We couldn't check this download right now. Please try again in a few minutes.";
const OVER = "This free download is paused until next month. This store has reached its free download allowance for this month. Anything you have bought is unaffected. Please try again next month or contact the creator.";
const GB = 1024 * 1024 * 1024;

type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
let rule: Rule | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (rule && rule.when(commands)) {
    if (rule.reply === "throw") throw new Error("the database did not answer");
    return rule.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;
const first = (name: string) => (commands: (string | number)[][]) =>
  commands[0]?.[0] === name && String(commands[0]?.[1]).startsWith("nl:store:delivery:");

const FOLDER = "0123456789abcdef0123456789abcdef";
const big: ProductFile = {
  pathname: `stores/${FOLDER}/prod01/field-guide-Xy12AbCdEf.pdf`,
  name: "Field guide.pdf",
  bytes: REDIRECT_ABOVE_BYTES + 5 * 1024 * 1024,
  contentType: "application/pdf",
  addedAt: "2026-01-01T00:00:00.000Z",
};

async function answer(paid: boolean): Promise<[number, string]> {
  resetBlobWorld();
  const response = await serveFile(big, { paid });
  return [response.status, response.status === 302 ? "" : await response.text()];
}

async function main(): Promise<void> {
  redis.clear();

  part("a free copy over the line: paused, and said truthfully");
  // Free copies pause past 50 GB; the creator is written to only past the 200 GB allowance, by the daily watch
  // (app/api/cron/usage). Between the two nobody has been told, so the page never says so.
  for (const bytes of [FREE_PAUSE_ABOVE_BYTES + 1, 60 * GB, 199 * GB, 250 * GB]) {
    rule = { when: first("GET"), reply: [String(bytes)] };
    const [status, text] = await answer(false);
    is(`at ${Math.round(bytes / GB)} GB: paused`, [status, text], [429, OVER]);
    is(`at ${Math.round(bytes / GB)} GB: never says the creator was told`, text.includes("told"), false);
  }

  part("a free copy whose counter is unknown: refused, and said truthfully");
  for (const [label, reply] of [
    ["a count that is not a number", ["lots"]],
    ["a negative count", ["-5"]],
    ["a count that is an object", [{ n: 5 }]],
    ["an empty reply", []],
    ["a Redis that cannot be asked", "throw"],
  ] as [string, unknown][]) {
    rule = { when: first("GET"), reply };
    const [status, text] = await answer(false);
    is(`${label}: refused as not checked`, [status, text], [503, UNKNOWN]);
    is(`${label}: never says the creator was told`, text.includes("told"), false);
  }

  part("a free copy that could not be counted is not handed out");
  for (const [label, reply] of [
    ["INCRBY answered null", [null, 1]],
    ["INCRBY answered text", ["123", 1]],
    ["INCRBY could not be asked", "throw"],
  ] as [string, unknown][]) {
    rule = { when: first("INCRBY"), reply };
    is(`${label}: refused as not checked`, await answer(false), [503, UNKNOWN]);
    is(`${label}: a paid file still goes out`, (await answer(true))[0], 302);
  }

  part("what was fine stays fine");
  rule = { when: first("GET"), reply: ["lots"] };
  is("a paid file never asks the counter", (await answer(true))[0], 302);
  rule = null;
  is("a free copy with a real counter goes out", (await answer(false))[0], 302);

  done();
}

void main();
