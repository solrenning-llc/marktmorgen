"use client";

import Link from "next/link";
import type { Product } from "@/lib/store";
import { bundleOwnerProblem } from "@/lib/bundle-rules";
import { useStudioHref } from "@/components/studio-store-pin";

/**
 * In a product's row in the studio: for a bundle, what it holds and the way
 * to change that; for a product that could become one, the way to start.
 * The bundle itself is chosen on its own page (/studio/bundles), where the
 * store's products can be found by name however many there are.
 */
export function BundleToggle({ product }: { product: Product }) {
  const studioHref = useStudioHref();
  const href = studioHref(`/studio/bundles?product=${encodeURIComponent(product.id)}`);
  if (product.bundle) {
    const n = product.bundle.length;
    return (
      <div className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4">
        <p className="text-sm font-semibold text-ink">{`Bundle · ${n} ${n === 1 ? "product" : "products"}`}</p>
        <p className="mt-1 text-sm text-ink-soft">
          A buyer gets every product in it, each exactly as if they had bought it on its own: its download or link, its course and its license key.
        </p>
        <Link href={href} className="btn btn-primary btn-sm mt-3">
          Choose what is in it
        </Link>
      </div>
    );
  }
  if (bundleOwnerProblem(product) !== null) return null;
  return (
    <p className="mt-3">
      <Link href={href} className="inline-flex min-h-11 items-center text-left text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep">
        Sell this as a bundle of your products
      </Link>
    </p>
  );
}
