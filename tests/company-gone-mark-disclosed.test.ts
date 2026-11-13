/**
 * Claude 1 cloud's MEDIUM on #4026: every erasure keeps a one-way mark of the person for the companies
 * (lib/crm-companies.ts, goneKey) for GONE_SECONDS, 401 days, so no undo or link puts them back. The print is of the
 * store and the person's key, so whoever has the address can recompute it: linked pseudonymous data, not anonymous.
 * The deletion screen (keptLines, lib/person-data.ts) and the privacy policy's "What is kept" must say so, with how
 * long it lasts and how it is lifted (their own yes to the store's list, lib/contacts.ts).
 */
import { readFileSync } from "node:fs";
import { GONE_SECONDS } from "@/lib/crm-companies";
import { PERSON_DATA, keptLines } from "@/lib/person-data";
import { done, is, part } from "./check";

part("The mark itself");
is("it lasts 401 days", GONE_SECONDS, 401 * 86_400);

part("What the deletion screen says is kept");
const line = PERSON_DATA.find((d) => d.file === "lib/crm-companies.ts" && d.how === "kept");
is("lib/crm-companies.ts has a kept line", Boolean(line), true);
const shown = keptLines().find((k) => /compan/i.test(k.what));
is("the deletion screen lists it", Boolean(shown), true);
is("it says how long it lasts", /401 days/.test(shown?.what ?? ""), true);
is("it says how it is lifted: their own yes to the store's list", /their own|yourself/i.test(`${shown?.what ?? ""} ${shown?.why ?? ""}`), true);
is("it says why, and that it is not anonymous", /never put back|put (them|you) back/i.test(shown?.why ?? "") && /not anonymous/i.test(shown?.why ?? ""), true);

part("What the privacy policy says is kept");
const policy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ").replace(/&apos;/g, "'");
is("the policy names the companies' mark and its 401 days", /compan[^.]*401 days|401 days[^.]*compan/i.test(policy), true);

done();
