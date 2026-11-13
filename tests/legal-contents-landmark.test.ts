/**
 * AX274 (WCAG 2.2 1.3.1, 2.4.1 and 3.2.3 Consistent Navigation): the legal pages' "On this page" index is a named
 * navigation region on a wide screen, but on a phone it was a fold (details) outside any region, so moving by
 * landmark on a phone never found it. The phone's fold now sits in a navigation region named the same way. Only
 * one of the two is shown at a time (the other is display:none), so a reader meets one. No legal text changes.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const source = readFileSync("components/legal-page.tsx", "utf8");

part("The index is a navigation region at every width");
is("wide screens: named by its heading", /<nav\s+aria-labelledby="legal-contents"/.test(source), true);
is("phones: the fold sits in a region named the same", /<nav aria-label="On this page" className="lg:hidden">\s*<details className="group card-flat px-5 py-4">/.test(source), true);
is("the phone's region is hidden where the wide one shows", /<details className="group card-flat px-5 py-4 lg:hidden">/.test(source), false);

done();
