/**
 * A refused upload tells the creator why (lib/upload-refusal.ts, lib/sold-file-upload.ts).
 *
 * The studio's uploaders ask a door on our server for each upload (app/api/store/file,
 * app/api/store/image/upload, app/api/store/vault). When the door says no, it says why: a spent
 * studio window, a team that requires a second step, a held session, storage that is full, a paused
 * plan. The file store's own browser library drops that answer and throws one fixed error, so every
 * refusal used to read as "Something went wrong on our side". Here the door is stood in for, and the
 * creator must be told the door's own reason, with the window's own sentence where the door sends
 * one; a failure nobody explained reads as an upload that did not finish, with nothing changed.
 */
import { readFileSync } from "node:fs";
import * as soldFileUpload from "@/lib/sold-file-upload";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { handedBack } from "@/lib/upload-hand-back";
import { askDoor } from "@/lib/upload-refusal";
import { done, is, part } from "./check";

const DID_NOT_FINISH = "The upload did not finish, and nothing was changed. Try again in a moment.";
const WINDOW = "Your studio has used its 300 requests for this hour. They start again at 3:00 PM UTC.";
const NOT_COUNTED = "We could not check it just now. Try again in a moment.";
const LOCKED = "This action needs your second step. Log in again with it, or wait for the recovery date.";

type Answer = { status: number; body: unknown } | "down";
/** What each door answers, by the upload's own name (or "*" for any). */
let fileDoor: Record<string, Answer> = {};
let vaultDoor: Answer = { status: 404, body: { ok: false, error: "off" } };
const seen: string[] = [];

(globalThis as { location?: unknown }).location = { href: "https://marktmorgen.test/studio/products" };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://marktmorgen.test/");
  seen.push(url.pathname);
  let answer: Answer = { status: 404, body: { ok: false, error: "missing" } };
  if (url.pathname === "/api/store/vault") answer = vaultDoor;
  else if (url.pathname === "/api/store/file") {
    const asked = JSON.parse(String(init?.body ?? "{}")) as { payload?: { pathname?: string } };
    answer = fileDoor[asked.payload?.pathname ?? ""] ?? fileDoor["*"] ?? answer;
  } else if (url.pathname === "/api/other") answer = { status: 500, body: { ok: false, error: "other_words" } };
  if (answer === "down") throw new TypeError("fetch failed");
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const file = (name = "guide.pdf") => new File(["%PDF-1.7 synthetic"], name, { type: "application/pdf" });

async function refusedWith(answer: Answer, ownerId = "p0011223344556677"): Promise<unknown> {
  fileDoor = { "*": answer };
  try {
    await uploadSoldFile(file(), { folder: "0011223344556677889900aa", ownerId }, () => {});
    return null;
  } catch (thrown) {
    return thrown;
  }
}

const { uploadReason, uploadSoldFile } = soldFileUpload;
// Read off the module so this file builds before the sentence exists, and fails on what it says (RED first).
const uploadMessage = (soldFileUpload as unknown as { uploadMessage?: (thrown: unknown, own?: Record<string, string>) => string }).uploadMessage;
const said = (thrown: unknown, own: Record<string, string> = {}) =>
  typeof uploadMessage === "function" ? uploadMessage(thrown, own) : "(no uploadMessage)";

