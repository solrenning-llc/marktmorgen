/** Real FormsEditor/React/Next router context. Only navigation observation is synthetic. */
import { createElement, useEffect } from "react";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { FormsEditor } from "@/components/forms-editor";

export type FormSaveObservation = { refresh: number; toasts: unknown[] };
declare global {
  interface Window { k2FormSaveObservation: FormSaveObservation; }
}

const router: AppRouterInstance = {
  bfcacheId: "synthetic-form-save",
  back() {},
  forward() {},
  refresh() { window.k2FormSaveObservation.refresh++; },
  push() {},
  replace() {},
  prefetch() {},
};

export function installFormSaveObservation() {
  window.k2FormSaveObservation = { refresh: 0, toasts: [] };
  window.addEventListener("nimbus:toast", event => {
    window.k2FormSaveObservation.toasts.push((event as CustomEvent<unknown>).detail);
  });
}

export function FormSaveAckProofRoot() {
  useEffect(() => { document.documentElement.dataset.fixtureReady = "yes"; }, []);
  return createElement(AppRouterContext.Provider, { value: router },
    createElement(FormsEditor, {
      saved: [], products: [], exportBase: "/api/store/forms/export?", sid: "synthetic-store",
    }));
}
