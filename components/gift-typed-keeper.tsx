"use client";

import { useEffect, useRef } from "react";
import { GIFT_TYPED_FIELDS, giftTypedKey, packGiftTyped, unpackGiftTyped } from "@/lib/gift-typed";

/**
 * Drawn inside the gift form (components/store-product.tsx, GiftBox). Nothing
 * on screen; with scripts on it:
 *
 *   - keeps what was typed in the tab's own storage as the form is sent
 *     (lib/gift-typed.ts), so a refusal from the server never makes the buyer
 *     type it again (3.3.7);
 *   - when the page opens with that refusal (`problem`), puts it back into
 *     each field that is still empty (never over what was typed since), then
 *     removes it;
 *   - moves the focus to the field in error (`focusId`) or, when no field can
 *     fix it, to the reason (`reasonId`), so it is read at once; a refused
 *     consent box focuses itself (components/digital-consent-box.tsx);
 *   - unmarks the field in error (aria-invalid) once it is changed.
 *
 * With scripts off the fields come back empty, as before, but the field in
 * error is still marked and tied to its reason by the server's markup.
 */
export function GiftTypedKeeper({
  handle,
  productId,
  problem,
  focusId,
  reasonId,
}: {
  handle: string;
  productId: string;
  problem: string;
  focusId?: string;
  reasonId?: string;
}) {
  const mark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = mark.current?.closest("form");
    if (!form) return;
    const key = giftTypedKey(handle, productId);
    if (problem) {
      let raw: string | null = null;
      try {
        raw = window.sessionStorage.getItem(key);
        window.sessionStorage.removeItem(key);
      } catch {
        raw = null;
      }
      const kept = unpackGiftTyped(raw, Date.now());
      if (kept) {
        for (const name of GIFT_TYPED_FIELDS) {
          const field = form.elements.namedItem(name);
          const value = kept[name];
          if (!value) continue;
          if (field instanceof HTMLSelectElement) {
            const option = [...field.options].find((o) => o.value === value && !o.disabled);
            if (option && field.value === "") field.value = value;
          } else if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.value === "") {
            field.value = value;
            // So a component that follows its field (EmailField's "Did you mean …?") sees the value.
            field.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }
      const target = (focusId ? document.getElementById(focusId) : null) ?? (problem !== "consent" && reasonId ? document.getElementById(reasonId) : null);
      target?.focus();
    } else {
      // Nothing to answer: whatever an earlier send kept is not needed any more.
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        // Storage refused (private mode, blocked): nothing was kept either.
      }
    }
    const marked = focusId ? document.getElementById(focusId) : null;
    const unmark = () => marked?.removeAttribute("aria-invalid");
    marked?.addEventListener("input", unmark, { once: true });
    marked?.addEventListener("change", unmark, { once: true });
    const keep = (event: SubmitEvent) => {
      if (event.target !== form) return;
      const data = new FormData(form);
      const values: Record<string, string> = {};
      for (const name of GIFT_TYPED_FIELDS) {
        const value = data.get(name);
        if (typeof value === "string") values[name] = value;
      }
      try {
        window.sessionStorage.setItem(key, packGiftTyped(values, Date.now()));
      } catch {
        // Storage refused: the form is still sent; only the refill is lost.
      }
    };
    // Bubbling on the window, so a send held back first (EmailField's suggestion) keeps nothing.
    window.addEventListener("submit", keep);
    return () => {
      window.removeEventListener("submit", keep);
      marked?.removeEventListener("input", unmark);
      marked?.removeEventListener("change", unmark);
    };
  }, [handle, productId, problem, focusId, reasonId]);
  return <span ref={mark} hidden />;
}