async function main(): Promise<void> {
  part("the file door's refusal reaches the creator, by its own reason");
  {
    const cases: { what: string; answer: Answer; reason: string; words: string }[] = [
      { what: "a spent studio window: the window's own sentence", answer: { status: 429, body: { ok: false, error: "studio_used", message: WINDOW } }, reason: "studio_used", words: WINDOW },
      { what: "studio requests not counted just now: the door's own sentence", answer: { status: 503, body: { ok: false, error: "studio_unavailable", message: NOT_COUNTED } }, reason: "studio_unavailable", words: NOT_COUNTED },
      { what: "a held session", answer: { status: 403, body: { ok: false, error: "locked", message: LOCKED } }, reason: "locked", words: STUDIO_MESSAGES.locked },
      { what: "a storage that is full", answer: { status: 400, body: { ok: false, error: "storage_full" } }, reason: "storage_full", words: STUDIO_MESSAGES.storage_full },
      { what: "an unpaid renewal", answer: { status: 409, body: { ok: false, error: "renewal_unpaid" } }, reason: "renewal_unpaid", words: STUDIO_MESSAGES.renewal_unpaid },
      { what: "a disputed plan payment", answer: { status: 409, body: { ok: false, error: "plan_disputed" } }, reason: "plan_disputed", words: STUDIO_MESSAGES.plan_disputed },
      { what: "file uploads unavailable", answer: { status: 503, body: { ok: false, error: "files_unavailable" } }, reason: "files_unavailable", words: STUDIO_MESSAGES.files_unavailable },
      { what: "new uploads paused", answer: { status: 503, body: { ok: false, error: "upload_budget_unavailable" } }, reason: "upload_budget_unavailable", words: STUDIO_MESSAGES.upload_budget_unavailable },
    ];
    for (const each of cases) {
      const thrown = await refusedWith(each.answer);
      is(`${each.what}: it threw`, thrown !== null, true);
      is(`${each.what}: the reason`, uploadReason(thrown), each.reason);
      is(`${each.what}: the words`, said(thrown), each.words);
    }

    const twoStep = await refusedWith({ status: 403, body: { ok: false, error: "two_step_required" } });
    is("a team that requires a second step: the reason", uploadReason(twoStep), "two_step_required");
    is("a team that requires a second step: says so", /second step/.test(said(twoStep)) && !/went wrong/.test(said(twoStep)), true);

    const role = await refusedWith({ status: 403, body: { ok: false, error: "forbidden" } });
    is("a role without products: the reason", uploadReason(role), "forbidden");
    is("a role without products: says it is about permission", /permission/i.test(said(role)), true);

    const away = await refusedWith({ status: 401, body: { ok: false, error: "signed_out" } });
    is("signed out: the reason", uploadReason(away), "signed_out");
    is("signed out: says so", /log in/i.test(said(away)), true);
  }

  part("the creator's own form keeps its own words, except where the door sent the window's sentence");
  {
    const full = await refusedWith({ status: 400, body: { ok: false, error: "storage_full" } });
    is("a form's own sentence for storage_full comes first", said(full, { storage_full: "Own words for a full store." }), "Own words for a full store.");
    const used = await refusedWith({ status: 429, body: { ok: false, error: "studio_used", message: WINDOW } });
    is("the window's own sentence comes before a form's", said(used, { studio_used: "Form words." }), WINDOW);
    const usedBare = await refusedWith({ status: 429, body: { ok: false, error: "studio_used" } });
    is("a spent window without its sentence still says the requests are used", /requests/.test(said(usedBare)) && !/went wrong/.test(said(usedBare)), true);
  }

  part("a failure nobody explained is an upload that did not finish, never a claim about our side");
  {
    const broken = await refusedWith({ status: 500, body: { ok: false, error: "server_error" } });
    is("a 500: reason server_error", uploadReason(broken), "server_error");
    is("a 500: did not finish, nothing changed", said(broken, { server_error: "Something went wrong on our side. Try again in a moment." }), DID_NOT_FINISH);
    const down = await refusedWith("down");
    is("a door that cannot be reached: reason server_error", uploadReason(down), "server_error");
    is("a door that cannot be reached: did not finish, nothing changed", said(down), DID_NOT_FINISH);
    const shapeless = await refusedWith({ status: 502, body: "<html>bad gateway</html>" });
    is("a door answering no JSON: did not finish, nothing changed", said(shapeless), DID_NOT_FINISH);
  }

  part("two uploads at once each hear their own door, and other requests are left as they were");
  {
    vaultDoor = { status: 404, body: { ok: false, error: "off" } };
    fileDoor = {
      "stores/0011223344556677889900aa/p1111111111111111/a.pdf": { status: 429, body: { ok: false, error: "studio_used", message: WINDOW } },
      "stores/0011223344556677889900aa/p2222222222222222/b.pdf": { status: 409, body: { ok: false, error: "renewal_unpaid" } },
    };
    const send = (ownerId: string, name: string) =>
      uploadSoldFile(file(name), { folder: "0011223344556677889900aa", ownerId }, () => {}).then(() => null, (thrown: unknown) => thrown);
    const [first, second] = await Promise.all([send("p1111111111111111", "a.pdf"), send("p2222222222222222", "b.pdf")]);
    const asked = seen.filter((path) => path === "/api/store/file").length;
    is("both doors were asked", asked >= 2, true);
    is("the first hears its spent window", [uploadReason(first), said(first)], ["studio_used", WINDOW]);
    is("the second hears its unpaid renewal", [uploadReason(second), said(second)], ["renewal_unpaid", STUDIO_MESSAGES.renewal_unpaid]);
    const other = await fetch("/api/other");
    is("another request's answer is untouched", [other.status, await other.json()], [500, { ok: false, error: "other_words" }]);
  }

  part("the file store that takes sold files in pieces says why too");
  {
    const vault = async (answer: Answer) => {
      vaultDoor = answer;
      try {
        await uploadSoldFile(file(), { folder: "0011223344556677889900aa", ownerId: "p0011223344556677" }, () => {});
        return null;
      } catch (thrown) {
        return thrown;
      } finally {
        vaultDoor = { status: 404, body: { ok: false, error: "off" } };
      }
    };
    const used = await vault({ status: 429, body: { ok: false, error: "studio_used", message: WINDOW } });
    is("a spent window: reason", uploadReason(used), "studio_used");
    is("a spent window: the window's own sentence", said(used), WINDOW);
    const twoStep = await vault({ status: 403, body: { ok: false, error: "two_step_required" } });
    is("a second step required: says so", /second step/.test(said(twoStep)), true);
    const gone = await vault({ status: 409, body: { ok: false, error: "store_gone" } });
    is("a store no longer there: the studio's sentence", said(gone), STUDIO_MESSAGES.store_gone);
    const big = await vault({ status: 400, body: { ok: false, error: "too_big" } });
    is("control: too big keeps its reason", uploadReason(big), "too_big");
    is("control: and the form's own words", said(big, { too_big: "That file is too big." }), "That file is too big.");
  }

  part("a door that said yes hands its upload to the library once, and the door hands it back unchanged");
  {
    const issued = { delegationToken: "delegation.synthetic", signature: "sig-synthetic", params: { pathname: "stores/f/p/a.pdf", "valid-until": "1" } };
    fileDoor = { "*": { status: 200, body: { type: "blob.generate-presigned-url", presignedUrlPayload: issued } } };
    const before = seen.length;
    is("askDoor returns what the door issued", await askDoor("/api/store/file", "stores/f/p/a.pdf", "{}"), issued);
    is("askDoor asked the door once", seen.slice(before), ["/api/store/file"]);
    fileDoor = { "*": { status: 200, body: { type: "blob.generate-presigned-url" } } };
    const empty = await askDoor("/api/store/file", "stores/f/p/a.pdf", "{}").then(() => null, (thrown: unknown) => thrown);
    is("a yes without an upload in it is no reason, and did not finish", [uploadReason(empty), said(empty)], ["server_error", DID_NOT_FINISH]);
    const odd = await refusedWith({ status: 400, body: { ok: false, error: 7, message: { not: "text" } } });
    is("a door's word that is not text is no word", [uploadReason(odd), said(odd)], ["server_error", DID_NOT_FINISH]);

    const event = (clientPayload: unknown) => ({ type: "blob.generate-presigned-url", payload: { pathname: "stores/f/p/a.pdf", clientPayload, multipart: false } });
    is("handed back: the issued upload, unchanged", handedBack(event(JSON.stringify({ handBack: issued }))), { type: "blob.generate-presigned-url", presignedUrlPayload: issued });
    is("a first ask is not handed back (the door checks and signs it)", handedBack(event(JSON.stringify({ productId: "p1" }))), null);
    is("a client payload that is not JSON is not handed back", handedBack(event("{not json")), null);
    is("an empty signature is not handed back", handedBack(event(JSON.stringify({ handBack: { ...issued, signature: "" } }))), null);
    is("params that are not text are not handed back", handedBack(event(JSON.stringify({ handBack: { ...issued, params: { a: 1 } } }))), null);
    is("another event is not handed back", handedBack({ type: "blob.upload-completed", payload: { clientPayload: JSON.stringify({ handBack: issued }) } }), null);
    is("no body is not handed back", [handedBack(null), handedBack("text")], [null, null]);
    const route = (path: string) => readFileSync(path, "utf8");
    for (const path of ["app/api/store/file/route.ts", "app/api/store/image/upload/route.ts"]) {
      const source = route(path);
      const back = source.indexOf("handedBack(body)");
      is(`${path}: hands back before anything is checked, counted or signed`, back > 0 && back < source.indexOf("studioAccess(") && back < source.indexOf("handleUploadPresigned({"), true);
      is(`${path}: only after another site is refused`, source.indexOf("fromAnotherSite(request)") < back, true);
    }
  }

  part("every studio uploader goes through the door that says why, and shows the reason");
  {
    const read = (path: string) => readFileSync(path, "utf8");
    for (const path of ["components/product-image-editor.tsx", "components/link-picture.tsx", "components/page-editor.tsx"]) {
      const source = read(path);
      // The file store's browser library throws one fixed error whatever the door said, so a picture is never sent
      // through it straight: the door is asked first, by a request that reads its answer (lib/upload-refusal.ts).
      const direct = source.split("\n").filter((line) => line.includes("uploadPresigned(") && !line.includes("import "));
      is(`${path}: no picture upload asks the door through the library alone`, direct, []);
      is(`${path}: every picture upload reads its door's answer`, source.includes("uploadThroughDoor("), true);
      is(`${path}: shows the reason`, source.includes("uploadMessage("), true);
    }
    for (const path of ["components/product-editor.tsx", "components/podcast-editor.tsx", "components/course-editor.tsx"]) {
      is(`${path}: shows the reason`, read(path).includes("uploadMessage("), true);
    }
    const sold = read("lib/sold-file-upload.ts");
    is("lib/sold-file-upload.ts: the file door is heard", sold.includes("uploadThroughDoor("), true);
  }
}

void main().then(done);
