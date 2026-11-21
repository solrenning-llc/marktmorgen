/**
 * 750 [CD1] unit 1: the rules for a buyer who sends a file or a video for the
 * creator to review (lib/submission-rules.ts). Pure and browser-safe; nothing
 * here reads Redis, the store or a provider. What is checked:
 *
 *   - the creator's settings: an instruction is needed; the kinds are video,
 *     photo and PDF only, each mapped to exact MIME types the store's upload
 *     path already takes; the largest file and the keeping time are read as
 *     given inside the code's maximums, never stretched or squeezed to fit;
 *   - who may send: only the signed-in buyer of that lesson's course or of
 *     that paid call, on exact facts; anything unknown is refused;
 *   - before any byte: the declared file is checked against the settings and
 *     against what is left of the plan's storage, counting files already kept
 *     and uploads already reserved; unknown room is refused, never zero;
 *   - the review moves submitted -> reviewed (by the creator, with a reply) or
 *     submitted -> withdrawn (by the buyer), once, and never after the file's
 *     keeping time;
 *   - only that buyer and a team member allowed to review may open it.
 */
import {
  DEFAULT_SUBMISSION_BYTES,
  DEFAULT_SUBMISSION_KEEP_DAYS,
  MAX_SUBMISSION_BYTES,
  MAX_SUBMISSION_KEEP_DAYS,
  MAX_SUBMISSION_INSTRUCTION,
  MAX_SUBMISSION_NOTE,
  MAX_SUBMISSION_REPLY,
  MAX_WAITING_PER_BUYER,
  MIN_SUBMISSION_BYTES,
  REPLY_FILE_LIMITS,
  SUBMISSION_KIND_TYPES,
  type Submission,
  type SubmissionSetup,
  MAX_SUBMISSION_RECORD_BYTES,
  applySubmissionEvent,
  checkSubmissionFile,
  submissionRecordJson,
  mayOpenSubmission,
  maySubmit,
  nextSubmissionState,
  preauthorizeSubmission,
  readSubmissionReply,
  readSubmissionSetup,
  readSubmissionTarget,
  submissionAccept,
  submissionKeepUntil,
  submissionTypes,
} from "@/lib/submission-rules";
import { ALLOWED_TYPES, MAX_FILE_BYTES } from "@/lib/product-file";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { done, is, part } from "./check";

const MiB = 1024 * 1024;
const DAY = 86_400;

