/**
 * Buyers' email addresses are orders data (ALL-160): a studio role sees them
 * only with the "orders" permission (lib/team-roles.ts). A role without it,
 * such as an Editor, still works on the product or course, and is told in
 * plain words why the addresses are not shown.
 *
 * Nothing here reads a secret or the environment, so the browser may import it.
 */
import { can, type Role } from "@/lib/team-roles";

/** The line shown where the addresses would be. */
export const NO_BUYER_ADDRESSES = "You need the Orders permission to see buyers' email addresses.";

/** Whether this role may read buyers' email addresses. */
export function seesBuyerAddresses(role: Role): boolean {
  return can(role, "orders");
}

/** The same rows, each address emptied, unless the role may read them. */
export function withoutAddresses<T extends { email: string }>(rows: T[], role: Role): T[] {
  return seesBuyerAddresses(role) ? rows : rows.map((row) => ({ ...row, email: "" }));
}
