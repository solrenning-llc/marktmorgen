import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListHealthTable } from "@/components/list-health-table";
import { listHealth } from "@/lib/mail-health";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// Exercise the existing reader and the new real server component together.
// Only the Redis reply is replaced; no sender, account or real store is used.
const id = "a".repeat(32);
const now = Date.UTC(2026, 10, 5, 12);
const original = redis.pipeline.bind(redis);
let reply: unknown;
redis.pipeline = async (commands) => {
  if (commands.length === 8 && commands[0]?.[0] === "GET" && commands.slice(1).every(command => command[0] === "HMGET")) {
    return reply as Awaited<ReturnType<typeof original>>;
  }
  return original(commands);
};
const emptyDay = () => [null, null, null];
const exact = () => [null, ["1000", "24", "4"], ...Array.from({ length: 6 }, emptyDay)];

async function readAndRender(value: unknown) {
  reply = value;
  try {
    const health = await listHealth(id, now);
    return { health, html: renderToStaticMarkup(createElement(ListHealthTable, { health })) };
  } catch {
    return null;
  }
}

async function main() {
  part("Confirmed counts and absence remain usable");
  const known = await readAndRender(exact());
  is("the real reader preserves all three confirmed counts", known?.health, { sent: 1000, bounced: 24, complained: 4 });
  is("the new component offers the confirmed count and distance", Boolean(known?.html.includes('>24</td>') && known.html.includes('>1</td>')), true);
  const absent = await readAndRender([null, ...Array.from({ length: 7 }, emptyDay)]);
  is("seven explicit absent days confirm nothing sent", absent?.html.includes("Nothing was sent in these 7 days"), true);

  part("Unknown source evidence must not become exact zero or a distance");
  const cases: [string, unknown][] = [
    ["a day's HMGET omitted bounce and complaint fields", [null, ["1000"], ...Array.from({ length: 6 }, emptyDay)]],
    ["six daily replies missing from the outer response", [null, ["1000", "24", "4"]]],
    ["one daily reply is not an HMGET array", [null, false, ...Array.from({ length: 6 }, emptyDay)]],
    ["a bounce count is not a canonical count", [null, ["1000", "", "4"], ...Array.from({ length: 6 }, emptyDay)]],
  ];
  for (const [name, value] of cases) {
    const result = await readAndRender(value);
    is(name + ": no authoritative counts, absence sentence or remaining room", result === null || (!result.html.includes("<table") && !result.html.includes("Nothing was sent")), true);
  }
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
