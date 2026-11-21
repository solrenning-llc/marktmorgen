/**
 * The held list (nl:csa:files:, lib/child-safety.ts) is priced at what the
 * code can really write (Claude 6's focal review of #3480, 6758141878): the
 * registry priced one list at 48,000 bytes (120 a path), but a sold file's
 * path is a vault path of up to 217 bytes, so 400 of them wrote 88,106 bytes,
 * and with that figure the Store's refunded first year missed its $65 line.
 *
 * Held here:
 *   - the longest valid vault path is built from the path rules
 *     (lib/vault-rules.ts) and is exactly MAX_VAULT_PATH_BYTES, and one byte
 *     more in any part is refused, so the figure cannot drift from the rules;
 *   - the list the code writes (heldListOf) never passes HELD_LIST_BYTES,
 *     whatever the paths: HELD_LIST_PATHS longest vault paths always fit, and
 *     any longer path is counted in `more` rather than written;
 *   - the registry prices a list at HELD_LIST_BYTES and its key, each of the
 *     day's holds.
 *
 * Placeholder paths only; nothing is read or written.
 */
import * as safety from "@/lib/child-safety";
import * as vault from "@/lib/vault-rules";
import { FAMILIES } from "./store-data-registry";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef0123456789abcdef";
const OWNER = "o".repeat(40);
const token = (i: number) => i.toString(16).padStart(16, "0");
const NAME = "n".repeat(120);

type ListOf = (paths: string[]) => string;
const exported = safety as unknown as Record<string, unknown>;
// Before the fix the list was written inline in listHeldFiles; this is its shape there.
const listOf: ListOf = (exported.heldListOf as ListOf | undefined) ?? ((paths) => JSON.stringify({ paths: paths.slice(0, safety.HELD_LIST_PATHS), more: Math.max(0, paths.length - safety.HELD_LIST_PATHS) }));
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

part("The longest valid vault path, from the path rules");
const longest = vault.vaultPath(FOLDER, OWNER, token(1), NAME);
is("it is a file of that store and owner", vault.ownsVaultPath(longest, FOLDER, OWNER), true);
is("a longer name is refused", vault.readVaultPath(`vault/${FOLDER}/${OWNER}/${token(1)}-${NAME}n`), null);
is("a longer owner is refused", vault.readVaultPath(`vault/${FOLDER}/${OWNER}o/${token(1)}-${NAME}`), null);
is("its length is MAX_VAULT_PATH_BYTES", bytes(longest), (vault as unknown as Record<string, unknown>).MAX_VAULT_PATH_BYTES);

part("The list the code writes");
const many = Array.from({ length: 1_000 }, (_, i) => vault.vaultPath(FOLDER, OWNER, token(i), NAME));
const list = JSON.parse(listOf(many)) as { paths: string[]; more: number };
const limit = exported.HELD_LIST_BYTES as number | undefined;
is("HELD_LIST_PATHS longest vault paths fit, the rest are counted", [list.paths.length, list.more], [safety.HELD_LIST_PATHS, many.length - safety.HELD_LIST_PATHS]);
is("it is within HELD_LIST_BYTES", typeof limit === "number" && bytes(listOf(many)) <= limit, true);
// A path of another kind (a picture, an episode) has no length rule of its own: it never takes the list past its bytes.
const odd = Array.from({ length: 1_000 }, (_, i) => `images/${FOLDER}/${"é".repeat(600)}-${i}.webp`);
const oddList = JSON.parse(listOf(odd)) as { paths: string[]; more: number };
is("longer paths of another kind never take it past HELD_LIST_BYTES", typeof limit === "number" && bytes(listOf(odd)) <= limit, true);
is("and what is left out is counted", oddList.paths.length + oddList.more, odd.length);
is("no list is written without a path that fits when one does", JSON.parse(listOf([...odd.slice(0, 3), longest])).paths.includes(longest), true);

part("The registry prices it at what the code can write");
const family = FAMILIES["nl:csa:files:@lib/child-safety.ts"];
const priced = family?.parts?.[0] && "per" in family.parts[0] ? family.parts[0].bytes / safety.CHILD_SAFETY_HOLDS_PER_DAY : 0;
// The key: the family, a store tag of at most 64 characters and a product id of at most 40.
const key = bytes(`nl:csa:files:${"s".repeat(64)}:${"p".repeat(40)}`);
is("each of the day's holds is priced at the longest list and its key", priced >= bytes(listOf(many)) + key && priced >= bytes(listOf(odd)) + key, true);
is("and at no more than HELD_LIST_BYTES and a key's room", typeof limit === "number" && priced <= limit + 256, true);

done();
