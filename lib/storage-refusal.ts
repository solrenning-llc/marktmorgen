/**
 * The word an upload door sends when a file does not fit, read on the server.
 * A store without a plan is told to start one only while plans are on sale; the
 * studio's two sentences live in lib/studio-messages.ts, which never reads the
 * gates itself, so lib/opening.ts stays off the creator's browser.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { type Standing, storageRefusal } from "@/lib/plan-standing";

export type StorageRefusalWord = "storage_full" | "storage_trial" | "storage_setup" | "storage_setup_open";

export function storageRefusalWord(standing: Standing, plansOnSale: boolean = PLANS_ON_SALE): StorageRefusalWord {
  const word = storageRefusal(standing);
  return word === "storage_setup" && plansOnSale ? "storage_setup_open" : word;
}
