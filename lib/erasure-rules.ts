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
  courses: {
    productId: string;
    courseId: string;
    lessonIds: string[];
    moduleIds: string[];
    /** How many lesson comments the course's record held when the erasure was charged (lib/person-erasure.ts, erasureSize). */
    commentFields?: number;
  }[];
  /** Every product of the store, by id. */
  productIds: string[];
  /** The store's community, when it has one. */
  communityId: string | null;
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
  /**
   * The steps the deletion of their lesson comments walks over the courses' records (lib/lesson-comments.ts,
   * commentScanSize), and those steps times the lessons each names, since every step names its course's lessons.
   */
  commentPages: number;
  commentPageLessons: number;
  /** The most lesson comments the deletion may take, each course's takesFor its record (lib/lesson-comments.ts). */
  commentTakes: number;
};

/**
 * Commands every erasure sends whatever the store: each module's own, workflows at their cap, a sync log at its length,
 * and (since 18 October 2026) a person's payment requests at their cap, four commands each for twice MAX_PER_PERSON
 * (lib/payment-request-store.ts): 260 before them; and (since 18 October 2026) a person's agreements at their cap, two
 * commands each for twice MAX_PER_PERSON (lib/agreement-store.ts), with every version's key named: 460 before them.
 */
export const ERASE_FIXED_COMMANDS = 550;
/** Bytes every erasure moves whatever the store: keys, small records, a sync log's jobs, the store's own record read again, and those commands. */
export const ERASE_FIXED_BYTES = 310_000;
/** Per thing counted: [commands, bytes]. */
export const ERASE_PER: Record<keyof ErasureSize, [number, number]> = {
  products: [16, 4_000],
  courses: [14, 70_000],
  lessons: [1, 800],
  deals: [0, 1_000],
  conversations: [0, 700],
  dmConversations: [3, 300],
  roomMessages: [0, 1_200],
  events: [1, 150],
  certificates: [0, 500],
  // Each step walked FORGET_PASSES (3) times at the most, each walk four billed commands and under 3,200 bytes
  // before its lessons (3,000 until the script's most and its step bound, 9 November 2026), 80 bytes a lesson (lib/lesson-comments.ts, forgetPageWork; held in
  // tests/lesson-comments-copy-erasure-bounds.test.ts).
  commentPages: [12, 9_600],
  commentPageLessons: [0, 240],
  // The commands the script runs inside for each comment it deletes, FORGET_TAKE_COMMANDS (4) at the most and no more
  // comments than it is given (since 9 November 2026, rule 24): they move nothing over the network, so no bytes.
  commentTakes: [4, 0],
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
