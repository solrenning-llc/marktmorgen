import { fastMoneyRefusal } from "@/lib/terms-check-rules";
import type { NextRequest } from "next/server";
import { deleteFile as del } from "@/lib/file-store";
import {
  addOption,
  editOption,
  moveOption,
  removeOption,
  setOptionOnSaleChecked,
  type OptionResult,
} from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { planPausedByRestore } from "@/lib/product-extras";
import { keptNumbersWithin, membersOnOption } from "@/lib/membership-numbers";
import { pendingInvitesOnOptions } from "@/lib/move-members";
import { MAX_OPTION_DETAILS, MAX_OPTION_DETAIL_LENGTH, MAX_OPTION_LABEL_LENGTH } from "@/lib/product-option";
import { guardStoreWrite, text } from "@/lib/store-request";
import { StoreFullError } from "@/lib/store";
import { dropStamped } from "@/lib/pdf-stamp";
import { readOptionDirection } from "@/lib/option-request";

/** The most bytes of kept membership numbers the count reads (one studio request's included bytes, less room). */
const OPTION_COUNT_BYTES = 40_000;

const ACTIONS = new Set(["add", "edit", "remove", "move", "sale", "count", "invited"]);

/** How firmly to answer when a change is refused. */
const STATUS: Record<string, number> = {
  too_many: 409,
  store_too_many: 409,
  unknown: 404,
  plan_pauses: 409,
};

/**
 * Adds, changes, reorders or removes one price option on a product, takes
 * one off sale or puts it back ("sale"), or says how many members are on
 * each of a product's options ("count").
 *
 * A price is set here and read back on the server at checkout, never sent by
 * the buyer, so this route is the only place an amount enters. The file an
 * option delivers is attached by the same routes a product's file is, because
 * an option holds one exactly as a product does.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products");
  if (!guarded.ok) return guarded.response;

  const { ref, body } = guarded;
  const action = text(body.action, 10);
  if (!ACTIONS.has(action)) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  // On "add" this names the product the option goes on; on everything else it
  // names the option itself.
  const id = text(body.id, 40);
  const label = text(body.label, MAX_OPTION_LABEL_LENGTH);
  const price = text(body.price, 20);

  if (!id) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  try {
    // How many members are on each option, from the kept membership reading only
    // (642 [WG2]): Stripe is never read here, so a store with nothing kept, or a
    // reading kept before options were counted, gets null (unknown), never 0.
    if (action === "count") {
      const product = await readProduct(guarded.store, id);
      if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
      // At most OPTION_COUNT_BYTES of the kept reading is transferred (Codex Z on #2690): a bigger one is unknown here,
      // and the Memberships page, which pays for its own reading, shows it per price (components/membership-by-price.tsx).
      const numbers = await keptNumbersWithin(guarded.store, OPTION_COUNT_BYTES).catch(() => null);
      const members = Object.fromEntries(product.options.map((option) => [option.id, membersOnOption(numbers, product.id, option.id)]));
      return Response.json({ ok: true, members });
    }
    // How many invitations to move here, not yet kept, name each option (642 [WG2], Revisor 1): said apart from
    // the members, read exactly (lib/move-members.ts, pendingInvitesOnOptions); unknown is null, never 0.
    if (action === "invited") {
      const product = await readProduct(guarded.store, id);
      if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
      const invited = await pendingInvitesOnOptions(guarded.store, product.id, product.options.map((option) => option.id));
      return Response.json({ ok: true, invited });
    }

    let result: OptionResult;
    // What the option includes arrives as one block of lines. Bounded here
    // before it reaches the store, which bounds it again as it saves.
    const details =
      typeof body.details === "string"
        ? body.details.slice(0, MAX_OPTION_DETAILS * (MAX_OPTION_DETAIL_LENGTH + 1))
        : undefined;
    const best = typeof body.best === "boolean" ? body.best : undefined;
    const sku = Object.hasOwn(body, "sku") ? body.sku : undefined;
    // What the Terms forbid is never a price's name or its lines (567 [GD1] (d), unit 3): an option is shown
    // wherever its product is, so it is refused as it is written, with the passage, why and the fix.
    if (action === "add" || action === "edit") {
      const refused = fastMoneyRefusal({ title: label, summary: details ?? "", about: "" });
      if (refused) return Response.json({ ok: false, error: "fast_money", passage: { ...refused, field: "option" } }, { status: 409 });
    }
    if (action === "add") {
      result = await addOption(ref, id, label, price, { details, best, sku });
    } else if (action === "edit") {
      result = await editOption(ref, id, label, price, { details, best, sku });
    } else if (action === "sale") {
      // Exactly a boolean: anything else could put an option on sale by mistake.
      if (typeof body.onSale !== "boolean") {
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      // Whether putting it back stops the payment plan is decided in the write, from the product as stored then
      // (Claude 5 on #2690): the studio's own copy may be stale. Only planPauseConfirmed exactly true lets it stop.
      const sale = await setOptionOnSaleChecked(ref, id, body.onSale, planPausedByRestore, body.planPauseConfirmed === true);
      if (!sale.ok) {
        return Response.json({ ok: false, error: sale.reason, limit: sale.limit }, { status: STATUS[sale.reason] ?? 400 });
      }
      // Nothing is removed by this action, so there is no file to delete.
      return Response.json({ ok: true, planStopped: sale.planStopped });
    } else if (action === "remove") {
      result = await removeOption(ref, id);
    } else {
      const direction = readOptionDirection(body);
      if (direction === null) {
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      result = await moveOption(ref, id, direction);
    }

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason, limit: result.limit },
        { status: STATUS[result.reason] ?? 400 },
      );
    }

    // Deliberately after the write, and best effort. A file left behind costs
    // a fraction of a cent; an option pointing at nothing costs a sale.
    for (const file of result.removed) {
      await del(file.pathname).catch((error: unknown) => {
        console.error("could not delete the file of a removed option", error);
      });
      await dropStamped(file);
    }

    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof StoreFullError) {
      return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    }
    console.error("changing a price option failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
