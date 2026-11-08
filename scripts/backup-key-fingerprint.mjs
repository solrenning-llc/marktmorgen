/**
 * 273 [BK1] (inbox C1-20261108-2017-C4-36 item 2): prints a backup key's fingerprint, the first 8 hex of
 * HMAC-SHA256(key, "mm-backup-kid"), the same the backup's report shows and every sealed object carries as its key id.
 * The owner runs it on their own computer to check that the paper copy and the password manager's copy are the key the
 * report names. The key comes on standard input (base64 of 32 bytes), never on the command line; it is never printed.
 * Node's own modules only.
 *
 *   node backup-key-fingerprint.mjs < key.txt
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const text = readFileSync(0, "utf8").trim();
const key = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) ? Buffer.from(text, "base64") : Buffer.alloc(0);
if (key.length !== 32 || process.argv.length > 2) {
  process.stderr.write("backup-key-fingerprint: give one key, base64 of 32 bytes, on standard input only\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`${createHmac("sha256", key).update("mm-backup-kid").digest("hex").slice(0, 8)}\n`);
}
