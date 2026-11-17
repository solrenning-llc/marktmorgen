/**
 * Claude 1's review of #4831 (MEDIUM, cost): each page of a removed membership's invitations (lib/move-members.ts
 * dropProductInvites) is paid for with one studio request, and a studio request pays for 50,000 bytes through the
 * database (tests/plan-cost-registry.ts, UNIT_COST.studio). So:
 *
 *   - a page of INVITES_PER_UNIT invitations at their heaviest (the address at MAX_EMAIL_LENGTH, every id at its
 *     longest, every number at 13 digits), read by HSCAN and then deleted (HDEL, ZREM, DEL), with the first
 *     request's own commands (the mark, the count, the note's SREM), fits in those 50,000 bytes;
 *   - a page answered with more invitations than asked (COUNT is only a hint in Redis) pays one more request for
 *     each further INVITES_PER_UNIT before anything on it is deleted, and nothing is deleted when that is refused.
 *
 * Synthetic store and people; Redis is the in-memory stand-in (tests/redis-stub.ts), which answers HSCAN with every
 * field at once, as a real server may.
 */
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { addressHash } from "@/lib/imported-purchases";
import { INVITES_PER_UNIT, INVITE_DROP_BYTES_MAX, INVITE_READ_BYTES_MAX, INVITES_FIRST_REQUEST_BYTES, type Invite, dropProductInvites, inviteField, linkKey } from "@/lib/move-members";
import { OPTION_ID } from "@/lib/product-option";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

/** What a studio request pays for through the database (tests/plan-cost-registry.ts, UNIT_COST.studio). */
const STUDIO_BYTES = 50_000;
/** RESP's framing of one bulk string, at its most: "$", up to 6 digits, CRLF, the bytes, CRLF. */
const FRAME = 1 + 6 + 2 + 2;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("A page at its heaviest fits in the studio request that pays for it");
  const email = `${"a".repeat(MAX_EMAIL_LENGTH - "@example.com".length)}@example.com`;
  const product = "p".repeat(40);
  const option = "o".repeat(24);
  is("the longest option id is 24 characters (OPTION_ID)", [OPTION_ID.test(option), OPTION_ID.test(`${option}o`)], [true, false]);
  const field = inviteField(email, product);
  const record = JSON.stringify({ e: email, p: product, o: option, r: 9_999_999_999_999, job: "f".repeat(24), at: 9_999_999_999_999, t: "0".repeat(40), kept: 9_999_999_999_999 } satisfies Invite);
  const sid = "s".repeat(64);
  const read = field.length + FRAME + record.length + FRAME;
  const drop = field.length + FRAME + (sid.length + 1 + field.length + FRAME) + linkKey("0".repeat(40)).length + FRAME;
  is("the field is the address's 32-character print, a colon and the product", field.length, addressHash(email).length + 1 + product.length);
  is("INVITE_READ_BYTES_MAX covers the heaviest invitation as HSCAN returns it", INVITE_READ_BYTES_MAX >= read, true);
  is("INVITE_DROP_BYTES_MAX covers deleting it (HDEL, ZREM, DEL)", INVITE_DROP_BYTES_MAX >= drop, true);
  const page = INVITES_PER_UNIT * (INVITE_READ_BYTES_MAX + INVITE_DROP_BYTES_MAX) + INVITES_FIRST_REQUEST_BYTES;
  is(`a page of ${INVITES_PER_UNIT} with the first request's own commands fits in ${STUDIO_BYTES} bytes`, page <= STUDIO_BYTES, true);
  console.log(`a page at its heaviest: ${page} bytes of ${STUDIO_BYTES}`);

  part("A page of addresses heavier in bytes than in characters still fits (Codex P on #4831)");
  // The importer takes an address by its length in UTF-16 code units (MAX_EMAIL_LENGTH, lib/imports.ts isEmail), and
  // the database moves its record's UTF-8 bytes: three for a character such as "界", and six for a control character,
  // which EMAIL_PATTERN lets through and JSON.stringify writes as \u0001. The page is measured in those bytes.
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  for (const [label, unit] of [["CJK characters", "界"], ["control characters", "\u0001"]] as const) {
    const heavy = `${unit.repeat(MAX_EMAIL_LENGTH - "@example.com".length)}@example.com`;
    is(`the importer takes an address of ${label} at MAX_EMAIL_LENGTH`, [EMAIL_PATTERN.test(heavy), heavy.length <= MAX_EMAIL_LENGTH, normaliseEmail(heavy) === heavy], [true, true, true]);
    const heavyField = inviteField(heavy, product);
    const heavyRecord = JSON.stringify({ e: heavy, p: product, o: option, r: 9_999_999_999_999, job: "f".repeat(24), at: 9_999_999_999_999, t: "0".repeat(40), kept: 9_999_999_999_999 } satisfies Invite);
    const heavyRead = bytes(heavyField) + FRAME + bytes(heavyRecord) + FRAME;
    is(`INVITE_READ_BYTES_MAX covers an invitation of ${label} in bytes (${heavyRead})`, INVITE_READ_BYTES_MAX >= heavyRead, true);
    is(`a page of ${INVITES_PER_UNIT} such invitations fits in ${STUDIO_BYTES} bytes`, INVITES_PER_UNIT * (heavyRead + drop) + INVITES_FIRST_REQUEST_BYTES <= STUDIO_BYTES, true);
  }

  part("A page answered with more than asked pays for the rest before anything on it is deleted");
  const OWNER = "page-bytes@example.com";
  await claimHandle(OWNER, "pagebytes", "Page Bytes", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const club = "c".repeat(12);
  const many = INVITES_PER_UNIT * 2 + 5;
  const key = `nl:mv:${store.statsId}`;
  const write = async () => {
    for (let i = 0; i < many; i += 1) {
      const who = `member${i}@example.com`;
      const t = i.toString(16).padStart(40, "0");
      const value = JSON.stringify({ e: who, p: club, o: "", r: 1_900_000_000, job: "a".repeat(24), at: 1_790_000_000_000, t, kept: 0 } satisfies Invite);
      await redis.pipeline([["HSET", key, inviteField(who, club), value], ["SET", linkKey(t), "x"]]);
    }
  };
  await write();
  const paid: number[] = [];
  const dropped = await dropProductInvites(store, club, async (units) => (paid.push(units), true));
  is(`${many} invitations answered in one page: the first request, then ${Math.ceil(many / INVITES_PER_UNIT) - 1} more before deleting`, [paid.reduce((a, b) => a + b, 0), dropped], [Math.ceil(many / INVITES_PER_UNIT), many]);

  await write();
  const refused: number[] = [];
  let unpaid = false;
  await dropProductInvites(store, club, async (units) => (refused.push(units), refused.length === 1)).catch((error: unknown) => {
    unpaid = error instanceof Error && error.name === "InvitesUnpaidError";
  });
  const left = (await redis.pipeline([["HLEN", key]]))[0];
  is("the rest refused: nothing on that page is deleted, and the removal says it was not paid for", [unpaid, left], [true, many]);
  done();
}

void main();
