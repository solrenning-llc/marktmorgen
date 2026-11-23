/**
 * Issue #3953 (Codex H2; accessibility, WCAG 2.2 4.1.3 Status Messages): the shared submit button for plain forms
 * (components/pending-submit.tsx), once pressed, shows a spinner and the words of what is happening and sets
 * aria-busy, but nothing announced it: a screen-reader user on a slow page heard nothing while the form was sent. Now
 * the button keeps, beside it, a polite status region, present and empty before the press (a region added with its
 * text is not reliably announced), which says the same words once the form is taken. Focus does not move, and the
 * form is still sent the browser's own way.
 *
 * Synthetic only: the component's own code, through tests/client-hooks.ts.
 */
import { PendingSubmit } from "@/components/pending-submit";
import { mount } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

function all(node: unknown, out: Node[] = []): Node[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((child) => all(child, out));
    return out;
  }
  const n = node as Node;
  out.push(n);
  all(n.props?.children, out);
  return out;
}

function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return text((node as Node).props?.children);
}

async function main(): Promise<void> {
  const view = await mount(PendingSubmit as (props: Parameters<typeof PendingSubmit>[0]) => unknown, { label: "Send me a link", pending: "Sending your link…", className: "button" });
  const status = () => all(view.tree()).filter((n) => n.props?.role === "status");
  const button = () => all(view.tree()).find((n) => n.type === "button")!;

  part("Before the press: the status region is there, empty, and polite");
  is("one status region", status().length, 1);
  is("polite", status()[0]?.props?.["aria-live"], "polite");
  is("empty", text(status()[0]), "");
  is("the button says what it does", text(button()), "Send me a link");

  part("Pressed, the form valid: the region says what is happening");
  let prevented = false;
  (button().props!.onClick as (event: unknown) => void)({
    preventDefault: () => {
      prevented = true;
    },
    currentTarget: { form: { noValidate: false, checkValidity: () => true }, formNoValidate: false },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await view.settle();
  is("the form is still sent the browser's own way", prevented, false);
  is("the region says it", text(status()[0]), "Sending your link…");
  is("the button is busy", button().props?.["aria-busy"], true);

  part("Pressed, a field missing: nothing is said, the button stays as it was");
  const again = await mount(PendingSubmit as (props: Parameters<typeof PendingSubmit>[0]) => unknown, { label: "Send", pending: "Sending…", className: "button" });
  const press = all(again.tree()).find((n) => n.type === "button")!;
  (press.props!.onClick as (event: unknown) => void)({ preventDefault: () => {}, currentTarget: { form: { noValidate: false, checkValidity: () => false }, formNoValidate: false } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await again.settle();
  is("nothing said", text(all(again.tree()).find((n) => n.props?.role === "status")), "");

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
