/**
 * 568 [GD2] (c), unit 2: the forms a funnel makes from a page, and the forms in
 * a funnel file another store shared, never ask what a scam asks for either
 * (lib/form-sensitive.ts): the funnel is not made, the file is not imported,
 * and the studio says why. Unit 1 (#1534) covered the form editor.
 *
 * What fails here: a route or the file reader without the check, or a studio
 * message without saying what was asked and that nothing was made.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("Funnels made from a page");
const route = readFileSync("app/api/store/page-funnels/route.ts", "utf8");
is("each typed form question is checked before anything is made", /readFunnelFormDrafts[\s\S]{0,400}sensitiveFieldOf\([\s\S]{0,200}error: "form_sensitive"/.test(route), true);
is("the picker says it", /form_sensitive:.*never may.*Nothing was made/.test(readFileSync("components/funnel-type-picker.tsx", "utf8")), true);

part("Funnel files shared by another store");
const bundle = readFileSync("lib/funnel-bundle.ts", "utf8");
is("a form in the file is checked as it is read", /tierIssues\(parsed\)\.length > 0[\s\S]{0,200}if \(sensitiveFieldOf\(parsed\)\) return \{ ok: false, error: "forms_sensitive" \};/.test(bundle), true);
is("the share panel says it", /bundle_forms_sensitive:.*never may.*Nothing was imported/.test(readFileSync("components/funnel-share-panel.tsx", "utf8")), true);
done();
