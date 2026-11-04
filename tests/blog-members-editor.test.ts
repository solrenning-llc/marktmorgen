/**
 * The blog editor's "Who can read it" when the products' names cannot be read
 * (review of the blog unit of 28 [E11] + 100). The studio used to show every
 * product that opens a post as "A product no longer on your store", which
 * invited unchecking them all and so opening the post to everyone. Now a
 * failed read is said as such, and the checked products cannot be unchecked
 * until the names load.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { BlogEditor } from "@/components/blog-editor";
import { done, is, part } from "./check";

const ID = "a".repeat(10);
const draw = (openersKnown: boolean) =>
  renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: { push() {}, refresh() {}, prefetch() {} } as never },
      createElement(BlogEditor, {
        post: { id: "post000001", title: "Notes", body: "Words.", product: null, draft: false, href: "/@shop/blog/notes", products: [ID] },
        products: [],
        openers: [],
        openersKnown,
        back: "/studio/blog",
        look: {} as never,
      }),
    ),
  );

part("The products' names could not be read");
const failed = draw(false);
is("the editor says the names could not be loaded, and how to try again", [failed.includes("could not be loaded just now"), failed.includes("Reload the page")], [true, true]);
is("the checked product is not called gone", [failed.includes("A product no longer on your store"), failed.includes("A product whose name could not be loaded")], [false, true]);
const box = /<input type="checkbox"[^>]*>/.exec(failed.slice(failed.indexOf("Who can read it")))?.[0] ?? "";
is("and it cannot be unchecked", [box.includes("checked"), box.includes("disabled")], [true, true]);

part("The names were read and the product is gone");
const read = draw(true);
const readBox = /<input type="checkbox"[^>]*>/.exec(read.slice(read.indexOf("Who can read it")))?.[0] ?? "";
is("it is said to be gone, and can be unchecked", [read.includes("A product no longer on your store"), readBox.includes("disabled")], [true, false]);
done();
