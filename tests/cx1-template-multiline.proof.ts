import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { POST as saveSite } from "@/app/api/store/site-page/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
async function main() {
  redis.clear();
  const owner = "cx1-template@example.com";
  await claimHandle(owner, "cx1template", "CX1 Template", "");
  await ensureStatsId(owner);
  const token = await openSession(owner);
  const post = async (body: unknown) => {
    const r = await saveSite(new NextRequest("https://marktmorgen.com/api/store/site-page", {
      method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${token}` }, body: JSON.stringify(body),
    }));
    return { status: r.status, data: await r.json() };
  };
  const added = await post({ action: "add", title: "Example", slug: "example" });
  is("setup creates page", added.data.ok, true);
  const id = added.data.id;
  part("CX1: multiline marked instructions cannot be published");
  for (const body of ["⟦Write the first line\nand the second line⟧", "⟦Write the first line\r\nand the second line⟧"]) {
    const r = await post({ action: "save", id, page: { hidden: false, blocks: [{ id: "text0001", kind: "text", heading: "About", body }] } });
    is(`visible multiline placeholder refused ${JSON.stringify(body)}`, [r.status, r.data.error], [400, "placeholder"]);
  }
  const normal = await post({ action: "save", id, page: { hidden: false, blocks: [{ id: "text0001", kind: "text", heading: "About", body: "⟦Write one line⟧" }] } });
  is("single-line marker remains refused", [normal.status, normal.data.error], [400, "placeholder"]);
  const hidden = await post({ action: "save", id, page: { hidden: true, blocks: [{ id: "text0001", kind: "text", heading: "About", body: "⟦Write the first line\nand the second line⟧" }] } });
  is("hidden unfinished text is retained", hidden.data.ok, true);
  done();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
