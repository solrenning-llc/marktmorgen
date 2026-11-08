"use client";

import { createContext, useContext, type ReactNode } from "react";
import { LicenceKeyBox, type LicenceKeyWords } from "@/components/licence-key-box";
import type { BundleWords } from "@/components/bundle-delivery";

/**
 * What every bundle, license key and batch of older purchases on a buyer's
 * list shares, sent to the browser once for the whole list (C3-80, 4 November
 * 2026): before, each of up to 160 bundle buttons and 160 key boxes carried
 * its own copy of these words in the page's RSC payload. The store, the
 * link's token (already in every address of the list) and the words, in the
 * store's language (lib/buyer-words/orders.ts), with the store's name in.
 */
export type OrdersShared = {
  handle: string;
  token: string;
  storeName: string;
  language: string;
  words: {
    loading: string;
    failed: string;
    bundle: Omit<BundleWords, "missing">;
    key: Omit<LicenceKeyWords, "label">;
    check: string;
    checking: string;
    olderFailed: string;
  };
};

const Shared = createContext<OrdersShared | null>(null);

/** Gives the list's shared words and address to every bundle, key and batch drawn inside it. */
export function OrdersSharedProvider({ value, children }: { value: OrdersShared; children: ReactNode }) {
  return <Shared.Provider value={value}>{children}</Shared.Provider>;
}

/** The list's shared words and address; only inside OrdersSharedProvider. */
export function useOrdersShared(): OrdersShared {
  const shared = useContext(Shared);
  if (!shared) throw new Error("a part of the list of purchases is drawn outside OrdersSharedProvider");
  return shared;
}

/** The page's own address for the list, with what it is asked to show without JavaScript (app/[handle]/orders/page.tsx). */
export function listAddress(shared: Pick<OrdersShared, "handle" | "token">, ask: Record<string, string> = {}): string {
  return `/@${shared.handle}/orders?${new URLSearchParams({ token: shared.token, ...ask })}`;
}

/** A license key on the list, its box's words taken from the list once. */
export function OrdersKey({ title, label, value, revoked, waiting }: { title?: string; label: string; value: string | null; revoked: boolean; waiting: boolean }) {
  const { storeName, words } = useOrdersShared();
  return <LicenceKeyBox title={title} storeName={storeName} value={value} revoked={revoked} waiting={waiting} words={{ ...words.key, label }} />;
}
