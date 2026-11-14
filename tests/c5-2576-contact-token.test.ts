// Claude 5's proof on #2576 (second review, item 1; SHA256 575160c6… as posted), kept as a discovered test with its assertions unchanged.
/**
 * Claude 5's proof on #2576 (synthetic, MemoryRedis, no outside request).
 * forgetContactPerson now takes the contact in one round trip and deletes its
 * unsubscribe token (whose record holds the plain address) and the counters in
 * a second. When the second fails once, a healthy retry finds no contact
 * (answers 0) and the token record with the address stays for good.
 * On main e814fe6d both went in one pipeline: a failed pipeline left the
 * contact for the retry.
 */
import { forgetContactPerson } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let fetches = 0;
globalThis.fetch = (async () => { fetches++; throw new Error("No outside request"); }) as typeof fetch;
const LIST = "listx1", EMAIL = "ana@example.test", TOKEN = "cd".repeat(20);
const TOKEN_KEY = `nl:mail:unsub:${TOKEN}`;
const seed = async () => {
  redis.clear();
  const contact = { agreed: true, agreedAt: "2026-11-01", firstAt: "2026-11-01", lastAt: "2026-11-01", titles: [], ids: [], source: "free", unsub: false, unsubAt: "", tags: [], importedAt: "", t: TOKEN };
  await redis.pipeline([["HSET", `nl:store:leads:${LIST}`, EMAIL, JSON.stringify(contact)], ["SET", TOKEN_KEY, `${LIST}|${EMAIL}|shop`]]);
};
const left = async () => redis.pipeline([["HEXISTS", `nl:store:leads:${LIST}`, EMAIL], ["EXISTS", TOKEN_KEY]]);

async function main(): Promise<void> {
  const pipe = redis.pipeline.bind(redis);
  part("Control: a healthy deletion");
  await seed();
  await forgetContactPerson(LIST, EMAIL);
  is("contact and token gone", await left(), [0, 0]);

  part("The token's deletion fails once, then a healthy retry");
  await seed();
  let once = true;
  redis.pipeline = (async (cs: (string | number)[][]) => {
    if (once && cs.some((c) => c[0] === "DEL" && c[1] === TOKEN_KEY)) { once = false; throw new Error("Redis request failed with status 503"); }
    return pipe(cs);
  }) as typeof redis.pipeline;
  const first = await forgetContactPerson(LIST, EMAIL).then((n) => `done ${n}`, () => "Error");
  redis.pipeline = pipe;
  is("the first run reports the failure", first, "Error");
  await forgetContactPerson(LIST, EMAIL).catch(() => 0);
  is("after the retry: contact and token record (with the address) gone", await left(), [0, 0]);
  is("no outside request", fetches, 0);
  done();
}
void main();
