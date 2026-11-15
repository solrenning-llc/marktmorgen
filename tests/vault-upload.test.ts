/**
 * A sold file goes from the studio's browser to the file store in pieces,
 * and a piece that fails is sent again (lib/vault-upload.ts).
 *
 * What matters is at the end of every part here: each piece reaches the
 * store once, the answers for the pieces are handed back in order, and an
 * upload that cannot go on says why and has what did arrive thrown away.
 *
 * Our own door and the store are both stood in for.
 */
import { PIECE_PAUSES_MS, VaultUploadError, vaultUpload } from "@/lib/vault-upload";
import { PIECES_PER_ASK } from "@/lib/vault-rules";
import { done, is, part } from "./check";

const PIECE = 10;
type Trouble = (number: number, nth: number) => number | null;

/** Our door and the store behind it, for a file of `size` cut into pieces of ten bytes. */
function world(options: { open?: Record<string, unknown>; sign?: (numbers: number[]) => Record<string, unknown> | null; trouble?: Trouble; done?: Record<string, unknown> } = {}) {
  const doors: Record<string, unknown>[] = [];
  const puts: { number: number; bytes: number; type: string | null; url: string }[] = [];
  const waits: number[] = [];
  const tries = new Map<number, number>();
  let signed = 0;
  const door = async (payload: Record<string, unknown>) => {
    doors.push(payload);
    if (payload.action === "open") {
      if (options.open) return options.open;
      const pieces = Math.max(1, Math.ceil((payload.bytes as number) / PIECE));
      return { ok: true, upload: { pathname: "vault/f/p/0011223344556677-a.zip", pieces, pieceBytes: PIECE } };
    }
    if (payload.action === "sign") {
      const numbers = payload.numbers as number[];
      const refused = options.sign?.(numbers);
      if (refused) return refused;
      signed += 1;
      return { ok: true, pieces: numbers.map((number) => ({ number, url: `https://store.example/piece/${number}?ask=${signed}`, type: null })) };
    }
    if (payload.action === "done") return options.done ?? { ok: true, file: { pathname: "vault/f/p/0011223344556677-a.zip", bytes: 25, contentType: "application/zip" } };
    return { ok: true };
  };
  const put = async (url: string, piece: Blob, type: string | null, onSent: (bytes: number) => void) => {
    const number = Number(new URL(url).pathname.split("/").pop());
    const nth = tries.get(number) ?? 0;
    tries.set(number, nth + 1);
    const status = options.trouble?.(number, nth) ?? 200;
    puts.push({ number, bytes: piece.size, type, url });
    if (status !== 200) return { status, etag: null };
    onSent(piece.size);
    return { status: 200, etag: `"etag-${number}"` };
  };
  return { door, put, doors, puts, waits, wait: async (ms: number) => void waits.push(ms) };
}

const file = (n: number) => new Blob([new Uint8Array(n)], { type: "application/zip" });
const of = (w: ReturnType<typeof world>, action: string) => w.doors.filter((d) => d.action === action);

async function reasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "finished";
  } catch (error) {
    return error instanceof VaultUploadError ? error.reason : "another error";
  }
}

