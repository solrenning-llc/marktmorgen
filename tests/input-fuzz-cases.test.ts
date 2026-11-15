/**
 * The smallest inputs tests/input-fuzz.test.ts found breaking a reader, each pinned as a plain case
 * (Claude 7, 13 November 2026), so the defect cannot come back even if the generator changes.
 */
import { createHmac } from "node:crypto";
import { done, is, part } from "./check";
import { inboundSigned } from "@/lib/inbound-mail";
import { readBatch } from "@/lib/imports";
import { adjacentCustomRange, presetCustomRange } from "@/lib/custom-range-dates";
import { signedUser } from "@/lib/meta-ads";
import { seal, unseal } from "@/lib/secret-box";
import { UnknownReply, exactReplies, plainList, replyCount } from "@/lib/redis-exact";

part("Resend: a signature is believed only in its exact base64");
{
  const secret = Buffer.alloc(24, 7);
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${secret.toString("base64")}`;
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const body = '{"type":"email.received"}';
  const good = createHmac("sha256", secret).update(`msg_fuzz.${ts}.${body}`).digest("base64");
  is("the exact signature is believed", inboundSigned(body, "msg_fuzz", ts, `v1,${good}`, now), true);
  // Node's base64 decoder skips characters outside the alphabet, so these decoded to the right bytes.
  for (const garbled of [`${good.slice(0, 10)}é${good.slice(10)}`, `${good}$`, `${good}=`, `*${good}`, good.replace(/=$/, "")]) {
    is(`a garbled signature ${JSON.stringify(garbled.slice(-6))} is refused`, inboundSigned(body, "msg_fuzz", ts, `v1,${garbled}`, now), false);
  }
}

part("Import batches: a row number is a whole number or its plain decimal text");
{
  const row = (line: unknown) => readBatch("members", [[line, "person@example.test", "membership", "2026-12-05", ""]]);
  is("the page's own text \"7\" reads", row("7")?.[0][0], "7");
  is("a whole number 7 reads", row(7)?.[0][0], "7");
  // Number() read each of these as a row number.
  for (const garbled of [true, "1e1", "0x10", " 3", "3 ", "+4", "07", [5], "\u0663"]) is(`${JSON.stringify(garbled)} is refused`, row(garbled), null);
}

part("Custom ranges: never a day before the year 0000");
{
  // toISOString() writes such a day as "-000001-12-31", and its first ten characters are not a day.
  is("yesterday of 0000-01-01 is refused", presetCustomRange("yesterday", "0000-01-01"), null);
  is("the last 7 days up to 0000-01-03 are refused", presetCustomRange("7d", "0000-01-03"), null);
  is("last month of 0000-01-15 is refused", presetCustomRange("last-month", "0000-01-15"), null);
  is("the 7 completed days before 0000-01-03 are refused", presetCustomRange("7d-closed", "0000-01-03"), null);
  is("the period before 0000-01-01..0000-01-02 is refused", adjacentCustomRange({ from: "0000-01-01", to: "0000-01-02" }, -1, "0000-03-01"), null);
  is("yesterday of 0000-01-02 still reads", presetCustomRange("yesterday", "0000-01-02"), { from: "0000-01-01", to: "0000-01-01" });
  is("an ordinary period still moves", adjacentCustomRange({ from: "2026-11-01", to: "2026-11-07" }, -1, "2026-11-13"), { from: "2026-10-25", to: "2026-10-31" });
}

part("Exact Redis replies: a Proxy is refused before any of its traps runs");
{
  let ran = 0;
  const proxy = new Proxy(["a"], { getOwnPropertyDescriptor: (t, k) => ((ran += 1), Reflect.getOwnPropertyDescriptor(t, k)) });
  is("plainList refuses a Proxy", plainList(proxy), null);
  let refused = false;
  try {
    exactReplies(proxy, 1, "fuzz");
  } catch (error) {
    refused = error instanceof UnknownReply;
  }
  is("exactReplies refuses a Proxy as unknown", refused, true);
  is("none of its traps ran", ran, 0);
  is("a plain list still reads", plainList(["a", 1]), ["a", 1]);
}

part("Exact Redis replies: a count is a safe whole number");
{
  const count = (raw: unknown) => {
    try {
      return replyCount(raw, "fuzz");
    } catch (error) {
      return error instanceof UnknownReply ? "unknown" : String(error);
    }
  };
  for (const garbled of [1e300, 2 ** 53, Number.MAX_VALUE]) is(`${garbled} is not a count`, count(garbled), "unknown");
  is("3 is a count", count(3), 3);
  is("the largest safe whole number is a count", count(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
}

part("Meta: a signed_request is believed only with its exact base64url signature");
{
  process.env.META_APP_SECRET = "fuzz-meta-secret";
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "123456" })).toString("base64url");
  const good = createHmac("sha256", "fuzz-meta-secret").update(payload).digest("base64url");
  is("the exact signature is believed", signedUser(`${good}.${payload}`), "123456");
  // Node's decoder skips characters outside the alphabet, takes "+" and "/" for "-" and "_", and ignores padding.
  const swapped = good.replace(/-/g, "+").replace(/_/g, "/");
  for (const garbled of [`${good.slice(0, 9)}!${good.slice(9)}`, `${good}=`, `*${good}`, ...(swapped !== good ? [swapped] : [])]) {
    is(`a garbled signature ${JSON.stringify(garbled.slice(-6))} is refused`, signedUser(`${garbled}.${payload}`), null);
  }
}

part("Sealed values: open only in their exact base64url");
{
  const sealed = seal("fuzz-value", "fuzz-context");
  is("the sealed value opens", unseal(sealed, "fuzz-context"), { ok: true, value: "fuzz-value", legacy: false });
  const parts = sealed.split(".");
  const garble = (at: 2 | 3, change: (part: string) => string) => parts.map((part, i) => (i === at ? change(part) : part)).join(".");
  for (const [what, garbled] of [
    ["a character outside the alphabet in the nonce", garble(2, (p) => `${p.slice(0, 3)}!${p.slice(3)}`)],
    ["padding on the data", garble(3, (p) => `${p}==`)],
    ["a space inside the data", garble(3, (p) => `${p.slice(0, 5)} ${p.slice(5)}`)],
  ] as const) {
    is(`${what} is refused`, unseal(garbled, "fuzz-context"), { ok: false, reason: "broken" });
  }
}

done();
