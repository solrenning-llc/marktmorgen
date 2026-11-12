/**
 * The link to the card follows the card as the server kept it, even when the creator typed while it was saving
 * (Claude 5's review of #1965, LOW 1): `shown` is set from the confirmed card before the early return for words typed
 * since, so a card turned on and saved shows its link, and one turned off and saved does not. Read from the editor's
 * source (the browser proof is Claude 5's tests/c5-r1965-shown-after-edit.test.ts).
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const editor = readFileSync("components/creator-card-editor.tsx", "utf8");
const save = editor.slice(editor.indexOf("async function save("), editor.indexOf("async function remove("));
const shown = save.indexOf("setShown(saved.on);");
const early = save.indexOf("if (edits.current !== sentAt)");
is("the save sets what is shown from the confirmed card", shown > 0, true);
is("before it returns early for words typed while saving", shown > 0 && early > 0 && shown < early, true);
done();