part("Settings: instruction, kinds, largest file, keeping time");
{
  const read = readSubmissionSetup({ instruction: "  Film your squat from the side.\r\nOne set.  ", kinds: ["video", "photo"] });
  is("a plain setup reads, with the defaults for size and keeping time", read, {
    ok: true,
    setup: { instruction: "Film your squat from the side.\nOne set.", kinds: ["video", "photo"], maxBytes: DEFAULT_SUBMISSION_BYTES, keepDays: DEFAULT_SUBMISSION_KEEP_DAYS },
  });
  is("no instruction is refused", readSubmissionSetup({ instruction: "   ", kinds: ["pdf"] }), { ok: false, reason: "instruction" });
  is("an instruction that is not text is refused", readSubmissionSetup({ instruction: 7, kinds: ["pdf"] }), { ok: false, reason: "instruction" });
  is("nothing at all is refused", readSubmissionSetup(null), { ok: false, reason: "instruction" });
  const long = readSubmissionSetup({ instruction: "x".repeat(MAX_SUBMISSION_INSTRUCTION + 50), kinds: ["pdf"] });
  is("a long instruction is refused, never cut", long, { ok: false, reason: "instruction" });
  is("an instruction at the maximum is kept whole", readSubmissionSetup({ instruction: "y".repeat(MAX_SUBMISSION_INSTRUCTION), kinds: ["pdf"] }).ok, true);
  is("no kinds is refused", readSubmissionSetup({ instruction: "Send it", kinds: [] }), { ok: false, reason: "kinds" });
  is("kinds that are not a list are refused", readSubmissionSetup({ instruction: "Send it", kinds: "video" }), { ok: false, reason: "kinds" });
  is("an unknown kind is refused, not dropped", readSubmissionSetup({ instruction: "Send it", kinds: ["video", "zip"] }), { ok: false, reason: "kinds" });
  is("a kind in other letters is refused", readSubmissionSetup({ instruction: "Send it", kinds: ["Video"] }), { ok: false, reason: "kinds" });
  const twice = readSubmissionSetup({ instruction: "Send it", kinds: ["pdf", "video", "pdf"] });
  is("a kind named twice is kept once, in a fixed order", twice.ok && twice.setup.kinds, ["video", "pdf"]);
  is("the largest file is read as given", readSubmissionSetup({ instruction: "a", kinds: ["pdf"], maxBytes: 20 * MiB }).ok && (readSubmissionSetup({ instruction: "a", kinds: ["pdf"], maxBytes: 20 * MiB }) as { setup: SubmissionSetup }).setup.maxBytes, 20 * MiB);
  is("the code's maximum is accepted", readSubmissionSetup({ instruction: "a", kinds: ["video"], maxBytes: MAX_SUBMISSION_BYTES }).ok, true);
  is("over the code's maximum is refused, never lowered", readSubmissionSetup({ instruction: "a", kinds: ["video"], maxBytes: MAX_SUBMISSION_BYTES + 1 }), { ok: false, reason: "size" });
  is("under the smallest maximum is refused", readSubmissionSetup({ instruction: "a", kinds: ["video"], maxBytes: MIN_SUBMISSION_BYTES - 1 }), { ok: false, reason: "size" });
  is("a size that is not a whole number is refused", readSubmissionSetup({ instruction: "a", kinds: ["video"], maxBytes: 2 * MiB + 0.5 }), { ok: false, reason: "size" });
  is("a size given as text is refused", readSubmissionSetup({ instruction: "a", kinds: ["video"], maxBytes: "1048576" }), { ok: false, reason: "size" });
  is("the longest keeping time is accepted", readSubmissionSetup({ instruction: "a", kinds: ["pdf"], keepDays: MAX_SUBMISSION_KEEP_DAYS }).ok, true);
  is("longer than the code allows is refused", readSubmissionSetup({ instruction: "a", kinds: ["pdf"], keepDays: MAX_SUBMISSION_KEEP_DAYS + 1 }), { ok: false, reason: "keep" });
  is("zero days is refused", readSubmissionSetup({ instruction: "a", kinds: ["pdf"], keepDays: 0 }), { ok: false, reason: "keep" });
  is("part of a day is refused", readSubmissionSetup({ instruction: "a", kinds: ["pdf"], keepDays: 1.5 }), { ok: false, reason: "keep" });
  is("the code's maximum fits inside what one upload may be", MAX_SUBMISSION_BYTES <= MAX_FILE_BYTES, true);
  is("the code's maximum fits inside the smallest plan's storage", MAX_SUBMISSION_BYTES <= PAID_STORAGE_BYTES.creator, true);
  is("the default size is inside the range", DEFAULT_SUBMISSION_BYTES >= MIN_SUBMISSION_BYTES && DEFAULT_SUBMISSION_BYTES <= MAX_SUBMISSION_BYTES, true);
}

