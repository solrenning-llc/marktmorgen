/**
 * Checking that what a product delivers still works: the reading (479 [SB2],
 * unit 2; added 10 November 2026). Unit 1 (lib/delivery-check-rules.ts) says
 * what a product hands over and what each answer means; this reads it.
 *
 *   - a file: its size, asked of the store that keeps it (the vault, or the
 *     host's own store for files from before it), as lib/file-store.ts tells
 *     the two apart, by the path. A store not set up, or one that did not
 *     answer, is not known: only a store that says the file is not there
 *     makes it "missing";
 *   - an address: one GET through lib/safe-fetch.ts, which refuses a private
 *     network, reads at most ADDRESS_READ_BYTES and waits at most
 *     ADDRESS_TIMEOUT_MS; any failure that is not one of its own reasons is
 *     "did not answer", never fine.
 *
 * Every thing is read at once, each given at most DELIVERY_ITEM_MS, so a check
 * ends in that time whatever answers; at most MAX_DELIVERY_ITEMS of a product
 * are read, and the rest are counted. Nothing is written: the answers go back
 * to the caller. Who pays is the caller's: the studio's route takes
 * DELIVERY_CHECK_UNITS studio requests before calling this
 * (app/api/store/delivery-check/route.ts).
 *
 * Next units: the check's line on each product in the studio, the check
 * before publishing and once a day after, and a domain let go told apart from
 * one that did not answer just now.
 */
import { BlobNotFoundError } from "@vercel/blob";
import * as blob from "@/lib/blob";
import { headVault, isVaultConfigured } from "@/lib/vault";
import { isVaultPath } from "@/lib/vault-rules";
import { SafeFetchError, type SafeFetchOptions, type SafeResponse, safeFetch } from "@/lib/safe-fetch";
import {
  ADDRESS_READ_BYTES,
  ADDRESS_REDIRECTS,
  ADDRESS_TIMEOUT_MS,
  type AddressAnswer,
  DELIVERY_ITEM_MS,
  type DeliveryItem,
  type DeliveryProduct,
  type DeliveryVerdict,
  MAX_DELIVERY_ITEMS,
  addressVerdict,
  deliveryItems,
  fileVerdict,
} from "@/lib/delivery-check-rules";

/** What storage said of a file: its size, "missing" when the store says it is not there, null when not known. */
export type FileSeen = { size: number } | "missing" | null;

/** How a check reads: one file by its path, one address. Each may throw; a throw is "not known". */
export type DeliveryReaders = {
  file: (pathname: string) => Promise<FileSeen>;
  address: (url: string) => Promise<AddressAnswer>;
};

export type CheckedItem = { what: string; verdict: DeliveryVerdict };

/** What one check found: a verdict for each thing read, in the product's order, and how many were left unread. */
export type DeliveryCheck = { items: CheckedItem[]; left: number };

type FileDeps = {
  vaultReady: () => boolean;
  vault: (pathname: string) => Promise<{ bytes: number; contentType: string } | null | "unreachable">;
  blob: (pathname: string) => Promise<{ size: number }>;
};

const sizeOf = (size: unknown): FileSeen => (typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? { size } : null);

/**
 * Reads a file's size from the store that keeps it. The vault's null means "not there" only once the vault is set
 * up (headVault answers null for both); its "unreachable" is not known. The host's store is gone only on its own
 * BlobNotFoundError; any other failure is not known.
 */
export function fileReader(deps: FileDeps = { vaultReady: isVaultConfigured, vault: headVault, blob: (pathname) => blob.head(pathname) }): DeliveryReaders["file"] {
  return async (pathname) => {
    if (isVaultPath(pathname)) {
      if (!deps.vaultReady()) return null;
      const found = await deps.vault(pathname);
      if (found === null) return "missing";
      if (found === "unreachable" || typeof found !== "object") return null;
      return sizeOf(found.bytes);
    }
    try {
      const found = await deps.blob(pathname);
      return sizeOf(found?.size);
    } catch (error) {
      if (error instanceof BlobNotFoundError) return "missing";
      return null;
    }
  };
}

type Fetcher = (url: string, options: SafeFetchOptions) => Promise<SafeResponse>;

/** Reads an address once: its status, or lib/safe-fetch.ts's reason; anything else did not answer. */
export function addressReader(fetcher: Fetcher = safeFetch): DeliveryReaders["address"] {
  return async (url) => {
    try {
      const answer = await fetcher(url, { method: "GET", maxBytes: ADDRESS_READ_BYTES, timeoutMs: ADDRESS_TIMEOUT_MS, maxRedirects: ADDRESS_REDIRECTS });
      return Number.isSafeInteger(answer?.status) ? { status: answer.status } : { problem: "network" };
    } catch (error) {
      // A page too long to read whole has still answered with its status, and that status is what counts: a long
      // 404 is gone, not fine (Codex C2 on #3623). A 3xx was not followed, so it says nothing of where it lands; and
      // a status that was lost stays unknown, never fine.
      if (error instanceof SafeFetchError && error.problem === "too_big" && Number.isSafeInteger(error.status) && (error.status! < 300 || error.status! >= 400)) return { status: error.status! };
      if (error instanceof SafeFetchError) return { problem: error.problem };
      return { problem: "network" };
    }
  };
}

/** The readers a check uses in production. */
export const storeReaders: DeliveryReaders = { file: fileReader(), address: addressReader() };

/** The value, or `late` once `ms` have passed; a throw is `late` too. The timer is cleared as soon as an answer comes. */
function within<T>(ms: number, work: () => Promise<T>, late: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(late), ms);
    let started: Promise<T>;
    try {
      started = work();
    } catch {
      started = Promise.resolve(late);
    }
    started.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(late);
      },
    );
  });
}

async function checkItem(item: DeliveryItem, readers: DeliveryReaders, ms: number): Promise<CheckedItem> {
  const target = item.target;
  if (target.kind === "file") {
    const seen = await within(ms, () => readers.file(target.pathname), null as FileSeen);
    return { what: item.what, verdict: fileVerdict(item.what, target.bytes, seen) };
  }
  const answer = await within(ms, () => readers.address(target.url), { problem: "timeout" } as AddressAnswer);
  return { what: item.what, verdict: addressVerdict(item.what, target.url, answer) };
}

/**
 * Reads what one product hands over and says what each answer means. At most MAX_DELIVERY_ITEMS things, in the
 * product's order, all at once, each given at most `itemMs`; the rest are counted in `left`.
 */
export async function checkDelivery(product: DeliveryProduct, readers: DeliveryReaders = storeReaders, now = Date.now(), itemMs = DELIVERY_ITEM_MS): Promise<DeliveryCheck> {
  const all = deliveryItems(product, now);
  const read = all.slice(0, MAX_DELIVERY_ITEMS);
  const items = await Promise.all(read.map((item) => checkItem(item, readers, Math.min(itemMs, DELIVERY_ITEM_MS))));
  return { items, left: all.length - read.length };
}
