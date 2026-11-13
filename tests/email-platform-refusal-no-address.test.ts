/**
 * A platform's refusal of an address never carries the address into the error (nuvem I privacy audit of main
 * @3cdc624a7d, 13 November 2026).
 *
 * lib/email-platforms.ts failure() put up to 200 characters of the platform's own words into a refused contact's
 * error ("Mailchimp refused this address: jane@… looks fake or invalid"). Platforms usually echo the address, and
 * that message is logged whole by the sync, the sale, the free-copy and the waitlist paths (console.error(…, error))
 * and kept as the sync job's lastError: a buyer's address in the hosting provider's logs, where no erasure reaches
 * it. The platform's reason stays; every address in its words is said as "this address".
 *
 * Synthetic transport only (tests/email-platform-target-world.ts): no DNS, socket, provider account or real key.
 */
import { PlatformError, addContact } from "@/lib/email-platforms";
import { answerWith } from "./email-platform-target-world";
import { done, is, part } from "./check";

const KEY = `${"a".repeat(32)}-us21`;
const person = "Jane.Doe+shop@Example.test";
const other = "someone.else@example.org";

async function refusal(detail: string): Promise<PlatformError | null> {
  answerWith({ status: 400, body: JSON.stringify({ title: "Invalid Resource", detail }) });
  try {
    await addContact("mailchimp", KEY, "list0001", { email: person, firstName: "", tags: [] }, new Map() as never);
    return null;
  } catch (error) {
    return error instanceof PlatformError ? error : null;
  }
}

async function main(): Promise<void> {
  part("A refused address is never in the error that is logged and kept");
  const echoed = await refusal(`${person.toLowerCase()} looks fake or invalid, please enter a real email address.`);
  is("the refusal is a contact error", echoed?.kind, "contact");
  is("its message keeps the platform's reason", /looks fake or invalid/.test(echoed?.message ?? ""), true);
  is("but never the address, in any case", /jane\.doe/i.test(echoed?.message ?? ""), false);
  const named = await refusal(`${other} and ${person.toUpperCase()} were refused.`);
  is("no address at all is left in it, the person's or another", /@/.test(named?.message ?? ""), false);
  is("each is said as this address", (named?.message ?? "").includes("this address and this address were refused"), true);
  const plain = await refusal("Your merge fields were invalid.");
  is("words with no address are kept as they are", plain?.message, "Mailchimp refused this address: Your merge fields were invalid.");
  done();
}

void main();
