/** next/og for the product card tests: keeps the element the card was drawn from, so its words can be read. */
const slot = globalThis as unknown as { __ogCard?: unknown };
export class ImageResponse extends Response {
  constructor(element: unknown) {
    super("png");
    slot.__ogCard = element;
  }
}
/** Every string inside a drawn element tree. */
export function wordsOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(wordsOf).join(" ");
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? wordsOf(props.children) : "";
}
export function lastCard(): unknown {
  return slot.__ogCard;
}
