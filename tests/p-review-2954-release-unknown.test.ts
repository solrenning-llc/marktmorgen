/**
 * Review proof for #2954: if the SET NX answer and its read-back are unknown,
 * startJob tries to release its private mark before retaining the due item.
 * A release script that is also unconfirmed may leave that 30-day mark in
 * place. The next run then sees "taken", removes the due item, and sends no
 * reminder even though no job was ever created.
 */
import { createHash } from "node:crypto";
import { runEventQueue } from "@/lib/community-event-mail";
import { db, event, reset, sent, store } from "./community-mail-read-world";
import { done, is, part } from "./check";

type Command = (string | number)[];
const original = db.pipeline.bind(db);

async function main(): Promise<void> {
  reset();
  const due = `${store.community!.id}|${store.handle}|${event.id}|24|${event.start}`;
  const id = createHash("sha256")
    .update(`${store.community!.id}|${event.id}|24|${event.start}`)
    .digest("hex")
    .slice(0, 24);
  const mark = `nl:cm:evmail:${id}:made`;
  db.run(["ZADD", "nl:cm:evq", 1, due]);

  let releaseAttempted = false;
  db.pipeline = async (commands: Command[]) => {
    const only = commands[0];
    if (commands.length === 1 && only[0] === "SET" && only[1] === mark && only.includes("NX")) {
      await original(commands); // The write landed, but its answer was lost.
      return [undefined];
    }
    if (commands.length === 1 && only[0] === "GET" && only[1] === mark) return [undefined];
    if (commands.length === 1 && only[0] === "EVAL" && only[3] === mark) {
      releaseAttempted = true;
      return [undefined]; // The compare-delete did not run and did not confirm anything.
    }
    return original(commands);
  };

  part("An unknown release must not turn a retained reminder into 'already made'");
  const first = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
  db.pipeline = original;
  is("the uncertain first run sends nothing and keeps the due item", [first.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"]), releaseAttempted], [0, 0, 1, true]);
  is("a failed release does not leave a mark that falsely says the job exists", db.run(["GET", mark]), null);

  const second = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
  is("the next healthy run creates and sends the retained reminder once", [second.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"])], [1, 1, 0]);
  done();
}

void main();
