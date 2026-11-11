/**
 * VR 2, rule 24: an affiliate's programs are listed as "nothing" only when read (lib/affiliate-hub.ts storesPromoted,
 * requestHubLink; app/affiliate/page.tsx).
 *
 * Before: a SUNION answered cut short or of another shape read as no stores, so the page told the affiliate
 * "Nothing is listed for this address any more." (as if they had left every program), and asking for the link
 * answered "sent" with nothing sent. Now the read is exact and throws, the request answers "error", and the page says
 * it could not read the programs just now, never "Nothing is listed".
 *
 * Synthetic store, address and token only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { requestHubLink, storesPromoted } from "@/lib/affiliate-hub";
import AffiliateHubPage from "@/app/affiliate/page";
import { store as redis } from "./redis-stub";

const EMAIL = "affiliate@example.com";
const TOKEN = "a".repeat(64);
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const sunionOff = (reply: unknown[]) => {
  redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "SUNION" ? reply : pipeline(b))) as typeof redis.pipeline;
};
const restore = () => {
  redis.pipeline = pipeline;
};
const linkKey = `nl:affhub:link:${createHash("sha256").update(`nimbus-affhub-link:${TOKEN}`).digest("hex").slice(0, 40)}`;

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["two replies", [[], []]]] as [string, unknown[]][]) {
  test(`the stores promoted read as ${label}: unknown, never none`, async () => {
    redis.clear();
    sunionOff(reply);
    try {
      await assert.rejects(storesPromoted(EMAIL));
    } finally {
      restore();
    }
  });
}

test("asking for the link on an unread list answers error, never sent", async () => {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_hub_only";
  sunionOff([]);
  try {
    assert.equal(await requestHubLink({ email: EMAIL, ip: "203.0.113.9", origin: "https://marktmorgen.com" }), "error");
  } finally {
    restore();
  }
});

test("the page says the programs could not be read, never Nothing is listed", async () => {
  redis.clear();
  await pipeline([["SET", linkKey, EMAIL]]);
  sunionOff([]);
  let html = "";
  try {
    html = renderToStaticMarkup(await AffiliateHubPage({ searchParams: Promise.resolve({ token: TOKEN }) } as never));
  } finally {
    restore();
  }
  assert.match(html, /could not read the programs you are in just now/);
  assert.doesNotMatch(html, /Nothing is listed/);
});

test("a known empty list still says Nothing is listed", async () => {
  redis.clear();
  await pipeline([["SET", linkKey, EMAIL]]);
  const html = renderToStaticMarkup(await AffiliateHubPage({ searchParams: Promise.resolve({ token: TOKEN }) } as never));
  assert.match(html, /Nothing is listed/);
});
