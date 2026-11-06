import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const component = readFileSync("components/numbers-notes.tsx", "utf8");
const route = readFileSync("app/api/store/notes/route.ts", "utf8");

part("A chart-note retry keeps one operation identity until it is decided");
is("the browser makes an inert random operation id", component.includes("crypto.getRandomValues(bytes)") && component.includes("addAttempt = useRef<string | null>(null)"), true);
is("a retry sends the same held id", component.includes("addAttempt.current ??= freshAttempt()") && component.includes('action: "add", id: addAttempt.current, day, text'), true);
is("success releases the held id", component.includes("addAttempt.current = null;\n            setText(\"\");"), true);
is("changing the requested day or words starts a new operation", component.match(/addAttempt\.current = null; set(?:Day|Text)/g)?.length, 2);
is("a proved id collision is released, while an unknown failure remains retryable", component.includes("if (response.status === 409) addAttempt.current = null") && !component.includes("finally {\n      addAttempt.current = null"), true);

part("The route binds that identity to the exact write");
is("the add route forwards the id", route.includes("body.text, Date.now(), body.id"), true);
is("a collision is a distinct retryable response", route.includes("error instanceof StatsNoteAttemptConflict") && route.includes('error: "conflict"') && route.includes("status: 409"), true);
done();
