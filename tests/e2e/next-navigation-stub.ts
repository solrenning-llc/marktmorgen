/**
 * next/navigation for the browser harnesses in tests/e2e, which mount a studio component outside Next: a refresh is
 * counted on the page, never sent (tests/e2e/sales-lever-switch-harness.tsx).
 */
export function useRouter() {
  return {
    refresh() {
      const page = window as unknown as Window & { harness?: { refreshes?: number } };
      if (page.harness) page.harness.refreshes = (page.harness.refreshes ?? 0) + 1;
    },
  };
}
