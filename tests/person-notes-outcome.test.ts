/**
 * Codex G's review of #3159 (MEDIUM): a note sent to the server may have been
 * saved even when the browser never reads a clear answer. A lost response, a
 * body that is not JSON, or any answer that does not prove the change was
 * refused is an unknown outcome: the notes box never says "did not save"
 * then, which would lead the person to add the note a second time and take a
 * second share of the store's data room. Only the answers the route gives
 * before it writes anything ("invalid", "store_full") may say it did not save.
 *
 * Pure words only; nothing is rendered or reached.
 */
import { personNoteFailureWords } from "@/components/person-notes";
import { done, is, part } from "./check";

const NOT_SAVED = /did not save/i;
const UNKNOWN = /could not confirm|see whether that saved/i;

function says(answer: unknown): { notSaved: boolean; unknown: boolean } {
  const words = personNoteFailureWords(answer);
  return { notSaved: NOT_SAVED.test(words), unknown: UNKNOWN.test(words) };
}

async function main(): Promise<void> {
  part("Unknown outcome: never \"did not save\"");
  is("the response was lost (fetch rejected)", says(null), { notSaved: false, unknown: true });
  is("a body that is not JSON", says({}), { notSaved: false, unknown: true });
  is("a server error after the change may have been written", says({ ok: false, error: "server_error" }), { notSaved: false, unknown: true });
  is("the notes could not be read after the change", says({ ok: false, error: "unavailable" }), { notSaved: false, unknown: true });
  is("an error the box does not know", says({ ok: false, error: "something_new" }), { notSaved: false, unknown: true });
  is("ok without the notes", says({ ok: true }), { notSaved: false, unknown: true });
  is("a string", says("garbled"), { notSaved: false, unknown: true });

  part("Refused before anything was written: it did not save");
  is("invalid", says({ ok: false, error: "invalid" }), { notSaved: true, unknown: false });
  is("the store's data room is full", says({ ok: false, error: "store_full" }), { notSaved: true, unknown: false });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
