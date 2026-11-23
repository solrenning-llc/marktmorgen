/**
 * The bulk resend's answer, read honestly on the screen (Claude 1 cloud's money MEDIUM on #3543, confirming C4).
 *
 * components/sales-bulk-actions.tsx turned any answer that was not JSON `{ ok: true }` into "That did not work.
 * Nothing was changed." with Confirm still on screen. The route sends the emails one by one under a 60-second
 * function limit, so a 504 page (or a dropped connection) can come after some emails went: the creator was told
 * nothing was sent and invited to press Confirm again, and those buyers got the email again, each one spending the
 * store's email figure. Now only the route's own exact refusal (JSON `ok: false` with an `error`, answered before
 * anything is sent) says nothing was sent and keeps Confirm; anything else says some may have gone, and Confirm is
 * gone until the creator asks again. The real component, mounted with tests/client-hooks.ts; fetch is stubbed.
 */
import { SalesBulkActions } from "@/components/sales-bulk-actions";
import type { BulkSaleRow } from "@/lib/sales-bulk-rules";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

const ref = (n: number) => `cs_test_${String(n).padStart(24, "a")}`;
const row = (n: number): BulkSaleRow => ({
  reference: ref(n),
  title: "Course",
  email: `buyer${n}@example.com`,
  paidAt: Date.UTC(2026, 10, 2, 15) / 1000,
  amount: 2700,
  currency: "usd",
  isCall: false,
  isTip: false,
  trial: false,
});

const json = (body: unknown, status: number) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html504 = async () => new Response("<html>An error occurred with your deployment. FUNCTION_INVOCATION_TIMEOUT</html>", { status: 504, headers: { "content-type": "text/html" } });
const dropped = async (): Promise<Response> => {
  throw new TypeError("Failed to fetch");
};

const all = (tree: unknown) => texts(tree).join(" ");
const button = (tree: unknown, label: string) => find(tree, (n) => n.type === "button" && texts(n.props?.children).includes(label))[0] as Node | undefined;

async function afterConfirm(answer: () => Promise<Response>) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return answer();
  }) as unknown as typeof fetch;
  const box = await mount(SalesBulkActions, { sales: [row(1), row(2)], canLabel: false, canExport: false, defaultOpen: true });
  const allBox = find(box.tree(), (n) => n.type === "input" && n.props?.type === "checkbox")[0];
  (allBox?.props?.onChange as () => void)();
  await box.settle();
  const form = find(box.tree(), (n) => n.type === "form")[0];
  await (form?.props?.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault() {} });
  await box.settle();
  const confirmBefore = Boolean(button(box.tree(), "Confirm"));
  await (button(box.tree(), "Confirm")?.props?.onClick as () => Promise<void> | void)();
  await box.settle();
  await box.settle();
  const tree = box.tree();
  box.unmount();
  return { confirmBefore, calls, text: all(tree), confirmAfter: Boolean(button(tree, "Confirm")) };
}

async function main(): Promise<void> {
  part("Control: the route's own exact refusal, before anything is sent");
  const refused = await afterConfirm(json({ ok: false, error: "exceeded", message: "This store sent its purchase emails again too often in the last hour. Nothing was sent. Try again later." }, 429));
  is("the confirmation was there to press", refused.confirmBefore, true);
  is("one request", refused.calls, 1);
  is("its own words are said", refused.text.includes("Nothing was sent. Try again later."), true);
  is("Confirm is kept: nothing went, so pressing again is safe", refused.confirmAfter, true);

  for (const [name, answer] of [
    ["a 504 page after the function ran out of time", html504],
    ["a JSON answer without ok", json({ sent: [ref(1)] }, 200)],
    ["a dropped connection", dropped],
  ] as [string, () => Promise<Response>][]) {
    part(`After Confirm, ${name}: some emails may have gone`);
    const seen = await afterConfirm(answer);
    is(`${name}: never "Nothing was changed"`, seen.text.includes("Nothing was changed"), false);
    is(`${name}: says some may have gone`, seen.text.includes("Some may have gone"), true);
    is(`${name}: no Confirm left to send them again`, seen.confirmAfter, false);
  }
}

main().then(done);
