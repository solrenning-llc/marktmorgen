/**
 * What the studio knows about one person and one store when it draws the
 * gallery "Add to your store", worked out on the server with no read (486
 * [IT3], unit 2): the search's tools (lib/studio-search.ts) and the box's
 * "Things to do" (lib/studio-search-actions.ts) both come from it, so the two
 * never disagree on what this role may open here.
 *
 * As app/studio/add draws the gallery, without the one read it makes for a
 * connected video call account: the module is shown when this store is
 * offered one, which opens the same screen. A role this file does not know
 * has no gallery and is offered nothing.
 */
import { idsOfKind } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { type Permission, type Role, ROLE_PERMISSIONS, can } from "@/lib/team-roles";
import { studioPath } from "@/lib/studio-route";
import type { GalleryContext } from "@/lib/studio-modules";
import { isDiscordConfigured } from "@/lib/discord";
import { configuredProviders, offeredProviders } from "@/lib/meet-providers";
import { sellsMemberships } from "@/lib/membership-manage";
import { PRO_ON_SALE, hasPro } from "@/lib/plan";
import { PLANS_ON_SALE } from "@/lib/opening";
import { isBillingConfigured } from "@/lib/billing";
import type { OfferedAction } from "@/lib/studio-search-actions";
import { offeredFor } from "@/lib/studio-actions-gallery";

/** The gallery's context for `role` on `store`; null for a role that is not one of the studio's. */
export function studioGalleryContext(store: Store, role: Role): GalleryContext | null {
  if (typeof role !== "string" || !Object.hasOwn(ROLE_PERMISSIONS, role)) return null;
  const may = (permission: Permission) => can(role, permission);
  return {
    may,
    has: {
      discord: isDiscordConfigured(),
      meet: configuredProviders().length > 0 && offeredProviders(store).length > 0,
      memberships: sellsMemberships(store),
      calls: idsOfKind(store, "call").length > 0,
      proOnSale: PRO_ON_SALE,
    },
    pro: store.subscriptionActive && hasPro(store.tier),
    planHref: isBillingConfigured() && may("billing") ? `${studioPath(store)}#billing` : null,
    billing: may("billing"),
    onSale: PLANS_ON_SALE,
  };
}

/** The actions `role` may open on `store`, each with its link on this store, for the search box to find in. */
export function offeredActions(store: Store, role: Role): OfferedAction[] {
  const ctx = studioGalleryContext(store, role);
  return ctx ? offeredFor(ctx, (segment) => studioPath(store, "", segment)) : [];
}