part("Kinds map to exact MIME types the upload path already takes");
{
  is("video", SUBMISSION_KIND_TYPES.video, ["video/mp4", "video/quicktime", "video/webm"]);
  is("photo", SUBMISSION_KIND_TYPES.photo, ["image/jpeg", "image/png", "image/webp"]);
  is("PDF", SUBMISSION_KIND_TYPES.pdf, ["application/pdf"]);
  const every = Object.values(SUBMISSION_KIND_TYPES).flat();
  is("every type is one the store's files already take", every.filter(type => !Object.hasOwn(ALLOWED_TYPES, type)), []);
  is("no picture that can carry a script", every.includes("image/svg+xml"), false);
  const setup: SubmissionSetup = { instruction: "a", kinds: ["photo", "pdf"], maxBytes: 20 * MiB, keepDays: 30 };
  is("the types a setup takes, with their extensions", submissionTypes(setup), { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" });
  is("the file picker's list", submissionAccept(setup), ".jpg,.png,.webp,.pdf");
}

part("Where a submission belongs");
{
  is("a lesson", readSubmissionTarget({ kind: "lesson", courseId: "abc123def456", lessonId: "zz99yy88xx77" }), { kind: "lesson", courseId: "abc123def456", lessonId: "zz99yy88xx77" });
  is("a paid call", readSubmissionTarget({ kind: "call", productId: "prod_9", bookingId: "cs_test_1" }), { kind: "call", productId: "prod_9", bookingId: "cs_test_1" });
  is("a lesson without its course is nothing", readSubmissionTarget({ kind: "lesson", lessonId: "zz99yy88xx77" }), null);
  is("an id with a slash is nothing", readSubmissionTarget({ kind: "lesson", courseId: "a/b", lessonId: "c" }), null);
  is("another kind is nothing", readSubmissionTarget({ kind: "post", id: "a" }), null);
}

part("Who may send: only the buyer, on exact facts");
{
  const setup: SubmissionSetup = { instruction: "a", kinds: ["video"], maxBytes: 100 * MiB, keepDays: 30 };
  const lesson = { kind: "lesson" as const, setup, signedIn: "ana@example.com", purchase: { email: "Ana@Example.com ", state: "paid" as const, paidCents: 4900 }, waiting: 0, now: 1_000 };
  is("the signed-in buyer of the course may send", maySubmit(lesson), { ok: true });
  is("not turned on", maySubmit({ ...lesson, setup: null }), { ok: false, reason: "off" });
  is("settings not read", maySubmit({ ...lesson, setup: "unknown" }), { ok: false, reason: "unknown" });
  is("not signed in", maySubmit({ ...lesson, signedIn: null }), { ok: false, reason: "signed-out" });
  is("no purchase found", maySubmit({ ...lesson, purchase: null }), { ok: false, reason: "not-buyer" });
  is("purchases not read", maySubmit({ ...lesson, purchase: "unknown" }), { ok: false, reason: "unknown" });
  is("somebody else's purchase", maySubmit({ ...lesson, signedIn: "bob@example.com" }), { ok: false, reason: "not-buyer" });
  is("a free enrollment is not a purchase", maySubmit({ ...lesson, purchase: { ...lesson.purchase, paidCents: 0 } }), { ok: false, reason: "not-buyer" });
  is("an amount that is not a whole number is unknown", maySubmit({ ...lesson, purchase: { ...lesson.purchase, paidCents: Number.NaN } }), { ok: false, reason: "unknown" });
  is("a refunded purchase", maySubmit({ ...lesson, purchase: { ...lesson.purchase, state: "refunded" } }), { ok: false, reason: "refunded" });
  is("a disputed purchase", maySubmit({ ...lesson, purchase: { ...lesson.purchase, state: "disputed" } }), { ok: false, reason: "refunded" });
  is("a payment not finished", maySubmit({ ...lesson, purchase: { ...lesson.purchase, state: "pending" } }), { ok: false, reason: "not-paid" });
  is("a state nobody knows", maySubmit({ ...lesson, purchase: { ...lesson.purchase, state: "weird" as "paid" } }), { ok: false, reason: "unknown" });
  is("an empty purchase email is unknown", maySubmit({ ...lesson, purchase: { ...lesson.purchase, email: " " } }), { ok: false, reason: "unknown" });
  is("waiting count not read", maySubmit({ ...lesson, waiting: "unknown" }), { ok: false, reason: "unknown" });
  is("one under the waiting limit", maySubmit({ ...lesson, waiting: MAX_WAITING_PER_BUYER - 1 }), { ok: true });
  is("at the waiting limit", maySubmit({ ...lesson, waiting: MAX_WAITING_PER_BUYER }), { ok: false, reason: "busy" });
  is("a negative waiting count is unknown", maySubmit({ ...lesson, waiting: -1 }), { ok: false, reason: "unknown" });
  const call = { ...lesson, kind: "call" as const, callEndsAt: 900 };
  is("after the paid call ended", maySubmit(call), { ok: true });
  is("before the call ended", maySubmit({ ...call, callEndsAt: 1_001 }), { ok: false, reason: "too-early" });
  is("the call's end not known", maySubmit({ ...call, callEndsAt: "unknown" }), { ok: false, reason: "unknown" });
  is("a call with no end given", maySubmit({ ...call, callEndsAt: undefined }), { ok: false, reason: "unknown" });
}

part("Before any byte: the file and the plan's room");
{
  const setup: SubmissionSetup = { instruction: "a", kinds: ["video", "pdf"], maxBytes: 200 * MiB, keepDays: 30 };
  const limit = PAID_STORAGE_BYTES.creator;
  const base = { limits: setup, declared: { bytes: 50 * MiB, type: "video/mp4", name: "squat side.mp4" }, standing: "paid" as const, tier: "creator" as const, usedBytes: 1_000, pendingBytes: 2_000 };
  is("a video that fits is reserved at its declared size", preauthorizeSubmission(base), { ok: true, reserveBytes: 50 * MiB, type: "video/mp4", extension: ".mp4", name: "squat side.mp4", limitBytes: limit });
  is("a kind the creator did not ask for", preauthorizeSubmission({ ...base, declared: { ...base.declared, type: "image/png" } }), { ok: false, reason: "type" });
  is("a type in other letters", preauthorizeSubmission({ ...base, declared: { ...base.declared, type: "Video/MP4" } }), { ok: false, reason: "type" });
  is("a type the store never takes", preauthorizeSubmission({ ...base, declared: { ...base.declared, type: "application/x-msdownload" } }), { ok: false, reason: "type" });
  is("an empty file", preauthorizeSubmission({ ...base, declared: { ...base.declared, bytes: 0 } }), { ok: false, reason: "size" });
  is("a size that is not a whole number", preauthorizeSubmission({ ...base, declared: { ...base.declared, bytes: 1.5 } }), { ok: false, reason: "size" });
  is("a size not given", preauthorizeSubmission({ ...base, declared: { ...base.declared, bytes: undefined } }), { ok: false, reason: "size" });
  is("bigger than the creator allows", preauthorizeSubmission({ ...base, declared: { ...base.declared, bytes: 200 * MiB + 1 } }), { ok: false, reason: "size" });
  is("exactly the creator's largest", preauthorizeSubmission({ ...base, declared: { ...base.declared, bytes: 200 * MiB } }).ok, true);
  is("a trial store takes no buyer files", preauthorizeSubmission({ ...base, standing: "trial" }), { ok: false, reason: "plan" });
  is("a store with no plan", preauthorizeSubmission({ ...base, standing: "none" }), { ok: false, reason: "plan" });
  is("an ended plan", preauthorizeSubmission({ ...base, standing: "ended" }), { ok: false, reason: "plan" });
  is("the plan's standing not known", preauthorizeSubmission({ ...base, standing: "unknown" }), { ok: false, reason: "unknown" });
  is("stored bytes not known", preauthorizeSubmission({ ...base, usedBytes: "unknown" }), { ok: false, reason: "unknown" });
  is("reserved uploads not known", preauthorizeSubmission({ ...base, pendingBytes: "unknown" }), { ok: false, reason: "unknown" });
  is("a negative count is unknown, never zero", preauthorizeSubmission({ ...base, usedBytes: -1 }), { ok: false, reason: "unknown" });
  is("a count past safe numbers is unknown", preauthorizeSubmission({ ...base, usedBytes: Number.MAX_SAFE_INTEGER, pendingBytes: 10 }), { ok: false, reason: "unknown" });
  is("exactly the room left fits", preauthorizeSubmission({ ...base, limits: { kinds: ["video"], maxBytes: MAX_SUBMISSION_BYTES }, usedBytes: limit - 2_000 - 40 * MiB, declared: { ...base.declared, bytes: 40 * MiB } }).ok, true);
  is("one byte more than the room left is refused", preauthorizeSubmission({ ...base, usedBytes: limit - 2_000 - 40 * MiB, pendingBytes: 0, declared: { ...base.declared, bytes: 40 * MiB + 2_001 } }), { ok: false, reason: "room" });
  is("room held by uploads still open says so", preauthorizeSubmission({ ...base, usedBytes: limit - 60 * MiB, pendingBytes: 30 * MiB, declared: { ...base.declared, bytes: 50 * MiB } }), { ok: false, reason: "pending" });
  is("a full store is refused", preauthorizeSubmission({ ...base, usedBytes: limit, pendingBytes: 0 }), { ok: false, reason: "room" });
  is("a store past its storage is refused, not wrapped", preauthorizeSubmission({ ...base, usedBytes: limit + 5 * MiB, pendingBytes: 0 }), { ok: false, reason: "room" });
  is("a bigger plan has more room", preauthorizeSubmission({ ...base, tier: "pro", usedBytes: limit, pendingBytes: 0 }).ok, true);
  is("a name with path parts is cleaned", preauthorizeSubmission({ ...base, declared: { ...base.declared, name: "../../etc/passwd" } }).ok && (preauthorizeSubmission({ ...base, declared: { ...base.declared, name: "../../etc/passwd" } }) as { name: string }).name.includes("/"), false);
  is("no name gives a plain one", (preauthorizeSubmission({ ...base, declared: { ...base.declared, name: undefined } }) as { name: string }).name, "file");
  is("the creator's reply file takes any of the three kinds", preauthorizeSubmission({ ...base, limits: REPLY_FILE_LIMITS, declared: { bytes: 2 * MiB, type: "application/pdf", name: "notes.pdf" } }).ok, true);
  is("the reply file keeps the code's maximum", REPLY_FILE_LIMITS.maxBytes, MAX_SUBMISSION_BYTES);
}

part("The review: submitted, then reviewed or withdrawn, once");
{
  is("the creator reviews what was sent", nextSubmissionState("submitted", "review", "creator"), "reviewed");
  is("the buyer withdraws what was sent", nextSubmissionState("submitted", "withdraw", "buyer"), "withdrawn");
  is("a buyer cannot review", nextSubmissionState("submitted", "review", "buyer"), null);
  is("the creator cannot withdraw the buyer's file", nextSubmissionState("submitted", "withdraw", "creator"), null);
  is("a review is not given twice", nextSubmissionState("reviewed", "review", "creator"), null);
  is("a reviewed file is not withdrawn", nextSubmissionState("reviewed", "withdraw", "buyer"), null);
  is("a withdrawn file is not reviewed", nextSubmissionState("withdrawn", "review", "creator"), null);
  is("a state nobody knows moves nowhere", nextSubmissionState("waiting", "review", "creator"), null);

  const sent: Submission = {
    id: "0123456789abcdef0123456789abcdef",
    target: { kind: "lesson", courseId: "abc123def456", lessonId: "zz99yy88xx77" },
    buyer: "ana@example.com",
    file: { name: "squat.mp4", bytes: 50 * MiB, type: "video/mp4" },
    note: "",
    at: 1_000,
    keepUntil: submissionKeepUntil(1_000, 30),
    state: "submitted",
    reply: null,
    closedAt: 0,
  };
  is("kept for the creator's days from when it was sent", sent.keepUntil, 1_000 + 30 * DAY);
  is("keeping time past the code's maximum is held to it", submissionKeepUntil(1_000, MAX_SUBMISSION_KEEP_DAYS + 40), 1_000 + MAX_SUBMISSION_KEEP_DAYS * DAY);
  const reply = { text: "Knees out a little more.", file: null };
  const reviewed = applySubmissionEvent(sent, { event: "review", actor: "creator", reply }, 2_000);
  is("a review keeps the reply and when", reviewed, { ok: true, submission: { ...sent, state: "reviewed", reply: { ...reply, at: 2_000 }, closedAt: 2_000 } });
  is("the record given is not changed", sent.state, "submitted");
  is("a review without a reply is refused", applySubmissionEvent(sent, { event: "review", actor: "creator", reply: null }, 2_000), { ok: false, reason: "reply" });
  is("a withdrawal", applySubmissionEvent(sent, { event: "withdraw", actor: "buyer" }, 2_000), { ok: true, submission: { ...sent, state: "withdrawn", closedAt: 2_000 } });
  is("nothing after the keeping time", applySubmissionEvent(sent, { event: "review", actor: "creator", reply }, sent.keepUntil), { ok: false, reason: "expired" });
  is("the wrong person", applySubmissionEvent(sent, { event: "review", actor: "buyer", reply }, 2_000), { ok: false, reason: "state" });
  if (reviewed.ok) is("a reviewed one is not reviewed again", applySubmissionEvent(reviewed.submission, { event: "review", actor: "creator", reply }, 3_000), { ok: false, reason: "state" });
}

part("The creator's reply");
{
  is("text alone", readSubmissionReply({ text: "  Good depth.\r\nKeep the heels down. " }), { ok: true, reply: { text: "Good depth.\nKeep the heels down.", file: null } });
  is("no text is refused", readSubmissionReply({ text: "  " }), { ok: false, reason: "text" });
  is("too long is refused, never cut", readSubmissionReply({ text: "z".repeat(MAX_SUBMISSION_REPLY + 1) }), { ok: false, reason: "text" });
  is("text with a file", readSubmissionReply({ text: "See the notes.", file: { name: "notes.pdf", bytes: 3 * MiB, type: "application/pdf" } }), { ok: true, reply: { text: "See the notes.", file: { name: "notes.pdf", bytes: 3 * MiB, type: "application/pdf" } } });
  is("a reply file of another kind is refused", readSubmissionReply({ text: "a", file: { name: "x.zip", bytes: 3, type: "application/zip" } }), { ok: false, reason: "file" });
  is("a reply file too big is refused", readSubmissionReply({ text: "a", file: { name: "x.mp4", bytes: MAX_SUBMISSION_BYTES + 1, type: "video/mp4" } }), { ok: false, reason: "file" });
  is("a reply file with no size is refused", readSubmissionReply({ text: "a", file: { name: "x.mp4", type: "video/mp4" } }), { ok: false, reason: "file" });
  is("the buyer's note has its own maximum", MAX_SUBMISSION_NOTE > 0 && MAX_SUBMISSION_NOTE <= MAX_SUBMISSION_REPLY, true);
}

part("Who may open it");
{
  const sub = { buyer: "ana@example.com", state: "submitted" as const };
  is("the buyer who sent it", mayOpenSubmission(sub, { kind: "buyer", email: " ANA@example.com" }), true);
  is("another buyer never", mayOpenSubmission(sub, { kind: "buyer", email: "bob@example.com" }), false);
  is("a buyer with no address never", mayOpenSubmission(sub, { kind: "buyer", email: "" }), false);
  is("a team member allowed to review", mayOpenSubmission(sub, { kind: "team", mayReview: true }), true);
  is("a team member who is not", mayOpenSubmission(sub, { kind: "team", mayReview: false }), false);
  is("a team member whose permission is unknown", mayOpenSubmission(sub, { kind: "team", mayReview: "unknown" }), false);
  is("a withdrawn file is not opened by the team", mayOpenSubmission({ ...sub, state: "withdrawn" }, { kind: "team", mayReview: true }), false);
  is("nor by the buyer who withdrew it", mayOpenSubmission({ ...sub, state: "withdrawn" }, { kind: "buyer", email: "ana@example.com" }), false);
  is("nobody else", mayOpenSubmission(sub, { kind: "public" } as never), false);
}

part("The file alone, and the kept record's ceiling (unit 2)");
{
  const setup: SubmissionSetup = { instruction: "a", kinds: ["video"], maxBytes: 200 * MiB, keepDays: 30 };
  const facts = { limits: setup, declared: { bytes: 50 * MiB, type: "video/mp4", name: "a.mp4" }, standing: "paid" as const, tier: "pro" as const };
  is("the file checked without counts", checkSubmissionFile(facts), { ok: true, bytes: 50 * MiB, type: "video/mp4", extension: ".mp4", name: "a.mp4", limitBytes: PAID_STORAGE_BYTES.pro });
  is("says the same no as the whole decision", checkSubmissionFile({ ...facts, standing: "trial" }), preauthorizeSubmission({ ...facts, standing: "trial", usedBytes: 0, pendingBytes: 0 }));
  is("and the same yes, with the room left to it", preauthorizeSubmission({ ...facts, usedBytes: 0, pendingBytes: 0 }).ok, true);
  const worst = "\u0001".repeat(MAX_SUBMISSION_NOTE);
  const record: Submission = {
    id: "f".repeat(32),
    target: { kind: "call", productId: "p".repeat(64), bookingId: "b".repeat(64) },
    buyer: "x".repeat(254),
    file: { name: "\u0001".repeat(120), bytes: MAX_SUBMISSION_BYTES, type: "application/pdf" },
    note: worst,
    at: 1_800_000_000,
    keepUntil: 1_900_000_000,
    state: "reviewed",
    reply: { text: "\u0002".repeat(MAX_SUBMISSION_REPLY), file: { name: "\u0003".repeat(120), bytes: MAX_SUBMISSION_BYTES, type: "video/quicktime" }, at: 1_800_000_001 },
    closedAt: 1_800_000_001,
  };
  const kept = { ...record, path: "vault/" + "f".repeat(32) + "/sub_" + "f".repeat(32) + "/0123456789abcdef-" + "n".repeat(120), who: "w".repeat(32), folder: "f".repeat(32) };
  is("a record at its worst still fits the ceiling", submissionRecordJson(kept) !== null, true);
  is("one past the ceiling is never written", submissionRecordJson({ ...kept, note: worst + "\u0001".repeat(800) }), null);
  is("the ceiling is a few tens of kilobytes", MAX_SUBMISSION_RECORD_BYTES < 64 * 1024, true);
}

done();
