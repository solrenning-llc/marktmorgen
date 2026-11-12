/**
 * A store's page of published emails (/@handle/letters) is at every store's
 * address, whether or not it has published anything. Search engines were
 * told to keep it in every case: an empty "Emails from …" page, or one that
 * says its list could not be read, indexed under the store's name, as the
 * blog never is (its empty page is not found, its unread post out of search).
 *
 * It asks to be kept only while it lists at least one email; an empty list or
 * one that could not be read (null, rule 24) is out of search, with its links
 * still followed. The list is read once for the head and the page (cache).
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const page = readFileSync("app/[handle]/letters/page.tsx", "utf8");
const meta = page.slice(page.indexOf("export async function generateMetadata"), page.indexOf("export default async function LettersPage"));

part("When the page of emails asks to be kept");
is("only while it lists an email: none, or a list not read, is out of search", meta.includes("robots: { index: Boolean(letters?.length), follow: true },"), true);
is("a resting store's page is out of search, and its list is not read for it", [meta.includes("const letters = (await restingOf(store)) ? null : await lettersOf(store);"), /const restingOf = cache\(/.test(page), page.includes("if (await restingOf(store)) return <StoreResting")], [true, true, true]);
is("the head reads the list the page reads, once", [/const lettersOf = cache\(/.test(page), meta.includes("await lettersOf(store)"), page.slice(page.indexOf("export default async function LettersPage")).includes("await lettersOf(store)")], [true, true, true]);
done();
