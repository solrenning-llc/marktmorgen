/**
 * The store address typed on the home page reaches the address step after
 * the emailed link, so it is not typed twice (VS1, WCAG 3.3.7 Redundant
 * Entry). What is checked, against the real code:
 *
 *   - only a valid store address, by the store's own handle rules, is ever
 *     carried; anything else is dropped at every step;
 *   - the sign-in link carries it, the one-tap page and the callback pass it
 *     on, and the studio's address field opens filled in with it;
 *   - nothing is reserved and nothing new is kept: no handle record, no
 *     store, and the link's own record holds only the email address;
 *   - without a typed address, every step behaves exactly as before.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { prefillHandle, withPrefill } from "@/lib/handle-prefill";
import { sendSignInLink } from "@/lib/auth";
import { storeForEmail, storeForHandle } from "@/lib/store";
import { POST as callback, GET as callbackGet } from "@/app/api/auth/callback/route";
import ConfirmPage from "@/app/signin/confirm/page";
import { HandleForm } from "@/components/handle-form";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_handle_prefill_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const linkIn = (text: string) => /https:\/\/marktmorgen\.com\/signin\/confirm\?\S+/.exec(text)?.[0] ?? "";
const post = (url: string, fields: Record<string, string>) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

async function main(): Promise<void> {
  redis.clear();

  part("Only a valid store address is carried");
  is("a plain one, as typed on the home page", prefillHandle("harborkitchen"), "harborkitchen");
  is("an @ and capitals are tidied the store's own way", prefillHandle("  @Harbor.Kitchen "), "harbor.kitchen");
  is("too short, bad characters, bad ends, a site name and too long are dropped",
    ["ab", "harbor kitchen", "harbor<script>", "-harbor", "harbor-", "admin", "a".repeat(25), "a".repeat(65)].map(prefillHandle),
    ["", "", "", "", "", "", "", ""]);
  is("anything that is not text is dropped", [prefillHandle(undefined), prefillHandle(null), prefillHandle(["harbor"]), prefillHandle(42), prefillHandle("")], ["", "", "", "", ""]);
  is("added to an address only when valid", [withPrefill("/studio", "harborkitchen"), withPrefill("/a?b=1", "harbor"), withPrefill("/studio", "no way"), withPrefill("/studio", undefined)], ["/studio?handle=harborkitchen", "/a?b=1&handle=harbor", "/studio", "/studio"]);

  part("The emailed link carries it, and nothing is kept for it");
  is("sent", (await sendSignInLink("maker@example.com", ORIGIN, "harborkitchen")).sent, true);
  const link = linkIn(mails.at(-1)!.text);
  const url = new URL(link);
  is("the link has the address", url.searchParams.get("handle"), "harborkitchen");
  const token = url.searchParams.get("token") ?? "";
  is("and its own token", /^[0-9a-f]{64}$/.test(token), true);
  const linkValues = await Promise.all(redis.keys().filter((key) => key.startsWith("nl:auth:link:")).map(async (key) => (await redis.pipeline([["GET", key]]))[0]));
  is("the link's record holds the email address only", linkValues, ["maker@example.com"]);
  is("no record anywhere names the address", redis.keys().some((key) => key.includes("harborkitchen")), false);

  await sendSignInLink("maker2@example.com", ORIGIN, "admin");
  is("a site name is not put in the link", new URL(linkIn(mails.at(-1)!.text)).searchParams.has("handle"), false);
  await sendSignInLink("maker3@example.com", ORIGIN, "x<y");
  is("an invalid address is not put in the link", new URL(linkIn(mails.at(-1)!.text)).searchParams.has("handle"), false);
  await sendSignInLink("maker4@example.com", ORIGIN);
  is("without one, the link is exactly as before", /^https:\/\/marktmorgen\.com\/signin\/confirm\?token=[0-9a-f]{64}$/.test(linkIn(mails.at(-1)!.text)), true);

  part("The one-tap page and the callback pass it on");
  const page = renderToStaticMarkup(await ConfirmPage({ searchParams: Promise.resolve({ token, handle: "harborkitchen" }) }));
  is("the one-tap form carries it as a hidden field", page.includes('<input type="hidden" name="handle" value="harborkitchen"/>'), true);
  const tampered = renderToStaticMarkup(await ConfirmPage({ searchParams: Promise.resolve({ token, handle: '"><script>x</script>' }) }));
  is("a tampered one is dropped there", [tampered.includes('name="handle"'), tampered.includes("<script>x")], [false, false]);
  const got = await callbackGet(new NextRequest(`${ORIGIN}/api/auth/callback?token=${token}&handle=harborkitchen`));
  is("an old link to the callback keeps it on the way to the one-tap page", got.headers.get("location"), `${ORIGIN}/signin/confirm?token=${token}&handle=harborkitchen`);

  const opened = await callback(post(`${ORIGIN}/api/auth/callback`, { token, handle: "harborkitchen" }));
  is("the session opens on the address step with it", opened.headers.get("location"), `${ORIGIN}/studio?handle=harborkitchen`);
  is("and the session cookie is set as always", /nl_session=[0-9a-f]{64}/.test(opened.headers.get("set-cookie") ?? ""), true);
  is("nothing is reserved: no store holds the address", await storeForHandle("harborkitchen"), null);
  is("and the account has no store until the form is sent", await storeForEmail("maker@example.com"), null);
  is("no record names the address", redis.keys().some((key) => key.includes("harborkitchen")), false);

  await sendSignInLink("maker5@example.com", ORIGIN);
  const plainToken = new URL(linkIn(mails.at(-1)!.text)).searchParams.get("token") ?? "";
  const bad = await callback(post(`${ORIGIN}/api/auth/callback`, { token: plainToken, handle: "Not A Handle!" }));
  is("an invalid one posted to the callback is ignored", bad.headers.get("location"), `${ORIGIN}/studio`);
  await sendSignInLink("maker6@example.com", ORIGIN);
  const noneToken = new URL(linkIn(mails.at(-1)!.text)).searchParams.get("token") ?? "";
  const none = await callback(post(`${ORIGIN}/api/auth/callback`, { token: noneToken }));
  is("without one, the studio opens as before", none.headers.get("location"), `${ORIGIN}/studio`);

  part("The address step opens filled in");
  const filled = renderToStaticMarkup(createElement(HandleForm, { initial: "harborkitchen" }));
  is("the address field has it", /id="store-handle"[^>]*value="harborkitchen"/.test(filled), true);
  is("and says where the store will live", filled.includes("Your store will live at marktmorgen.com/@harborkitchen"), true);
  const empty = renderToStaticMarkup(createElement(HandleForm));
  is("without one, it opens empty as before", /id="store-handle"[^>]*value=""/.test(empty), true);

  part("Each page reads it again on the server");
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  is("the studio fills the field from the checked address only", studio.includes("<HandleForm initial={prefillHandle(params.handle)} />"), true);
  const request = readFileSync("app/api/auth/request/route.ts", "utf8");
  is("the login request checks it before the link is made", request.includes("sendSignInLink(email, linkOrigin(request), prefillHandle(body.handle))"), true);
  const signin = readFileSync("app/signin/page.tsx", "utf8");
  is("the start page sends only a valid one with the email", signin.includes('<SignInForm handle={asked && !returning && askedProblem === null ? asked : ""} />'), true);
  const form = readFileSync("components/signin-form.tsx", "utf8");
  is("the sign-in form sends it with the email, and the email alone without it", form.includes("JSON.stringify(handle ? { email, website, handle } : { email, website })"), true);
  const handleForm = readFileSync("components/handle-form.tsx", "utf8");
  is("the new studio address does not keep it", handleForm.includes('destination.searchParams.delete("handle")'), true);
  is("no browser storage is used for it", [handleForm, form, readFileSync("lib/handle-prefill.ts", "utf8")].some((source) => /localStorage|sessionStorage|indexedDB|document\.cookie/.test(source)), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
