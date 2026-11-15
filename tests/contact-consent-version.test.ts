/**
 * A yes to a creator's list keeps which words it was given to (GDPR art. 7(1): the sender must be able to show what
 * was agreed to). Before, a contact kept `agreed`, `agreedAt` and `source` (how they first agreed), never the
 * version of the sentence they ticked, so a change of the box's words could not be told apart afterwards (5FNwB's
 * finding on main 4865799f53, MÉDIO, law).
 *
 * Now every own yes keeps LIST_CONSENT_VERSION, where it was given and when (lib/contact-consent.ts,
 * lib/contacts.ts upsertContact), and the words the version stands for are pinned here by their fingerprint, in
 * every language a store speaks: a sentence changed without a new version fails.
 *
 * Synthetic only: the Redis stand-in and a fetch stub for the confirmation email.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { wordsIn } from "@/lib/buyer-words";
import { FORM_WORDS } from "@/lib/buyer-words/form";
import { JOIN_WORDS } from "@/lib/buyer-words/join";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { CONSENT_PLACES, LIST_CONSENT_FINGERPRINT, LIST_CONSENT_VERSION } from "@/lib/contact-consent";
import { leadsKey, parseContact, upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setJoin, setSubscription, storeForEmail } from "@/lib/store";
import { askToJoin, confirmJoin } from "@/lib/store-join";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const messages: { text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.resend.com") throw new Error(`Unexpected provider: ${url.hostname}`);
  messages.push(JSON.parse(String(init?.body)) as { text: string });
  return new Response(JSON.stringify({ id: "email_consent_version_test" }));
}) as typeof fetch;

const OWNER = "consent-version@example.com";
const STORE = "{store}";

/** Every sentence the version stands for, in a fixed order: by language, then by box. */
function listConsentWords(): string[] {
  return LANGUAGE_CODES.flatMap((code) => {
    const w = wordsIn(code);
    return [w.alsoEmails(STORE), w.alsoOtherEmails(STORE), w.alsoClicks(STORE), FORM_WORDS[code].hearFrom(STORE), JOIN_WORDS[code].line(STORE)];
  });
}