async function main() {
  part("A file goes over in pieces");
  let w = world();
  const progress: number[] = [];
  const kept = await vaultUpload(file(25), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait, onProgress: (p) => progress.push(Math.round(p)) });
  is("it resolves with the file as the store measured it", kept, { pathname: "vault/f/p/0011223344556677-a.zip", bytes: 25, contentType: "application/zip" });
  is("our door was told what the file is before a byte went", of(w, "open")[0], { action: "open", ownerId: "p", name: "a.zip", bytes: 25, type: "application/zip", multipart: true });
  is("each piece went once, in its own size", w.puts.map((p) => [p.number, p.bytes]).sort((a, b) => a[0] - b[0]), [[1, 10], [2, 10], [3, 5]]);
  is("and what the store answered for each is handed back in order", of(w, "done")[0].etags, ['"etag-1"', '"etag-2"', '"etag-3"']);
  is("the creator sees it start at nothing and end at 100", [progress[0], progress[progress.length - 1]], [0, 100]);
  is("nothing was waited for, and nothing given up", [w.waits, of(w, "abort").length], [[], 0]);

  part("Addresses are asked for a few at a time");
  w = world();
  await vaultUpload(file(PIECE * (PIECES_PER_ASK + 3)), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait });
  is("never more than the door gives at once", of(w, "sign").every((d) => (d.numbers as number[]).length <= PIECES_PER_ASK), true);
  is("and every piece arrived", new Set(w.puts.map((p) => p.number)).size, PIECES_PER_ASK + 3);

  part("A small file goes whole");
  w = world();
  await vaultUpload(file(7), "p", "a.zip", { door: w.door, put: async (url, piece, type, onSent) => ({ ...(await w.put(url, piece, type, onSent)), etag: null }), wait: w.wait });
  is("in one piece, and no list of answers is needed to close it", [w.puts.length, of(w, "done")[0].etags], [1, []]);


  part("One-part multipart negotiation");
  const onePart = { ok: true, upload: { pathname: "vault/f/p/0011223344556677-a.zip", pieces: 1, pieceBytes: PIECE, multipart: true } };
  w = world({ open: onePart });
  await vaultUpload(file(7), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait });
  is("a negotiated one-part session returns its ETag for completion", of(w, "done")[0].etags, ['"etag-1"']);
  w = world({ open: onePart });
  const missingEtag = await reasonOf(vaultUpload(file(7), "p", "a.zip", { door: w.door, put: async (url, piece, type, sent) => ({ ...(await w.put(url, piece, type, sent)), etag: null }), pauses: [], wait: w.wait }));
  is("a successful PUT without its required ETag cannot complete", [missingEtag, of(w, "done").length, of(w, "abort").length], ["upload_stopped", 0, 1]);

  part("A piece fails, and is sent again");
  w = world({ trouble: (number, nth) => (number === 2 && nth < 2 ? 0 : null) });
  await vaultUpload(file(25), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait });
  is("after a pause that grows", w.waits, [PIECE_PAUSES_MS[0], PIECE_PAUSES_MS[1]]);
  const second = w.puts.filter((p) => p.number === 2);
  is("three tries for that piece, one for the others", [second.length, w.puts.length], [3, 5]);
  is("each try with an address asked for afresh", new Set(second.map((p) => p.url)).size, 3);
  is("and the upload finishes with every piece", (of(w, "done")[0].etags as string[]).length, 3);
  w = world({ trouble: (number, nth) => (number === 1 && nth === 0 ? 503 : null) });
  await vaultUpload(file(25), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait });
  is("a store that is busy is waited for the same way", w.waits, [PIECE_PAUSES_MS[0]]);

  part("An upload that cannot go on says why");
  w = world({ trouble: (number) => (number === 3 ? 0 : null) });
  is("a piece that fails through every pause: the upload stopped", await reasonOf(vaultUpload(file(25), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait })), "upload_stopped");
  is("only after every pause was tried", w.waits, PIECE_PAUSES_MS);
  is("and what did arrive is thrown away at the store", of(w, "abort").length, 1);
  w = world({ open: { ok: false, error: "storage_full" } });
  is("our door refusing to open it is said in the door's own word", await reasonOf(vaultUpload(file(25), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait })), "storage_full");
  is("and nothing was sent anywhere", w.puts.length, 0);
  w = world({ sign: () => ({ ok: false, error: "unknown" }) });
  is("our door no longer knowing the upload ends it at once, with no pauses", [await reasonOf(vaultUpload(file(25), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait })), w.waits.length], ["unknown", 0]);
  w = world({ done: { ok: false, error: "invalid" } });
  is("a file the store measured as something else is refused at the end", await reasonOf(vaultUpload(file(25), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait })), "invalid");
  // Issue #4082 (Codex V): a "done" that did not answer ok left the upload's session and its storage reservation
  // open at the store, and the page kept no handle to close them, so the same file could not be sent again at once.
  is("and the upload is closed at the store, so the file can be sent again at once", of(w, "abort").map((d) => d.pathname), ["vault/f/p/0011223344556677-a.zip"]);
  w = world({ done: { ok: false, error: "files_unavailable" } });
  is("a store that could not join the pieces just now says so", await reasonOf(vaultUpload(file(25), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait })), "files_unavailable");
  is("and the upload is closed at the store too", of(w, "abort").length, 1);
  w = world({ done: {} });
  is("an answer of no known shape is an error of ours", await reasonOf(vaultUpload(file(25), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait })), "server_error");
  is("and the upload is closed at the store", of(w, "abort").length, 1);
  w = world();
  await vaultUpload(file(25), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait });
  is("a finished upload is never thrown away", of(w, "abort").length, 0);

  part("The store that takes these is not set up");
  w = world({ open: { ok: false, error: "off" } });
  is("nothing is thrown: the caller uploads the way it always has", await vaultUpload(file(25), "p", "a.zip", { door: w.door, put: w.put, wait: w.wait }), null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
