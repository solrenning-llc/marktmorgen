/**
 * Who may do what in a store's studio, written once.
 *
 * A store has one owner — the account that made it — and up to five people
 * the owner invites (lib/team.ts). Each of them has one of three roles, and a
 * role is nothing but a list of the permissions below. Every studio route
 * names the one permission it needs and asks lib/studio-route.ts, which reads
 * this table and nothing else; the studio pages read the same table to leave
 * out what a role cannot use. So a role changes in one place, and the screen
 * and the server can never disagree about it.
 *
 * The lines drawn:
 *
 *   - Owner: everything. Only the owner pays for the store, connects the
 *     Stripe account its sales go into, manages the team and deletes the
 *     store — the four things that decide where money goes and who is let in.
 *   - Admin: everything else — the store's address, domain, pixels, tax,
 *     webhooks, discounts, affiliates and their payouts, sending email, the
 *     files of buyers' addresses and sales, and bringing contacts, products
 *     and past buyers over from another platform (lib/imports.ts), and
 *     deleting a person and everything kept about them (lib/person-erasure.ts).
 *   - Editor: the catalogue and the page — products, prices, files, courses,
 *     calls, offers after paying, sales pages, the store's name, look and
 *     links, the community's live events — plus moderating the community
 *     and the reviews, and writing email drafts. No sending to the list,
 *     nothing about payments, no files of buyers' data and no imports.
 *   - Support: reading orders and bookings, sending a buyer their purchase
 *     email again, and moderating the community and the reviews — which
 *     includes seeing who said they are coming to a live event, not
 *     scheduling one. Nothing that edits the store.
 *
 * Nothing in this file reads a secret or the environment, so the browser may
 * import it to decide what to draw.
 */

/** The four roles. The owner is not invited; the other three are. */
export type Role = "owner" | "admin" | "editor" | "support";
export type TeamRole = Exclude<Role, "owner">;
/** How long an invitation works, in days (lib/team.ts). */
export const INVITE_DAYS = 7;

export const TEAM_ROLES: TeamRole[] = ["admin", "editor", "support"];

export function parseTeamRole(raw: unknown): TeamRole | null {
  return raw === "admin" || raw === "editor" || raw === "support" ? raw : null;
}

/** What one studio action needs. */
export type Permission =
  /** The store's subscription: starting, changing and cancelling the plan. */
  | "billing"
  /** The creator's own Stripe account: connecting, finishing, forgetting it. */
  | "payments"
  /** Inviting, removing and changing the roles of people; the activity log. */
  | "team"
  /** Deleting the store itself. */
  | "delete"
  /** Address, domain, pixels, tax, reminders, webhooks, calendars, discounts, affiliates, community settings, email settings. */
  | "settings"
  /** The public page: name, description, look, photo, links. */
  | "page"
  /** Products and everything on them: prices, files, pictures, courses, calls, offers, keys. */
  | "products"
  /** Numbers: visits, sales totals, where visitors came from. No buyer's address. */
  | "stats"
  /** Orders and bookings with the buyer's address, and sending a purchase email again. */
  | "orders"
  /** Files that carry buyers' or affiliates' addresses: the list, sales, affiliates. */
  | "export"
  /** Reports, muting and taking members out of the community; reading who RSVP'd to its live events. */
  | "community"
  /** Scheduling, moving, cancelling the community's live events, and posting their replays. */
  | "events"
  /** Hiding and showing buyers' reviews, and answering them (lib/reviews.ts). */
  | "reviews"
  /** Writing and keeping email drafts, counting who they would reach, a test to yourself. */
  | "draft"
  /** Sending and scheduling email to the list, cancelling it, sequences, importing addresses. */
  | "send"
  /**
   * Moving from another platform (lib/imports.ts): a file of contacts onto the
   * list, of products into the store, of past buyers given what they bought.
   * Each writes a great deal at once, and the first and last say who may be
   * emailed and who owns what, so only the owner and admins have it.
   */
  | "import"
  /**
   * Deleting one person and everything the store keeps about them
   * (lib/person-erasure.ts): it cannot be undone, and it takes their
   * records out of every part of the store, so only the owner and admins.
   */
  | "erase";

const EVERYTHING: Permission[] = [
  "billing",
  "payments",
  "team",
  "delete",
  "settings",
  "page",
  "products",
  "stats",
  "orders",
  "export",
  "community",
  "events",
  "reviews",
  "draft",
  "send",
  "import",
  "erase",
];

/** The table itself. */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(EVERYTHING),
  admin: new Set<Permission>(["settings", "page", "products", "stats", "orders", "export", "community", "events", "reviews", "draft", "send", "import", "erase"]),
  editor: new Set<Permission>(["page", "products", "stats", "community", "events", "reviews", "draft"]),
  support: new Set<Permission>(["orders", "community", "reviews"]),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Whether a value is one of the permissions above, and not something a lookup found on an object's prototype. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (EVERYTHING as string[]).includes(value);
}

export const ROLE_NAMES: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  support: "Support",
};

/** One line each, shown where a role is chosen. */
export const ROLE_SUMMARIES: Record<TeamRole, string> = {
  admin: "Everything except the plan, the Stripe connection, the team and deleting the store.",
  editor: "Products, courses, sales pages, the store page, the community's live events, community and review moderation, and email drafts. Cannot send email, touch payments, import from another platform, download buyers' data or delete a person.",
  support: "Reads orders and bookings, sends purchase emails again, sees who is coming to live events, and moderates the community and reviews. Cannot edit the store or delete a person.",
};

/** The words an activity log line starts with, per permission. */
export const PERMISSION_WORDS: Record<Permission, string> = {
  billing: "Plan",
  payments: "Stripe connection",
  team: "Team",
  delete: "Store",
  settings: "Settings",
  page: "Store page",
  products: "Products",
  stats: "Numbers",
  orders: "Orders",
  export: "Download",
  community: "Community",
  events: "Live events",
  reviews: "Reviews",
  draft: "Email draft",
  import: "Import",
  send: "Email",
  erase: "People",
};
