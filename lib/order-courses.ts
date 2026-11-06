/**
 * The courses one paid order hands over (513 [PF1], unit 2a; added 2 November
 * 2026): the product bought, the products added to it (a box ticked at
 * checkout, or a cart's other products, lib/cart-checkout.ts), and the
 * products of a bundle among them, each as if bought on its own.
 *
 * A box at checkout never offers a course on its own (lib/product-extras.ts,
 * bumpTargetPause: it needs a file, a link or a bundle), but a cart takes one
 * anywhere in it (lib/cart-rules.ts, cartable). Until this was written, a
 * course that was not a cart's first product opened from no button: the
 * course itself was open to its buyer (lib/bundle-rules.ts, deliveredIds), but
 * the thanks page said nothing was attached and the buyer's list of purchases
 * left it out. The thanks page, its "Start the course" route and the list of
 * purchases read it from here.
 *
 * Pure: it reads only the order as read.
 */
import type { Listing } from "@/lib/store";

type WithCourse = Pick<Listing, "id" | "course">;
type Contents<P> = { items: P[] } | null;

/** What an order carries, as lib/store-checkout.ts readOrder reads a paid one. */
export type OrderWithCourses<P extends WithCourse = WithCourse> = {
  product: P;
  items: Contents<P>;
  bumps: { product: P; items: Contents<P> }[];
};

/** Every course the order hands over, once each: the product bought, each one added, then the products of each bundle, in that order. */
export function orderCourses<P extends WithCourse>(order: OrderWithCourses<P>): P[] {
  const all = [
    order.product,
    ...order.bumps.map((added) => added.product),
    ...(order.items?.items ?? []),
    ...order.bumps.flatMap((added) => added.items?.items ?? []),
  ];
  return all.filter((product, i) => product.course && all.findIndex((other) => other.id === product.id) === i);
}

/**
 * The course a "Start the course" press opens: the one named, when the order
 * hands it over, else the product bought when it is a course, else none.
 */
export function courseToStart<P extends WithCourse>(order: OrderWithCourses<P>, asked: string): P | null {
  const named = asked ? orderCourses(order).find((product) => product.id === asked) ?? null : null;
  return named ?? (order.product.course ? order.product : null);
}
