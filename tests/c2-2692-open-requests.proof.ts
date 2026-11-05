/** Opt-in SSR: an unknown email counter must not hide the independently confirmed request count. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PaymentRequestsStudio } from "@/components/payment-requests-studio";
import { done, is } from "./check";
const router: AppRouterInstance = { back(){}, forward(){}, refresh(){}, hmrRefresh(){}, push(){}, replace(){}, prefetch(){}, bfcacheId:"c2-synthetic" };
for(const used of [null,3]){
 const html=renderToStaticMarkup(createElement(AppRouterContext.Provider,{value:router},createElement(PaymentRequestsStudio,{rows:[],now:Date.now(),currency:"usd",canSend:true,open:true,closedWhy:"",limits:{open:100,kept:200},openNow:7,emails:{used,limit:500},shareWords:"Synthetic",taxOn:false,prefill:{email:"",name:"",text:"",amount:""},dueFirst:"2026-11-05",dueLast:"2027-11-05"})));
 is("confirmed request count survives email state "+String(used),html.includes("Open requests: 7 of 100."),true);
 is("unknown email state is explicit "+String(used),html.includes("Email use is unavailable right now."),used===null);
 is("unknown email state is never rendered as zero "+String(used),html.includes("0 of 500 used"),false);
}
done();