async function main(): Promise<void> {
  part("The words: a version tied to every sentence of a yes to the list, in every language");
  {
    const fingerprint = createHash("sha256").update(listConsentWords().join("\n")).digest("hex");
    is("the words have not changed without a new version (move LIST_CONSENT_VERSION and LIST_CONSENT_FINGERPRINT together)", fingerprint, LIST_CONSENT_FINGERPRINT);
    is("seven languages, five sentences each", listConsentWords().length, LANGUAGE_CODES.length * 5);
  }

  redis.clear();
  process.env.RESEND_API_KEY = "re_test_join_only";
  await claimHandle(OWNER, "consentversion", "Consent Version Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Consent0001", subscriptionId: "sub_Consent0001", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  await setJoin(OWNER, { on: true });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId!;
  const contact = (email: string) => parseContact(redis.run(["HGET", leadsKey(listId), email]));
  const kept = (email: string) => {
    const c = contact(email);
    return [c?.consentVersion, c?.consentFrom, c?.consentAt];
  };

  part("A ticked box at checkout keeps the version, the place and when");
  {
    const at = "2026-11-15T10:00:00.000Z";
    await upsertContact(listId, "ana@example.com", { agreed: true, explicit: true, source: "buyer", at, consent: "checkout" }, null);
    is("version, place and time of the yes", kept("ana@example.com"), [LIST_CONSENT_VERSION, "checkout", at]);
    is("and the yes itself, as before", [contact("ana@example.com")?.agreed, contact("ana@example.com")?.agreedAt], [true, at]);
  }

  part("A later yes from another place is the one kept; an older tick repeated never replaces it");
  {
    const later = "2026-11-15T11:00:00.000Z";
    await upsertContact(listId, "ana@example.com", { agreed: true, explicit: true, source: "free", at: later, consent: "free" }, null);
    is("the newer yes, with its place", kept("ana@example.com"), [LIST_CONSENT_VERSION, "free", later]);
    await upsertContact(listId, "ana@example.com", { agreed: true, explicit: true, source: "buyer", at: "2026-11-15T10:00:00.000Z", consent: "checkout" }, null);
    is("a thank-you page of the older order reloaded leaves it", kept("ana@example.com"), [LIST_CONSENT_VERSION, "free", later]);
    is("the first yes's time is still the first", contact("ana@example.com")?.agreedAt, "2026-11-15T10:00:00.000Z");
  }

  part("No version without words shown: a purchase without the box, or a yes nobody ticked here");
  {
    await upsertContact(listId, "ben@example.com", { agreed: false, explicit: false, source: "buyer", at: "2026-11-15T10:00:00.000Z", consent: "checkout" }, null);
    is("a purchase without the box keeps no consent record", kept("ben@example.com"), [undefined, undefined, undefined]);
    await upsertContact(listId, "cy@example.com", { agreed: true, explicit: true, source: "import" }, null);
    is("a yes recorded without a place (the company's own checks) keeps no version", kept("cy@example.com"), [undefined, undefined, undefined]);
  }

  part("The sign-up box and a store's form, through the confirmation button");
  {
    is("the box sends its confirmation", await askToJoin({ store, email: "dee@example.com", ip: "192.0.2.10", origin: "https://example.com" }), "sent");
    const boxToken = messages.at(-1)?.text.match(/join\?token=([0-9a-f]{48})/)?.[1] ?? "";
    is("confirmed", (await confirmJoin(boxToken, store)).ok, true);
    is("kept as a yes on the sign-up box", kept("dee@example.com").slice(0, 2), [LIST_CONSENT_VERSION, "join"]);

    is("a form sends its confirmation", await askToJoin({ store, email: "eli@example.com", ip: "192.0.2.11", origin: "https://example.com", fromForm: true, formId: "abcdefghij" }), "sent");
    const formToken = messages.at(-1)?.text.match(/join\?token=([0-9a-f]{48})/)?.[1] ?? "";
    is("confirmed", (await confirmJoin(formToken, store)).ok, true);
    is("kept as a yes on a form", kept("eli@example.com").slice(0, 2), [LIST_CONSENT_VERSION, "form"]);
  }

  part("A record read back keeps only what this module writes");
  {
    const row = (extra: Record<string, unknown>) => JSON.stringify({ agreed: true, agreedAt: "2026-11-15T10:00:00.000Z", firstAt: "", lastAt: "", titles: [], ids: [], source: "buyer", unsub: false, unsubAt: "", t: "", name: "", tags: [], importedAt: "", ...extra });
    const read = (extra: Record<string, unknown>) => {
      const c = parseContact(row(extra));
      return [c?.consentVersion, c?.consentFrom, c?.consentAt];
    };
    is("a whole record", read({ consentVersion: "list-1", consentFrom: "waitlist", consentAt: "2026-11-15T10:00:00.000Z" }), ["list-1", "waitlist", "2026-11-15T10:00:00.000Z"]);
    is("a version in another shape is not a version", read({ consentVersion: "v1", consentFrom: "waitlist", consentAt: "2026-11-15T10:00:00.000Z" }), [undefined, undefined, undefined]);
    is("a place this module never writes is not kept", read({ consentVersion: "list-1", consentFrom: "elsewhere", consentAt: "2026-11-15T10:00:00.000Z" }), [undefined, undefined, undefined]);
    is("every place has a name the module knows", [...CONSENT_PLACES], ["checkout", "free", "waitlist", "join", "form"]);
  }

  part("Every own yes in the code names its place");
  {
    // Each call that records a ticked box passes `consent`; the only one without is the company's own bounce and
    // complaint check (lib/verify-mail.ts), which no person ticked.
    const calls = (file: string) => {
      const text = readFileSync(file, "utf8");
      const found: string[] = [];
      for (let i = text.indexOf("upsertContact("); i >= 0; i = text.indexOf("upsertContact(", i + 1)) {
        const open = text.indexOf("{", i);
        const close = text.indexOf("}", open);
        if (/export async function/.test(text.slice(Math.max(0, i - 25), i))) continue;
        found.push(text.slice(open, close + 1));
      }
      return found;
    };
    const expected: [string, string][] = [
      ["lib/buyer-list.ts", "checkout"],
      ["app/[handle]/thanks/page.tsx", "checkout"],
      ["lib/free.ts", "free"],
      ["lib/waitlist.ts", "waitlist"],
      ["lib/store-join.ts", "grant.f"],
    ];
    for (const [file, place] of expected) {
      const found = calls(file);
      is(`${file}: every yes it records names its place`, found.length > 0 && found.every((args) => args.includes(`consent: ${place.startsWith("grant") ? "" : '"'}${place}`)), true);
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
