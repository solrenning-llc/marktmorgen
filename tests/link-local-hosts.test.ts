/**
 * A creator's link never points a visitor at an address that only exists on the visitor's own machine
 * (lib/product-link.ts readLink, lib/sales-page.ts quoteUrl, lib/product-about.ts linkPieces):
 *   - a name with a final dot is the same name (https://localhost./, https://router.localhost./);
 *   - the link in running text is https only, like every other link the creator types, and no local name.
 * A real address still links, and the text shown is still exactly where the link goes.
 */
import { hostIsLocal, readLink } from "@/lib/product-link";
import { quoteUrl } from "@/lib/sales-page";
import { linkPieces } from "@/lib/product-about";
import { done, is, part } from "./check";

part("A final dot is the same name");
for (const url of ["https://localhost./admin", "https://router.localhost./", "https://localhost../", "https://LOCALHOST./"]) {
  is(`readLink refuses ${url}`, readLink(url).ok, false);
  is(`quoteUrl refuses ${url}`, quoteUrl(url), "");
}
is("hostIsLocal reads the name without its final dot", ["localhost.", "a.localhost.", "localhost", "example.com", "example.com."].map(hostIsLocal), [true, true, true, false, false]);
is("a real address with a final dot still passes", [readLink("https://example.com./a").ok, quoteUrl("https://example.com./a") !== ""], [true, true]);

part("Running text");
const linked = (line: string) => linkPieces(line).filter((p) => p.href).map((p) => p.href);
is("http is not linked", linked("see http://example.com/x"), []);
is("a local name is not linked", linked("see https://localhost:3000/x and https://router.localhost./y"), []);
is("https is linked, as typed", linked("see https://example.com/x."), ["https://example.com/x"]);
is("the shown text is where it goes", linkPieces("go https://example.com/x now").map((p) => p.href ?? p.text), ["go ", "https://example.com/x", " now"]);
done();
