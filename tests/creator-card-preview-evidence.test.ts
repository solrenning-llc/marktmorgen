/** Codex G2 on #1963 (preview), kept as a permanent test: the preview has no live links and no page heading of its own. */
/** Review control for the change from a public card to an inert studio preview. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CreatorCardView } from "@/components/creator-card-view";
import { CONTACT_WORDS } from "@/lib/buyer-words/contact";
import { is, done } from "./check";
const card = {on:true,name:"Synthetic card",title:"",email:"creator@example.com",phone:"",website:"https://example.com",note:""};
const props = {card,handle:"synthetic",storeName:"Synthetic",words:CONTACT_WORDS.en.card,preview:true};
const preview = renderToStaticMarkup(createElement(CreatorCardView, props));
const live = renderToStaticMarkup(createElement(CreatorCardView, {...props, preview:false}));
is("preview has no outgoing or download links", /href=/.test(preview), false);
is("preview uses an h3, not a page h1", [preview.includes("<h3"),preview.includes("<h1")], [true,false]);
is("public card keeps its links", live.includes("mailto:creator@example.com") && live.includes("/contact/vcard"), true);
is("public card keeps the page heading", live.includes("<h1"), true);
done();
