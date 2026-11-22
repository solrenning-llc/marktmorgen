/**
 * How many contacts each plan's list can really hold (457 [EL1], unit 2).
 *
 * Every contact is taken from the plan's data room (lib/contacts.ts,
 * needContacts), so a list fills its room before MAX_LEADS on a plan whose
 * room is smaller than MAX_LEADS of the smallest contact (docs/contacts-cost.md,
 * unit 1). The pages say this figure, computed here from the code's own
 * constants, never a number typed by hand. It is the most with nothing else
 * stored: products, orders and community records share the same room. Server
 * only (lib/contacts.ts opens Redis).
 */
import { MAX_LEADS } from "@/lib/contact-rules";
import { contactBytes, type Contact } from "@/lib/contacts";
import { DATA_ROOM_BYTES } from "@/lib/store-data-rules";
import { PLAN_TITLES, TIERS, type Tier } from "@/lib/plan";

const ISO = new Date(0).toISOString();

/** A yes from a form, with nothing else: the least a contact can take. */
export function smallestContact(): Contact {
  return { agreed: true, agreedAt: ISO, firstAt: ISO, lastAt: ISO, titles: [], ids: [], source: "free", unsub: false, unsubAt: "", t: "", name: "", tags: [], importedAt: "" };
}

/** The most contacts a plan's list can hold: its data room over the smallest contact, never above MAX_LEADS. */
export function contactCeiling(tier: Tier): number {
  return Math.min(MAX_LEADS, Math.floor(DATA_ROOM_BYTES[tier] / contactBytes(smallestContact())));
}

const n = (value: number) => value.toLocaleString("en-US");
const names = (titles: string[]) => (titles.length < 3 ? titles.join(" and ") : `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`);

/**
 * "up to 19,067 people on Store and 100,000 on Studio and Scale": each plan once, the plans with the same figure
 * together, from the least to the most.
 */
export function contactCeilingWords(noun = "people"): string {
  const byValue = new Map<number, string[]>();
  for (const tier of TIERS) byValue.set(contactCeiling(tier), [...(byValue.get(contactCeiling(tier)) ?? []), PLAN_TITLES[tier]]);
  const parts = [...byValue.entries()].sort((a, b) => a[0] - b[0]).map(([value, titles], i) => `${n(value)}${i === 0 ? ` ${noun}` : ""} on ${names(titles)}`);
  return `up to ${parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}`;
}
