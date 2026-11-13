/**
 * The smallest inputs tests/input-fuzz.test.ts found breaking a reader, each pinned as a plain case
 * (Claude 7, 13 November 2026), so the defect cannot come back even if the generator changes.
 */
import { createHmac } from "node:crypto";
import { done, is, part } from "./check";
import { inboundSigned } from "@/lib/inbound-mail";
import { readBatch } from "@/lib/imports";
import { adjacentCustomRange, presetCustomRange } from "@/lib/custom-range-dates";

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

done();
