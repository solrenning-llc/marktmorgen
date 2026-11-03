import type { NextRequest } from "next/server";
import { setProductCall, storeForEmail } from "@/lib/store";
import { type CallSetup, readSetup } from "@/lib/call-setup";
import { checkCallChange } from "@/lib/calls";
import { guardStoreWrite, text } from "@/lib/store-request";
import { usableProviders } from "@/lib/meet-connect";
import { readTeams, writeTeam } from "@/lib/team-booking";
import { readCallLengths } from "@/lib/call-lengths";
import { readProduct } from "@/lib/catalog";
import { toMajor } from "@/lib/money";

/**
 * Makes a product a paid call, changes its hours, or turns it back.
 *
 * `{ id, call: {...} }` sets it; `{ id, remove: true }` turns it back into an
 * ordinary product. Every field of the setup is checked here, whatever the
 * studio already checked, and so is what buyers already booked
 * (checkCallChange): a booked session is not moved from under them. A call
 * set to make Google Meet or Zoom meetings is only saved while the store has
 * that account connected and working (lib/meet-connect.ts).
 */
export async function POST(request: NextRequest) {
  // Fifty dated sessions, each with its own meeting link, fit well inside this.
  const guarded = await guardStoreWrite(request, "products", 40_000);
  if (!guarded.ok) return guarded.response;

  const id = text(guarded.body.id, 40);
  if (!id) return Response.json({ ok: false, error: "unknown" }, { status: 400 });

  let setup: CallSetup | null = null;
  if (guarded.body.remove !== true) {
    const read = readSetup(guarded.body.call);
    if (typeof read === "string") {
      return Response.json({ ok: false, error: read }, { status: 400 });
    }
    setup = read;
    // A deposit (lib/call-deposit.ts; 520 [LB1] unit 5a) is not offered yet: the booking page, the page after paying
    // and the emails do not say what is left to pay in person, and the editor does not keep it. Refused until they do (5b).
    if (setup.deposit) return Response.json({ ok: false, error: "deposit" }, { status: 400 });
    // Several lengths (637 [GL5]) come only as the editor sends them, typed, in `lengths` beside the call, and are checked
    // below with the store's currency, the product's price, package and team; never as a stored list sent from outside.
    if (setup.lengths) return Response.json({ ok: false, error: "lengths" }, { status: 400 });
    // In person chosen with no address (lib/call-place.ts): never saved as a call with no link.
    const asked = (guarded.body.call as { place?: unknown } | null | undefined)?.place;
    if (asked !== undefined && asked !== null && !setup.place) return Response.json({ ok: false, error: "place" }, { status: 400 });
    if (setup.meet && !(await usableProviders(guarded.store.statsId)).includes(setup.meet)) {
      return Response.json({ ok: false, error: `meet_${setup.meet}` }, { status: 400 });
    }
  }

  try {
    if (setup) {
      const store = await storeForEmail(guarded.ref);
      if (store) {
        // Other lengths than the call's own, each with its price (lib/call-lengths.ts): the call's own first, at the product's price.
        const extra = guarded.body.lengths;
        if (Array.isArray(extra) && extra.length > 0) {
          const product = await readProduct(store, id);
          if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
          const read = readCallLengths([{ minutes: setup.minutes, price: toMajor(product.priceCents, store.currency) }, ...extra], {
            setup,
            currency: store.currency,
            packaged: Boolean(product.callPackage),
            deposit: setup.deposit ?? null,
            team: (await readTeams(store)).has(id),
          });
          if (!read.ok) return Response.json({ ok: false, error: "lengths", problem: read.problem, ...(read.minutes ? { minutes: read.minutes } : {}) }, { status: 400 });
          // The call's own length is the shortest: another length is always longer, so the price on the store stays the call's own.
          if (read.lengths[0].minutes !== setup.minutes) return Response.json({ ok: false, error: "lengths", problem: "shorter" }, { status: 400 });
          setup = { ...setup, lengths: read.lengths };
        }
        const checked = await checkCallChange(store, id, setup);
        if (typeof checked === "string") {
          return Response.json({ ok: false, error: checked }, { status: checked === "error" ? 503 : 400 });
        }
        setup = checked;
      }
    }
    const result = await setProductCall(guarded.ref, id, setup);
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
    // No longer a call: its team, if it had one, goes with it (lib/team-booking.ts).
    if (!setup) await writeTeam(result.store, id, null).catch((error) => console.error("dropping a call's team failed", error));
    // Nothing of the store record goes back: the editor needs only to know it saved.
    return Response.json({ ok: true });
  } catch (error) {
    console.error("saving a call failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
