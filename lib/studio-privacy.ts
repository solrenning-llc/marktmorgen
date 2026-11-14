/**
 * What the studio's Privacy page (app/studio/privacy, 757 [STN4] unit 4) offers this person on this store.
 *
 * The page only gathers what already works. Each choice is decided exactly as the studio home decides
 * whether to draw the same control, so the page never offers a button the home would not draw:
 * - the store's data file: the home draws it while a plan or a free trial runs, to a role that may
 *   export; after a plan ends, only the closing notice of a store that is closing offers it;
 * - deleting this store: the home draws "Delete this store" only on an extra store, to the owner.
 */
import type { Standing } from "@/lib/plan-standing";
import { can, type Role } from "@/lib/team-roles";

export type PrivacyChoices = {
  /** "file": the download form; "after-plan": no plan or trial runs, so no form; "role": this role may not export. */
  data: "file" | "after-plan" | "role";
  /** "here": the store's own delete; "first": the account's first store, which has none; "role": not the owner's. */
  deleteStore: "here" | "first" | "role";
};

export function privacyChoices(input: { role: Role; standing: Standing; extra: boolean }): PrivacyChoices {
  const data = !can(input.role, "export") ? "role" : input.standing === "paid" || input.standing === "trial" ? "file" : "after-plan";
  const deleteStore = !can(input.role, "delete") ? "role" : input.extra ? "here" : "first";
  return { data, deleteStore };
}
