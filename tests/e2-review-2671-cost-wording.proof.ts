/** Evidence only: lack of a direct OAuth price source is not proof of no per-call charge. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { done, is } from "./check";
import { GOOGLE_SIGNIN_APPROVED } from "@/lib/google-signin";

const revision = process.env.REVIEW_GUIDE_REV;
if (revision && !/^[0-9a-f]{40}$/.test(revision)) throw new Error("expected a full source commit");
const guide = revision
  ? execFileSync("git", ["show", `${revision}:docs/google-signin.md`], { encoding: "utf8" })
  : readFileSync("docs/google-signin.md", "utf8");
const costs = /## Custos\n([\s\S]*?)(?=\n## )/.exec(guide)?.[1] ?? "";

is("the actual cost section is present", costs.includes("por login"), true);
is("the price source is expressly unverified", costs.includes("não conferido em fonte oficial") || costs.includes('sem fonte que diga "free"'), true);
is("an unverified price is not asserted as uncharged", costs.includes("**não cobrado por chamada"), false);
is("the product remains disabled; no runtime opening is alleged", GOOGLE_SIGNIN_APPROVED, false);
done();
