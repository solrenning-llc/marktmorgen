import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import StudioCardPage from "@/app/studio/card/page";
import { claimHandle, ensureStatsId, ensureStoreId, setContact } from "@/lib/store";
import { contactOpen } from "@/lib/store-contact";
import { store as redis } from "./redis-stub";
import { useStore } from "./review-i2-1965-world";

for (const state of ["available", "off", "suspended", "email", "provider"] as const) test("actual studio contact state: " + state, async () => {
 redis.clear();
 for (const key of ["RESEND_API_KEY", "RESEND_CREATORS_API_KEY", "AWS_SES_ROLE_ARN", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN"]) delete process.env[key];
 if (state !== "provider") process.env.RESEND_API_KEY = "re_synthetic_contact_review";
 const owner = "review-card-return@example.test";
 assert.equal((await claimHandle(owner, "cardreturn", "Synthetic shop", "")).ok, true);
 await ensureStatsId(owner); await ensureStoreId(owner);
 const saved = (await setContact(owner, { on: state !== "off", heading: "", line: "" }))!;
 const shop = { ...saved, ...(state === "suspended" ? { suspended: "Synthetic suspension" } : {}), ...(state === "email" ? { email: "" } : {}) };
 useStore(shop);
 assert.equal(contactOpen(shop), state === "available");
 const html = renderToStaticMarkup(await StudioCardPage({ searchParams: Promise.resolve({}) }));
 assert.equal(html.includes("contact form is off"), state === "off");
 assert.equal(html.includes("Turn on the contact form"), state === "off");
 assert.equal(html.includes("contact form lets visitors"), state === "available");
 if (state === "suspended") assert.match(html, /contact form is on, but it takes no messages while your store is switched off/);
 if (state === "email") assert.match(html, /contact form is on, but it takes no messages until your store has an email address/);
 if (state === "provider") assert.match(html, /contact form is on, but it cannot take messages just now/);
});
