/**
 * Review proof (#2608): when the contact counter's reply is unknown (Redis
 * threw), the visitor's FIRST message is answered "limited", whose words say
 * they sent too many messages. The count is not known; nothing was over.
 */
import { claimHandle, ensureStatsId, setContact, storeForEmail } from "@/lib/store";
import { sendContact } from "@/lib/store-contact";
import { contactWords } from "@/lib/buyer-words/contact";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }))) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_contact_only";
  const owner = "maker@example.com";
  await claimHandle(owner, "makershop", "Maker Shop", "");
  await ensureStatsId(owner);
  await setContact(owner, { on: true });
  const real = redis.pipeline.bind(redis);
  let thrown = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => String(c[1]).startsWith("nl:rl:contact-ip:"))) { thrown++; throw new Error("Redis timed out"); }
    return real(commands);
  }) as typeof redis.pipeline;
  part("first message, counter unknown");
  const result = await sendContact({ store: (await storeForEmail(owner))!, name: "Dana", email: "dana@example.com", message: "Hello! Could we work together on a cookbook?", ip: "1.1.1.1" });
  const shown = result === "limited" ? contactWords("en").notices.limited.title : result;
  is("the counter was never read (it threw once)", thrown, 1);
  is("an unknown count must not be told 'Too many messages for now'", shown === "Too many messages for now", false);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
