/**
 * Checking that what a product delivers still works (479 [SB2], unit 1;
 * lib/delivery-check-rules.ts; added 2 November 2026). Pure: nothing is read
 * here. Checked:
 *
 *   - what each product delivers that can be checked: its file, its link, or
 *     its call's own meeting link; nothing for a course, a bundle, a call in
 *     person, in a video room of our own, with a meeting made per booking,
 *     or dated sessions;
 *   - a file missing, empty or of another size is a problem with what to do;
 *     storage that could not be asked is "not checked";
 *   - an address that answers is fine, a long answer included; one that says
 *     it is gone, one that is not https, or one inside a private network is a
 *     problem; one that asks to sign in, did not answer, or redirected too
 *     often is "not checked", never fine and never broken;
 *   - every problem says what to do, in plain words.
 */
import { addressVerdict, deliveryItems, deliveryTarget, fileVerdict, verdictFor } from "@/lib/delivery-check-rules";
import { done, is, part } from "./check";

const file = { pathname: "store/abc/guide.pdf", bytes: 1200, name: "guide.pdf" };

part("What a product delivers");
is(
  "a file, a link, or a call's own meeting link",
  [
    deliveryTarget({ file, link: null }),
    deliveryTarget({ file: null, link: "https://example.com/vault" }),
    deliveryTarget({ file: null, link: null, call: { room: "https://example.com/room" } }),
  ],
  [{ kind: "file", ...file }, { kind: "link", url: "https://example.com/vault" }, { kind: "room", url: "https://example.com/room" }],
);
is(
  "nothing checked for a course's lessons, a bundle, nothing yet, or a call in person, in our room, a meeting with no link of the creator's behind it, or no sessions to come",
  [
    deliveryTarget({ file: null, link: null, course: {} }),
    deliveryTarget({ file: null, link: null, bundle: {} }),
    deliveryTarget({ file: null, link: null }),
    deliveryTarget({ file: null, link: null, call: { room: null, place: { lines: ["x"] } } }),
    deliveryTarget({ file: null, link: null, call: { room: null, video: true } }),
    deliveryTarget({ file: null, link: null, call: { room: null, meet: "zoom" } }),
    deliveryTarget({ file: null, link: null, call: { room: "https://example.com/r", kind: "live", sessions: [] } }),
    deliveryTarget({ file: null, link: null, call: { room: null } }),
  ].map((t) => t.kind),
  Array(8).fill("none"),
);

const opt = { file: { pathname: "store/abc/o1/big.zip", bytes: 50, name: "big.zip" }, link: null, label: "Commercial licence" };
is(
  "each price option's own file or link too, named by its option; a course's options, not its lessons",
  [
    deliveryItems({ file: null, link: null, options: [opt, { file: null, link: "https://example.com/l", label: "1 week" }] }).map((i) => [i.what, i.target.kind]),
    deliveryItems({ file: null, link: null, course: {}, options: [opt] }).map((i) => i.what),
  ],
  [[["The \"Commercial licence\" option's file", "file"], ["The \"1 week\" option's link", "link"]], ["The \"Commercial licence\" option's file"]],
);
const NOW = Date.UTC(2026, 10, 2, 12);
is(
  "a call's own link behind a Meet or Zoom meeting, said as the fallback; each dated session's link still to come, not one that is over",
  [
    deliveryItems({ file: null, link: null, call: { room: "https://example.com/r", meet: "zoom" } }).map((i) => i.what),
    deliveryItems({ file: null, link: null, call: { room: null, kind: "live", sessions: [{ start: NOW + 86_400_000, minutes: 60, room: "https://example.com/s1" }, { start: NOW - 86_400_000, minutes: 60, room: "https://example.com/s0" }, { start: NOW + 2 * 86_400_000, minutes: 60, room: null }] } }, NOW).map((i) => [i.what, i.target.kind === "room" ? i.target.url : ""]),
  ],
  [["Your meeting link, used when a Google Meet or Zoom meeting cannot be made"], [["The meeting link of the session on 2026-11-03", "https://example.com/s1"]]],
);

part("A file");
is("in place at its size: fine", fileVerdict("guide.pdf", 1200, { size: 1200 }).state, "ok");
const missing = fileVerdict("guide.pdf", 1200, "missing");
is("missing, empty or of another size: a problem, with what to do", [missing.state, fileVerdict("guide.pdf", 1200, { size: 0 }).state, fileVerdict("guide.pdf", 1200, { size: 99 }).state, missing.fix], ["problem", "problem", "problem", "Upload the file again on the product."]);
is("storage not asked: not checked", fileVerdict("guide.pdf", 1200, null).state, "not-checked");

part("An address");
const say = (answer: Parameters<typeof addressVerdict>[2]) => addressVerdict("Your link", "https://example.com/vault", answer).state;
is("it answers, or answers with something long: fine", [say({ status: 200 }), say({ status: 302 }), say({ problem: "too_big" })], ["ok", "ok", "ok"]);
is("gone, not https, or inside a private network: a problem", [say({ status: 404 }), say({ status: 410 }), say({ problem: "scheme" }), say({ problem: "private" })], Array(4).fill("problem"));
is(
  "asks to sign in, did not answer, redirected too often, or answered oddly: not checked, never fine and never broken",
  [say({ status: 401 }), say({ status: 403 }), say({ status: 429 }), say({ status: 503 }), say({ status: 418 }), say({ problem: "timeout" }), say({ problem: "dns" }), say({ problem: "network" }), say({ problem: "redirect" })],
  Array(9).fill("not-checked"),
);
const gone = addressVerdict("Your link", "https://example.com/vault", { status: 404 });
is(
  "each refusal in its own words: not https, not an address we can open, a port, not reachable from outside, a name not found",
  [
    addressVerdict("Your link", "u", { problem: "scheme" }).found.includes("not a secure web address (https)"),
    addressVerdict("Your link", "u", { problem: "address" }).found.includes("not a web address we can open"),
    addressVerdict("Your link", "u", { problem: "port" }).found.includes("uses a port"),
    addressVerdict("Your link", "u", { problem: "private" }).found.includes("cannot be reached from outside"),
    addressVerdict("Your link", "u", { problem: "dns" }).found.startsWith("We could not find the name of your link"),
  ],
  [true, true, true, true, true],
);
is("a problem names the address and what to do", [gone.found, gone.fix], ["Your link, https://example.com/vault, says the page is not there (404), so buyers cannot open it.", "Put the right address on the product, or bring the page back."]);

part("One product");
is(
  "its verdict from its target and what was read; none for nothing to check; an address not asked is not checked",
  [
    verdictFor({ kind: "none" }, null),
    verdictFor({ kind: "file", ...file }, "missing")?.state,
    verdictFor({ kind: "room", url: "https://example.com/r" }, { status: 404 })?.found.startsWith("Your meeting link"),
    verdictFor({ kind: "link", url: "https://example.com/v" }, null)?.state,
  ],
  [null, "problem", true, "not-checked"],
);

part("Plain words");
const all = [missing, fileVerdict("guide.pdf", 1200, { size: 0 }), gone, addressVerdict("Your link", "x", { problem: "private" }), addressVerdict("Your link", "x", { problem: "scheme" })];
is("every problem says what to do, and every sentence ends", [all.every((v) => v.state === "problem" && Boolean(v.fix)), all.every((v) => /[.]$/.test(v.found) && /[.]$/.test(v.fix ?? "."))], [true, true]);

done();
