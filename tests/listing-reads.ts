/**
 * How tests see a product record being read. lib/catalog.ts reads a store's product records
 * (nl:catalog:<id>:l:<product>) LISTINGS_PER_MGET at one MGET since 10 November 2026 (getMany; one GET a key
 * until then), while a few readers still read one with a GET of its own (readListingExactly). These match both,
 * so a test that fails, counts or rewrites one record's read keeps doing so whichever command carries it.
 */
type Command = readonly (string | number)[];

const LISTING = /^nl:catalog:.*:l:/;

/** The product-record keys a command reads (none for a command that is not a GET or an MGET of them). */
export function listingKeysRead(command: Command): string[] {
  if (command[0] !== "GET" && command[0] !== "MGET") return [];
  return command.slice(1).map(String).filter((key) => LISTING.test(key));
}

/** Whether a command reads this key, alone (GET) or among others (MGET). */
export function readsKey(command: Command, key: string): boolean {
  return (command[0] === "GET" || command[0] === "MGET") && command.slice(1).some((k) => String(k) === key);
}

/** The keys passing `test` that a command reads, alone (GET) or among others (MGET). */
export function keysReadWhere(command: Command, test: (key: string) => boolean): string[] {
  if (command[0] !== "GET" && command[0] !== "MGET") return [];
  return command.slice(1).map(String).filter(test);
}

/** Whether a command reads a key that passes `test`. */
export function readsKeyWhere(command: Command, test: (key: string) => boolean): boolean {
  return (command[0] === "GET" || command[0] === "MGET") && command.slice(1).some((k) => test(String(k)));
}

/**
 * The pipeline's answers with the value read at each key `rewrite` names replaced: a GET's own answer, or that
 * key's slot inside an MGET's list. `rewrite` answers undefined to keep a value as it is.
 */
export function rewriteKeys(commands: readonly Command[], answers: unknown[], rewrite: (key: string, value: unknown) => unknown): unknown[] {
  return commands.map((command, i) => {
    if (command[0] === "GET") {
      const changed = rewrite(String(command[1]), answers[i]);
      return changed === undefined ? answers[i] : changed;
    }
    if (command[0] === "MGET" && Array.isArray(answers[i])) {
      return (answers[i] as unknown[]).map((value, j) => {
        const changed = rewrite(String(command[j + 1]), value);
        return changed === undefined ? value : changed;
      });
    }
    return answers[i];
  });
}

/** The values a pipeline's GETs and MGETs of product records answered, with their keys. */
export function listingValues(commands: readonly Command[], answers: unknown[]): { key: string; value: unknown }[] {
  return commands.flatMap((command, i) => {
    if (command[0] === "GET") return LISTING.test(String(command[1])) ? [{ key: String(command[1]), value: answers[i] }] : [];
    if (command[0] === "MGET") {
      const values = Array.isArray(answers[i]) ? (answers[i] as unknown[]) : [];
      return command.slice(1).flatMap((key, j) => (LISTING.test(String(key)) ? [{ key: String(key), value: values[j] }] : []));
    }
    return [];
  });
}
