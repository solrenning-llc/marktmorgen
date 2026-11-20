/**
 * Deleting one person from a store (added 17 October 2026): the shape every
 * module's own eraser is given, and the limits the whole erasure keeps.
 *
 * A creator presses "Delete this person" on a buyer's page in the studio, or
 * the person proves their address by an emailed link and asks for it
 * themselves (lib/erasure-request.ts). Either way lib/person-erasure.ts asks
 * every module that keeps something about a person of a store to forget it,
 * through one function each module exports itself, and the registry in
 * lib/person-data.ts says, for every module that keeps anything keyed by or
 * naming a person, what it keeps and what becomes of it. A module that
 * begins to keep something per person and is not in that registry fails
 * tests/person-data-registry.test.ts.
 *
 * Nothing in this file touches the network, so a page may import it.
 */
import type { Store } from "@/lib/store";

/** Everything an eraser needs to find one person in one store, worked out once. */
export type ErasureScope = {
  store: Store;
  /** The store's own ids, as each module keys by one of them. */
  sid: string;
  statsId: string;
  listId: string | null;
  /** The address, normalised (lib/auth.ts normaliseEmail). */
  email: string;
  /** The key a store's notes and fields are kept under (lib/person-key.ts). */
  person: string;
  /** The key courses and the community know the address by (lib/learn.ts emailKey). */
  learner: string;
  /** Every course of the store, with its lessons, as the courses' own records are keyed. */
  courses: { productId: string; courseId: string; lessonIds: string[]; moduleIds: string[] }[];
  /** How many dropped courses were looked at for a record of the person (lib/removed-courses.ts droppedCoursesOf). */
  droppedCourses?: number;
  /** How many of them were read whole, the person having a record there (lib/removed-courses.ts droppedCourseRecords). */
  droppedRecords?: number;
  /** Every product of the store, by id. */
  productIds: string[];
  /**
   * The products, not in the catalog, whose waitlists the person may still be on: marked coming soon or still being
   * dropped (lib/waitlist.ts waitlistMarks, #4462). Reached by the waitlist's eraser and copy only.
   */
  waitlistIds?: string[];
  /** How many waitlist marks were read to find them, the catalog's included: counted as ErasureSize.waitlists. */
  waitlistMarks?: number;
  /** The store's community, when it has one. */
  communityId: string | null;
  /** The checkout-ask count paid for before the erasers run. */
  checkoutAsks?: number;
};

/** Who asked: the store's team in the studio, or the person, by their emailed link. */
export type ErasureBy = "team" | "person";

/**
 * What one erasure may cost, worked out before it runs, and taken from the
 * store's studio figure (lib/store-allowance-rules.ts) whichever door it came
 * through, in two parts: the part the store's own record says (its products
 * and courses) before anything is read, then, once the courses are read and
 * a few counts taken, the rest. One studio unit is priced at a studio
 * request's twenty commands and fifty kilobytes (tests/plan-cost-registry.ts,
 * UNIT_COST); tests/person-erasure.test.ts holds the units taken here to cost
 * at least the commands and bytes counted here, and what an erasure sends to
 * be no more than what is counted.
 */
export type ErasureSize = {
  products: number;
  courses: number;
  lessons: number;
  /** Counted once the courses and the counts below are read. */
  deals: number;
  conversations: number;
  dmConversations: number;
  roomMessages: number;
  events: number;
  certificates: number;
  /** Dropped courses looked at for a record of the person (lib/removed-courses.ts); those with one are in `courses`. */
  droppedCourses: number;
  /** Dropped courses read whole (their lessons and modules), the person having a record there. */
  droppedRecords: number;
  /**
   * Products noted in the store's set of products with private podcast feeds (lib/podcast-access.ts, nl:pod:pids:),
   * removed ones included, which a deletion looks for the person's feeds in beside the catalog (#4471).
   */
  podcastProducts: number;
  /** The checkout-ask count paid for before the erasers run (lib/checkout-ask.ts checkoutAskCount, #4290). */
  checkoutAsks: number;
  /** Waitlist marks read (lib/waitlist.ts waitlistMarks): coming soon and still dropping, at most MAX_WAITLIST_MARKS. */
  waitlists: number;
};

