import type { NextRequest } from "next/server";
import { creatorFrom, holdStudio } from "@/lib/studio-route";
import { readForm, readResponses, responsesSize } from "@/lib/form-store";
import { FORM_ID, responsesCsv } from "@/lib/forms";
import { exportUnitsPast } from "@/lib/export-unit-rules";
import { FORM_EXPORT_COMMANDS, formExportReadMost } from "@/lib/form-export-rules";
import { shortWords } from "@/lib/download-words";


/**
 * A form's answers as a spreadsheet (lib/forms.ts, responsesCsv): every one
 * kept, newest first. Answers can hold people's addresses and their own
 * words, so only a role that may download the store's files reaches it.
 *
 * Its answers can weigh as much as the store's data room, so it takes from the
 * store's studio figure what reading and sending them costs, at the unit of a
 * download (lib/export-unit-rules.ts), before any answer is read (#5010 row
 * 145): their count and length are measured in Redis first, with nothing read
 * out (responsesSize), and held at their widest, every byte of an answer sent
 * back escaped in six (lib/form-export-rules.ts); the file is held before it
 * is sent, and what was
 * held and not used is given back. A size that does not read, or a figure
 * without the units, refuses with no answer read. Measured in
 * tests/forms-export-held.test.ts.
 */

export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "export");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  const id = request.nextUrl.searchParams.get("id") ?? "";
  const plain = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (!FORM_ID.test(id)) return plain(400, "Which form?");
  const form = await readForm(store.statsId, id).catch(() => undefined);
  if (form === undefined) return plain(503, "unavailable");
  if (!form) return plain(404, "That form is gone.");
  const size = await responsesSize(store.statsId, id).catch(() => null);
  if (size === null) return plain(503, "unavailable");

  // Held before any answer is read: the read at its widest.
  const readMost = formExportReadMost(size);
  let holding = size.count === 0 ? 0 : exportUnitsPast(FORM_EXPORT_COMMANDS, readMost);
  const holds: { units: number; give: (n: number) => Promise<void>; force: (n: number) => Promise<void> }[] = [];
  if (holding > 0) {
    const held = await holdStudio(store, holding);
    if (!held.ok) return plain(held.reason === "unknown" ? 503 : 429, held.reason === "unknown" ? "unavailable" : held.reason === "used" ? shortWords(store, holding, held) : held.message);
    holds.push({ units: holding, give: held.give, force: held.force });
  }
  /** What was read and sent, counted at the units it took, and what was held and not used given back. */
  const settle = async (used: number) => {
    try {
      if (used > holding) await holds[0]?.force(used - holding);
      let back = holding - used;
      for (const hold of [...holds].reverse()) {
        if (back <= 0) break;
        const n = Math.min(back, hold.units);
        await hold.give(n);
        back -= n;
      }
    } catch (error) {
      console.error("settling a form's answers file failed", error);
    }
  };

  const read = await readResponses(store.statsId, id).catch(() => null);
  if (read === null) {
    // A read that failed is counted at its most, since it is never measured.
    await settle(holding > 0 ? exportUnitsPast(FORM_EXPORT_COMMANDS, readMost) : 0);
    return plain(503, "unavailable");
  }
  const { responses } = read;
  const name = `${form.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "form"}-${new Date().toISOString().slice(0, 10)}.csv`;
  // The byte-order mark makes Excel read the file as UTF-8.
  const body = `﻿${responsesCsv(form, responses)}`;
  const sent = Buffer.byteLength(body, "utf8");
  const used = responses.length === 0 ? 0 : exportUnitsPast(FORM_EXPORT_COMMANDS, read.bytes + sent);
  if (used > holding) {
    // The file is held before it is sent; read already, its answers are counted whatever the figure says.
    const top = await holdStudio(store, used - holding);
    if (!top.ok) {
      await settle(exportUnitsPast(FORM_EXPORT_COMMANDS, read.bytes));
      return plain(top.reason === "unknown" ? 503 : 429, top.reason === "unknown" ? "unavailable" : top.reason === "used" ? shortWords(store, used, { limit: top.limit, left: top.left === undefined ? undefined : top.left + holding, reset: top.reset }, true) : top.message);
    }
    holds.push({ units: used - holding, give: top.give, force: top.force });
    holding = used;
  }
  await settle(used);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
