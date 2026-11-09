/**
 * The notice of the gift, group-purchase and reminder boxes (components/store-product.tsx) is read by its own
 * key only: a query such as ?gift=constructor or ?remind=toString opens no alert (an empty role="alert" is
 * announced to a screen reader as an error with no words). A real key still shows its sentence.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GiftBox, GroupBox, RemindBox } from "@/components/store-product";
import type { Listing, Store } from "@/lib/store";
import { done, is, part } from "./check";

const store = { handle: "shop", name: "Shop", language: "en", currency: "usd" } as unknown as Store;
const product = { id: "abcdef1234", title: "Guide", priceCents: 2900, kind: 0, options: [] } as unknown as Listing;
const alert = (markup: string) => markup.includes('role="alert"');

part("A key that is not a notice");
for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
  is(`gift ${key}`, alert(renderToStaticMarkup(createElement(GiftBox, { store, product, problem: key }))), false);
  is(`group ${key}`, alert(renderToStaticMarkup(createElement(GroupBox, { store, product, problem: key }))), false);
  // An unknown key says the general error; a prototype name says the same, never an empty alert (rule 23: new assertion form).
  is(`remind ${key}`, renderToStaticMarkup(createElement(RemindBox, { store, product, asked: key })), renderToStaticMarkup(createElement(RemindBox, { store, product, asked: "zzz" })));
}

part("A real key");
is("gift option", alert(renderToStaticMarkup(createElement(GiftBox, { store, product, problem: "option" }))), true);
is("group people", alert(renderToStaticMarkup(createElement(GroupBox, { store, product, problem: "people" }))), true);
is("remind email", alert(renderToStaticMarkup(createElement(RemindBox, { store, product, asked: "email" }))), true);
done();