/**
 * Commands every erasure sends whatever the store: each module's own, workflows at their cap, a sync log at its length,
 * and (since 18 October 2026) a person's payment requests at their cap, four commands each for twice MAX_PER_PERSON
 * (lib/payment-request-store.ts): 260 before them; and (since 18 October 2026) a person's agreements at their cap, two
 * commands each for twice MAX_PER_PERSON (lib/agreement-store.ts), with every version's key named: 460 before them;
 * and (C7 courses hunt) the read of the store's dropped courses (lib/removed-courses.ts), one command, whose courses
 * are then counted with the rest (ERASE_PER.courses, .lessons): 550 before it; and (#4471) the private podcast feeds of
 * removed products: the count of the store's noted products (SCARD), their set read with whether the walk of feeds
 * granted before the note is done (SMEMBERS and HMGET), and, until it is, this person's own indexes looked for by at most
 * NOTE_INLINE_PAGES (4) SCAN pages: 551 before them; and (Claude 3 on #3473) the read of the memberships whose
 * invitations wait to be deleted (lib/move-members.ts withPendingInvites), one SMEMBERS: 558 before it, 559 with it.
 * And (since #4808, 15 November 2026) the paths of the person's files kept for a repeat: one SMEMBERS, an SADD and an
 * EXPIRE, and an SREM, four more: 563; and (3rjdf's review) their review photos' paths kept before the reviews go (an
 * SADD and an EXPIRE) and the kept paths' time renewed on a repeat and when one is lost (two EXPIREs), four more: 567.
 * Since Codex L on #4871 the kept paths have no expiry, so their four EXPIREs are no longer sent; 567 stays the bound.
 * And (#4462, 16 November 2026) the count and the read of the store's waitlist marks (lib/waitlist.ts waitlistMarks: two
 * SCARD, two SMEMBERS), whose members are then counted with the rest (ERASE_PER.waitlists), four more: 571.
 */
// 567 before #4290 and #4462; four more cover the own ask count and the atomic ask eraser's fixed work (ZCARD, EVAL,
// ZRANGEBYSCORE, DEL), and #4462's four for the waitlist marks: 575.
export const ERASE_FIXED_COMMANDS = 575;
/**
 * Bytes every erasure moves whatever the store: keys, small records, a sync log's jobs, the store's own record read
 * again, and those commands; 310,000 before (Claude 3 on #3473) the memberships whose invitations wait to be deleted
 * (lib/move-members.ts PENDING_MAX, 20): their ids read once (40 bytes each) and, for each, one more field of the
 * person's invitations asked (73 bytes) and its record (at most about 600 bytes with a full address), counted at 15,000;
 * 325,000 before (#4290) the atomic ask eraser's script, two keys, arguments and its two counts, 5,000.
 */
