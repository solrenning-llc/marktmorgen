/**
 * Sends a sold file from the creator's browser straight to the file store,
 * in pieces, and goes on when a piece fails.
 *
 * The other half of the door in app/api/store/vault. The browser asks for
 * the upload to be opened, then, a few pieces at a time, for an address for
 * each piece; it sends each piece to its address and keeps what the store
 * answers for it (the piece's `ETag`), and at the end hands those back so
 * the pieces can be joined. A file of one piece uses a session too when the server supports it.
 *
 * A piece that fails is sent again after a pause that grows. Its address is
 * asked for afresh each time, because an address is good for an hour and a
 * long upload outlives several. The upload gives up only when one piece has
 * failed through every pause, and then says so and lets the store throw away
 * what did arrive.
 *
 * Runs in the browser. It asks for nothing but a way to post to our door and
 * a way to put a piece, so the tests stand in for both
 * (tests/vault-upload.test.ts).
 */
import { PIECES_PER_ASK } from "@/lib/vault-rules";
import { UploadRefused } from "@/lib/upload-refusal";

/** The pauses before a piece is tried again, in ms. After the last one the upload gives up. */
export const PIECE_PAUSES_MS = [1_000, 3_000, 5_000, 10_000, 20_000, 60_000];
/** How many pieces are on their way at once. */
const AT_ONCE = 3;

export type VaultFile = { pathname: string; bytes: number; contentType: string };

/**
 * Why an upload stopped: our door said no (`reason` is its word, `said` its own sentence when it sent one, such as a
 * spent studio window's), or the store could not be reached for too long.
 */
export class VaultUploadError extends UploadRefused {}

type DoorAnswer = {
  ok?: boolean;
  error?: string;
  /** The door's own sentence, sent with some refusals (a spent studio window's, lib/studio-route.ts refusedJson). */
  message?: string;
  upload?: { pathname: string; pieces: number; pieceBytes: number; multipart?: boolean };
  pieces?: { number: number; url: string; type: string | null }[];
  file?: VaultFile;
};

export type VaultUploadOptions = {
  onProgress?: (percent: number) => void;
  pauses?: number[];
  /** Stand-ins, for the tests. */
  door?: (payload: Record<string, unknown>) => Promise<DoorAnswer>;
  put?: (url: string, piece: Blob, type: string | null, onSent: (bytes: number) => void) => Promise<{ status: number; etag: string | null }>;
  wait?: (ms: number) => Promise<void>;
};

async function postDoor(payload: Record<string, unknown>): Promise<DoorAnswer> {
  try {
    const response = await fetch("/api/store/vault", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as DoorAnswer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

/** Sends one piece, telling how much of it has gone as it goes. A status of 0 is a line that dropped. */
function putPiece(url: string, piece: Blob, type: string | null, onSent: (bytes: number) => void): Promise<{ status: number; etag: string | null }> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    if (type) request.setRequestHeader("Content-Type", type);
    request.upload.onprogress = (event) => onSent(event.loaded);
    request.onload = () => resolve({ status: request.status, etag: request.getResponseHeader("ETag") });
    request.onerror = () => resolve({ status: 0, etag: null });
    request.onabort = () => resolve({ status: 0, etag: null });
    request.send(piece);
  });
}

/**
 * Uploads `file` onto the product, option or lesson `ownerId`. Resolves with
 * the file as the store measured it; `null` when that store is not set up
 * (the caller then uploads the way it always has); throws a VaultUploadError
 * otherwise.
 */
export async function vaultUpload(file: File | Blob, ownerId: string, name: string, options: VaultUploadOptions = {}): Promise<VaultFile | null> {
  const door = options.door ?? postDoor;
  const put = options.put ?? putPiece;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pauses = options.pauses ?? PIECE_PAUSES_MS;

  const opened = await door({ action: "open", ownerId, name, bytes: file.size, type: file.type, multipart: true });
  if (opened.error === "off") return null;
  if (!opened.ok || !opened.upload) throw new VaultUploadError(opened.error ?? "server_error", opened.message ?? "");
  const { pathname, pieces, pieceBytes } = opened.upload;
  // Older servers ignore the negotiation and keep their single-PUT protocol.
  const needsEtags = opened.upload.multipart === true || pieces > 1;

  const sent = new Array<number>(pieces).fill(0);
  const told = () => options.onProgress?.(file.size === 0 ? 100 : Math.min(100, (sent.reduce((a, b) => a + b, 0) / file.size) * 100));
  const etags = new Array<string>(pieces).fill("");
  // Addresses asked for ahead of need, a few at a time. One that fails is
  // thrown away and asked for again.
  const addresses = new Map<number, { url: string; type: string | null }>();

  async function addressOf(number: number): Promise<{ url: string; type: string | null }> {
    const known = addresses.get(number);
    if (known) {
      addresses.delete(number);
      return known;
    }
    const numbers: number[] = [];
    for (let n = number; n <= pieces && numbers.length < PIECES_PER_ASK; n += 1) if (!etags[n - 1]) numbers.push(n);
    const answer = await door({ action: "sign", pathname, numbers });
    if (!answer.ok || !answer.pieces) throw new VaultUploadError(answer.error ?? "server_error", answer.message ?? "");
    for (const piece of answer.pieces) addresses.set(piece.number, { url: piece.url, type: piece.type });
    const mine = addresses.get(number);
    if (!mine) throw new VaultUploadError("server_error");
    addresses.delete(number);
    return mine;
  }

  async function sendPiece(number: number): Promise<void> {
    const start = (number - 1) * pieceBytes;
    const piece = file.slice(start, Math.min(file.size, start + pieceBytes));
    for (let attempt = 0; ; attempt += 1) {
      let answer: { status: number; etag: string | null } = { status: 0, etag: null };
      try {
        const address = await addressOf(number);
        answer = await put(address.url, piece, address.type, (bytes) => {
          sent[number - 1] = Math.min(piece.size, bytes);
          told();
        });
      } catch (thrown) {
        // Our own door said no to signing: that is an answer, not a dropped line.
        if (thrown instanceof VaultUploadError && thrown.reason !== "server_error" && thrown.reason !== "files_unavailable") throw thrown;
      }
      if (answer.status >= 200 && answer.status < 300 && (answer.etag || !needsEtags)) {
        etags[number - 1] = answer.etag ?? "whole";
        sent[number - 1] = piece.size;
        told();
        return;
      }
      sent[number - 1] = 0;
      told();
      if (attempt >= pauses.length) throw new VaultUploadError("upload_stopped");
      await wait(pauses[attempt]);
    }
  }

  told();
  try {
    let next = 1;
    // Once one piece has given up, the others stop at their next piece.
    let stopped = false;
    const worker = async () => {
      while (next <= pieces && !stopped) {
        const number = next;
        next += 1;
        try {
          await sendPiece(number);
        } catch (thrown) {
          stopped = true;
          throw thrown;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, pieces) }, worker));
  } catch (thrown) {
    // What did arrive is thrown away at the store, so it is not kept, and paid for, as pieces of nothing.
    await door({ action: "abort", pathname }).catch(() => {});
    throw thrown;
  }

  const closed = await door({ action: "done", pathname, etags: needsEtags ? etags : [] });
  if (!closed.ok || !closed.file) throw new VaultUploadError(closed.error ?? "server_error", closed.message ?? "");
  options.onProgress?.(100);
  return closed.file;
}
