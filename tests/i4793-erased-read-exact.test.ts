/**
 * #4793: the contacts imports read who was deleted from the store, and the rows already on the list, only whole
 * (synthetic only; in-memory Redis).
 *
 * The pasted import (importContacts), the file import's dry run (previewContactRows) and its chunk
 * (importContactRows, also the API's add) read the store's prints (nl:erased:<listId>, suppressedAmongCommand) in
 * the same round trip as the list's rows. A reply that is not whole (not a list, one entry short, an entry of
 * another type) used to be read as "nobody was deleted": a deleted address came back as agreeing and the agreed
 * counter went up. Now any such reply throws UnknownReplyError (lib/redis-reply.ts): no row is written, no count
 * moves, and the import says it could not finish and can be run again. A whole reply works as before.
 */
import { store as redis } from "./redis-stub";
import { agreedKey, importContactRows, importContacts, leadsKey, previewContactRows } from "@/lib/contacts";
import { suppressCommand } from "@/lib/suppression";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { done, is, part } from "./check";

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);

/** Answers the HMGET whose key starts with `prefix` with `bad` while installed; every other reply as it is. */
function corrupt(prefix: string, bad: (whole: unknown) => unknown) {
  redis.pipeline = async (commands: Cmd[]) => {
    const out = (await original(commands)) as unknown[];
    return commands.map((c, i) => (c[0] === "HMGET" && String(c[1]).startsWith(prefix) ? bad(out[i]) : out[i]));
  };
}
const restore = () => {
  redis.pipeline = original;
};

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ran";
  } catch (error) {
    return `threw:${(error as Error).name}`;
  }
}

const OWNER = "i4793@example.com";
const ERASED = "gone@example.com";
const OTHER = "kept@example.com";

// A fresh store whose list holds the deleted person's print and nothing else.
async function seed() {
  await claimHandle(OWNER, "i4793", "I4793", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId!;
  redis.run(suppressCommand(listId, ERASED, 1_794_608_400) as Cmd);
  is("the deleted person's print is there", redis.run(["HLEN", `nl:erased:${listId}`]), 1);
  return { store, listId };
}

async function main(): Promise<void> {
  let { store, listId } = await seed();
  const leads = () => redis.run(["HLEN", leadsKey(listId)]);
  const agreed = () => redis.run(["GET", agreedKey(listId)]);
  const row = (email: string) => redis.run(["HGET", leadsKey(listId), email]);

  const badPrints: [string, (whole: unknown) => unknown][] = [
    ["not a list", () => "not-an-array"],
    ["one entry short", (whole) => (Array.isArray(whole) ? whole.slice(0, -1) : whole)],
    ["an entry of another type", (whole) => (Array.isArray(whole) ? whole.map(() => ({})) : whole)],
    ["nothing", () => null],
  ];
  const badRows: [string, (whole: unknown) => unknown][] = [
    ["not a list", () => "not-an-array"],
    ["an entry of another type", (whole) => (Array.isArray(whole) ? whole.map(() => 7) : whole)],
  ];

  for (const [name, bad] of badPrints) {
    part(`Pasted import, deleted people's reply ${name}`);
    const before = { leads: leads(), agreed: agreed() };
    corrupt("nl:erased:", bad);
    const got = await outcome(() => importContacts(listId, [ERASED, OTHER], store));
    restore();
    is("the import throws UnknownReplyError", got, "threw:UnknownReplyError");
    is("the deleted address is not written back", row(ERASED), null);
    is("nobody is written", leads(), before.leads);
    is("the agreed count does not move", agreed(), before.agreed);

    part(`File import's dry run, deleted people's reply ${name}`);
    corrupt("nl:erased:", bad);
    const preview = await outcome(() => previewContactRows(listId, [{ email: ERASED, name: "", tags: [], consent: "agreed" }]));
    restore();
    is("the dry run throws UnknownReplyError", preview, "threw:UnknownReplyError");

    part(`File import's chunk, deleted people's reply ${name}`);
    corrupt("nl:erased:", bad);
    const chunk = await outcome(() => importContactRows(listId, [{ email: ERASED, name: "", tags: [], consent: "agreed" }, { email: OTHER, name: "", tags: [], consent: "agreed" }], store));
    restore();
    is("the chunk throws UnknownReplyError", chunk, "threw:UnknownReplyError");
    is("the deleted address is not written back", row(ERASED), null);
    is("nobody is written", leads(), before.leads);
    is("the agreed count does not move", agreed(), before.agreed);
  }

  for (const [name, bad] of badRows) {
    part(`Contacts' rows reply ${name}`);
    const before = { leads: leads(), agreed: agreed() };
    corrupt("nl:store:leads:", bad);
    const pasted = await outcome(() => importContacts(listId, [OTHER], store));
    const preview = await outcome(() => previewContactRows(listId, [{ email: OTHER, name: "", tags: [], consent: "agreed" }]));
    const chunk = await outcome(() => importContactRows(listId, [{ email: OTHER, name: "", tags: [], consent: "agreed" }], store));
    restore();
    is("the pasted import throws UnknownReplyError", pasted, "threw:UnknownReplyError");
    is("the dry run throws UnknownReplyError", preview, "threw:UnknownReplyError");
    is("the chunk throws UnknownReplyError", chunk, "threw:UnknownReplyError");
    is("nobody is written", leads(), before.leads);
    is("the agreed count does not move", agreed(), before.agreed);
  }

  part("Whole replies: everything works as before, the deleted person stays out");
  // A clean store, so these controls inherit nothing from the cases above.
  redis.clear();
  ({ store, listId } = await seed());
  is("control: the list starts empty", leads(), 0);
  const dry = await previewContactRows(listId, [{ email: ERASED, name: "", tags: [], consent: "agreed" }, { email: OTHER, name: "", tags: [], consent: "agreed" }]);
  is("the dry run says the other address would be added", dry.outcomes[1].outcome, "added");
  is("the dry run does not add the deleted address", dry.outcomes[0].outcome === "added", false);
  const pasted = await importContacts(listId, [ERASED, OTHER], store);
  is("the pasted import adds the other address", pasted.added, 1);
  is("the deleted address is not written", row(ERASED), null);
  is("the other address is there, agreeing", JSON.parse(String(row(OTHER))).agreed, true);
  is("the agreed count went up by one", Number(agreed()), 1);
  const third = "third@example.com";
  const outcomes = await importContactRows(listId, [{ email: ERASED, name: "", tags: [], consent: "agreed" }, { email: third, name: "", tags: [], consent: "agreed" }], store);
  is("the chunk adds the new address", outcomes[1], "added");
  is("the chunk does not add the deleted one", outcomes[0] === "added", false);
  is("the deleted address is still not written", row(ERASED), null);
  done();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