export const ERASE_FIXED_BYTES = 330_000;
/** Members removed per command in the atomic checkout-ask eraser; not a cap on a person's erasure. */
export const ASK_ERASE_BATCH = 512;
/** Per thing counted: [commands, bytes]. */
export const ERASE_PER: Record<keyof ErasureSize, [number, number]> = {
  products: [16, 4_000],
  // Since #4808 a course's handed-in files are kept for a repeat before their records go: each lesson's submission
  // read once more (one command, its record's bytes again) and each course's SADD and EXPIRE.
  courses: [16, 70_000],
  lessons: [2, 1_600],
  deals: [0, 1_000],
  conversations: [0, 700],
  dmConversations: [3, 300],
  roomMessages: [0, 1_200],
  events: [1, 150],
  certificates: [0, 500],
  // Six probes a dropped course (lib/removed-courses.ts DROPPED_PROBES: student row, lessons done, passes, certificate,
  // start and finish marks), their key names and replies, and its entry in the list read whole (its id and its
  // product's, 160 bytes at most): 6 x 160 + 160 = 1,120, counted at 1,200 (#4542 review).
  droppedCourses: [6, 1_200],
  // One GET of a dropped course's lessons and modules, read only where the person has a record:
  // REMOVED_COURSE_RECORD_BYTES (lib/removed-courses.ts, 15,442) at most, counted at 16,000; held by
  // tests/erasure-dropped-list-budget.test.ts.
  droppedRecords: [1, 16_000],
  // A noted podcast product (#4471, lib/podcast-access.ts): the GET of the person's index for it, and its index's and
  // cached answer's names in the deletion's DEL; its member in the set read (an id of at most 80 bytes), its index's
  // name in a SCAN page (at most 204 bytes) and the index's reply (a 48-character token): counted at 1,000 bytes. A
  // product still in the catalog is counted here too, over what it costs.
  podcastProducts: [1, 1_000],
  // Members stay inside Redis; only two counts return. Their commands are counted by batches below.
  checkoutAsks: [0, 0],
  // A waitlist mark read (#4462, Claude 7 MÉDIO 4 and 8): its member in the SMEMBERS reply (a product id, 64 bytes at
  // most), and for one not in the catalog the HDEL of the address (its key and the address, 254 bytes at most) and its
  // launch list walked in BLANK_IN_LISTS (its key, then LRANGE and an LSET inside the script): 3 commands, counted at
  // 1,000 bytes. A mark of a catalog product is counted the same, though its product's line already pays for it.
  waitlists: [3, 1_000],
};
/** The studio units that cover an erasure's own call, its CPU and memory, and waiting on Discord to take roles back. */
export const ERASE_BASE_UNITS = 15;
/** What one studio unit is counted as here: its commands and its bytes. */
export const UNIT_COMMANDS = 20;
export const UNIT_BYTES = 50_000;

/** The commands and bytes an erasure of a store this size sends at the most. */
export function erasureWork(size: Partial<ErasureSize>): { commands: number; bytes: number } {
  let commands = ERASE_FIXED_COMMANDS;
  let bytes = ERASE_FIXED_BYTES;
  for (const [key, [c, b]] of Object.entries(ERASE_PER) as [keyof ErasureSize, [number, number]][]) {
    const n = Object.hasOwn(size, key) ? size[key] : 0;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new RangeError("Unknown erasure size");
    const nextCommands = commands + c * n;
    const nextBytes = bytes + b * n;
    if (!Number.isSafeInteger(nextCommands) || !Number.isSafeInteger(nextBytes)) throw new RangeError("Unknown erasure size");
    commands = nextCommands;
    bytes = nextBytes;
  }
  const asks = size.checkoutAsks ?? 0;
  commands += Math.ceil(asks / ASK_ERASE_BATCH);
  if (!Number.isSafeInteger(commands)) throw new RangeError("Unknown erasure size");
  return { commands, bytes };
}

/** The studio units that work takes: each command and each byte paid for. */
export function workUnits(work: { commands: number; bytes: number }): number {
  return Math.ceil(work.commands / UNIT_COMMANDS) + Math.ceil(work.bytes / UNIT_BYTES);
}

/** The units an erasure of a store this size takes in all. */
export function erasureUnits(size: Partial<ErasureSize>): number {
  return ERASE_BASE_UNITS + workUnits(erasureWork(size));
}

/** The units a store with nothing in it takes: what the help says one deletion takes, at the least. */
export const ERASE_STUDIO_UNITS = erasureUnits({});

/** A person asking to be deleted: how often one network address and one email address may ask, in an hour. */
export const ERASE_ASKS_PER_IP_HOUR = 10;
export const ERASE_ASKS_PER_ADDRESS_HOUR = 3;
/** How long the emailed link that confirms a deletion works. */
export const ERASE_LINK_SECONDS = 60 * 60;
export const ERASE_TOKEN = /^[0-9a-f]{64}$/;
/** The most stores one request for every store may delete an address from. */
export const MAX_ERASE_STORES = 60;


/** What became of one module's records, for the confirmation and the activity log. */
export type ErasedPart = { module: string; records: number };
