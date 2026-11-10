import { existsSync } from "node:fs";
import HelpPage from "../app/help/page";
import { done, is, part } from "./check";

type Element = { props: { href?: unknown; children?: unknown } };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function words(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(words).join(" ");
  return node && typeof node === "object" && "props" in node ? words((node as Element).props.children) : "";
}

part("People can reach safety guidance from the actual help page");
const links = elements(HelpPage()).filter(element => element.props.href === "/help/trust-and-safety");
is("help offers one direct link to safety guidance", links.length, 1);
is("its name identifies the destination without surrounding text", links.some(link => words(link).includes("Trust and safety")), true);
is("the destination is a real public page", existsSync("app/help/trust-and-safety/page.tsx"), true);
done();
