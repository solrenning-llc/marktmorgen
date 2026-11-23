/**
 * Claude 5's LEVE on #2885 (6704255534), still open per Codex S: writePath and forgetPath (lib/path.ts) took the
 * pipeline's first slot with `const [reply] = …`, so an envelope with one reply too many, [[1], "extra"], was read as
 * success: startPath answered ok and forgetPath did not throw. Both now read the envelope with repliesFor(…, 1), as
 * readPath already does: one reply too many is unknown (startPath "unavailable", forgetPath throws), and a real
 * answer still works. Synthetic only: the Redis stub.
 */
import { claimHandle, ensureStatsId } from "@/lib/store";
import { forgetPath, readPath, startPath } from "@/lib/path";
import { readAnswers } from "@/lib/path-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const real = redis.pipeline.bind(redis);

/** Every EVAL answers its real reply plus one reply too many; everything else is answered as it is. */
function extraOnEval(): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.some((c) => c[0] === "EVAL") ? [...replies, "extra"] : replies;
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "path-envelope@example.org";
  await claimHandle(owner, "pathenvelope", "Path Envelope", "");
  const store = (await ensureStatsId(owner))!;
  const read = readAnswers({ goalCents: 0, skills: "Teaching", subject: "Guides", minutes: 15, audience: "none", timeZone: "UTC" }, store.currency);
  if (!read.ok) throw new Error("answers");
  const answers = read.answers;
  const at = Date.UTC(2026, 10, 20, 12);

  part("writePath: one reply too many is not a save");
  extraOnEval();
  let started: Awaited<ReturnType<typeof startPath>>;
  try {
    started = await startPath(store, { ...answers }, at);
  } finally {
    redis.pipeline = real;
  }
  is("startPath answers unavailable, never ok", started.ok ? "ok" : started.reason, "unavailable");

  part("a real answer still saves");
  const saved = await startPath(store, { ...answers }, at);
  is("startPath answers ok", saved.ok, true);
  is("and the Path reads back", (await readPath(store))?.answers.subject, "Guides");

  part("forgetPath: one reply too many is not a removal");
  extraOnEval();
  let forgot: string;
  try {
    await forgetPath(store);
    forgot = "done";
  } catch {
    forgot = "threw";
  } finally {
    redis.pipeline = real;
  }
  is("forgetPath throws, never answers as forgotten", forgot, "threw");

  part("a real answer still forgets");
  await forgetPath(store);
  is("the Path is gone", await readPath(store), null);

  done();
}

void main();
