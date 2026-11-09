import type { NextRequest } from "next/server";
import { withinStore } from "@/lib/metered-limits";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";
import { isStorePeopleExact } from "@/lib/visit";
import { ID_PATTERN, SHA_PATTERN, readSignedName } from "@/lib/agreement-rules";
import { signAgreement } from "@/lib/agreement-store";
import { agreementSigned } from "@/lib/agreement-flow-trigger";
import { sendSignedCopies } from "@/lib/agreements";

/**
 * "Sign" on an agreement's page (app/[handle]/sign/[agreement]): a plain
 * form, so it works without JavaScript. Signed only by the person it was
 * sent to, on the exact version they read (lib/agreement-store.ts,
 * signAgreement), never from a browser signed in to the store's own studio.
 * The answer is the page again, saying it is signed or what was wrong, with
 * nothing signed.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let fields: Record<string, string> = {};
  try {
    const form = await (await limited(request, 4_000)).formData();
    const read = (name: string, max: number) => {
      const value = form.get(name);
      return typeof value === "string" ? value.slice(0, max) : "";
    };
    fields = { handle: read("handle", 100), id: read("agreement", 40), n: read("version", 4), sha: read("sha256", 64), name: read("name", 400), email: read("email", 300), agree: read("agree", 10) };
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const handle = normaliseHandle(fields.handle);
  const n = Number(fields.n);
  if (!ID_PATTERN.test(fields.id) || !SHA_PATTERN.test(fields.sha) || !Number.isSafeInteger(n) || n < 1) return new Response("Bad request", { status: 400 });
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  const back = (notice: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/sign/${fields.id}${notice ? `?notice=${notice}` : ""}`, "Cache-Control": "no-store" } });

  // Ten tries a connection in ten minutes per store: far past one person signing, short of a script guessing.
  const ip = clientAddress(request);
  const room = await withinStore("agreement-sign", `${ip}|${store.handle}`, 10, 600, store, "buyer").catch(unknownLimit);
  if (room === "unknown") return back("error");
  if (!room) return back("limited");
  // The store's own people can't sign for the person it was sent to; not knowing whether this is them signs nothing (rule 24).
  let ownPeople: boolean;
  try {
    ownPeople = await isStorePeopleExact(request, store);
  } catch (error) {
    console.error("whether an agreement's signer is the store's own people is unknown; nothing signed", error);
    return back("error");
  }
  if (ownPeople) return back("studio");
  const signed = await signAgreement(store, fields.id, { n, sha256: fields.sha, name: fields.name, email: fields.email, consent: fields.agree === "yes", ip }, readSignedName(fields.name));
  if (!signed.ok) return back(signed.reason === "busy" ? "error" : signed.reason);
  // The signed copies, each one of the store's emails for the month; the signature stands whether or not they go.
  await sendSignedCopies(store, signed.agreement, signed.version, signed.signature).catch((error) => console.error("sending a signed copy failed", error));
  // 635 [GL3]: the workflows that start on signing, for the signer by the address it was sent to, only while on the list (never throws).
  await agreementSigned(store, signed.agreement.email);
  return back("signed");
}
