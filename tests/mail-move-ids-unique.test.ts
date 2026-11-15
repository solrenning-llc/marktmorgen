/**
 * Review of #3795: a sequence draws one MailBodyEditor per email step
 * (components/email-studio.tsx), all on one page. Move button ids fixed by
 * place ("mail-move-0-down") repeat across editors, so document.getElementById
 * finds the first editor's button and a move in step 2 sends the focus into
 * step 1, another email (WCAG 2.4.3). Each editor's ids carry its own useId().
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const src = readFileSync("components/mail-designer.tsx", "utf8");
is("no Move button id is fixed by place alone", /id=\{`mail-move-\$\{i\}/.test(src), false);
is("the editor names its Move buttons from its own useId()", /const moveIds = useId\(\);/.test(src) && src.includes("id={`${moveIds}-move-${i}-up`}") && src.includes("id={`${moveIds}-move-${i}-down`}"), true);
is("the focus looks for this editor's button", src.includes("document.getElementById(`${moveIds}-move-${to}-${by < 0 ? \"up\" : \"down\"}`)"), true);

done();
