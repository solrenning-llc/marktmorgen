/**
 * A vault path carries a file's token only on its last piece (board #5285, row #4356: Codex L's and Codex X5's LOW on
 * #4356). vaultPath writes `vault/<folder>/<owner>/<16-hex token>-<name>`, and a stamped copy (lib/pdf-stamp.ts)
 * `vault/<folder>/stamped/<24 hex>/<24 hex>/<name>`: the "token-name" shape is a file's own last piece and nothing else.
 * isVaultPath accepted it on every piece after the folder. A short "token-name" is also a plain name (KEY_NAME_PATTERN
 * takes "-" and up to 120 characters), so what that let through is a middle piece of 121 to 137 characters, which no
 * path the store writes has. Now only the last piece may have the token shape; the middle pieces are plain names.
 *
 * Pure function; no Redis, no network.
 */
import { isVaultPath } from "@/lib/vault-rules";
import { done, is, part } from "./check";

const FOLDER = "a".repeat(32);
const TOKEN = "0011223344556677";

part("The token-name shape is a file's own last piece only");
const LONG = "x".repeat(110); // a "token-name" piece of 127 characters: longer than any plain name
is("in the middle, under a plain last piece: refused", isVaultPath(`vault/${FOLDER}/${TOKEN}-${LONG}/notes.pdf`), false);
is("as the owner piece of a four-piece path: refused", isVaultPath(`vault/${FOLDER}/${TOKEN}-${LONG}/${TOKEN}-other.pdf`), false);
is("in the middle of a copy's folder: refused", isVaultPath(`vault/${FOLDER}/stamped/${TOKEN}-${LONG}/${"b".repeat(24)}/My-Guide.pdf`), false);

part("Controls: what the store writes is still accepted");
is("a file, as vaultPath writes it", isVaultPath(`vault/${FOLDER}/82f9fc6354/${TOKEN}-My-Guide.pdf`), true);
is("a stamped copy, as lib/pdf-stamp.ts writes it", isVaultPath(`vault/${FOLDER}/stamped/${"a".repeat(24)}/${"b".repeat(24)}/My-Guide.pdf`), true);
is("a file whose name is the longest kept (120)", isVaultPath(`vault/${FOLDER}/82f9fc6354/${TOKEN}-${"x".repeat(120)}`), true);
done();
