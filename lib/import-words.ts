/**
 * The words an import says about its rows, in the studio's import tool
 * (components/import-tool.tsx) and in the feature pages' pictures of it
 * (components/feature-visuals.tsx). Kept here, outside the tool's "use client"
 * module, so a server component reads the same words.
 */
import type { ImportKind, PreviewOutcome as Outcome } from "@/lib/imports";

/** The kinds and outcomes are the server's own (lib/imports.ts); only their types come here, so nothing of the server reaches a browser. */
export type { ImportKind, Outcome };

/** What every import says of the rows it left out and could not read, whatever its kind. */
export const IMPORT_LEFT_WORDS = { skipped: "left out", errors: "could not be read" } as const;

/** When an import ran, as "Your last imports" writes it, followed by " UTC". */
export const IMPORT_DATE = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** What a finished or running import says it did, by kind. */
export const IMPORT_WORDS: Record<ImportKind, { added: string; already: string; noun: string }> = {
  contacts: { added: "added to your list", already: "already on it", noun: "contacts" },
  products: { added: "made as drafts", already: "already there", noun: "products" },
  purchases: { added: "given to buyers", already: "already had it", noun: "rows" },
  members: { added: "invited to move", already: "already invited", noun: "members" },
};

/** What a dry run says each row will become, by kind; members have no dry run. */
export const OUTCOME_WORDS: Record<Exclude<ImportKind, "members">, Partial<Record<Outcome, string>>> = {
  contacts: {
    added: "can be emailed",
    contact: "contacts you cannot email",
    already: "already on your list",
    stopped: "no longer emailed",
    left: "unsubscribed here, left alone",
    skipped: "left out",
    error: "cannot be read",
  },
  products: { added: "made as drafts", already: "already in your store", skipped: "left out", error: "cannot be read" },
  purchases: { added: "given what they bought", skipped: "left out", error: "cannot be read" },
};
