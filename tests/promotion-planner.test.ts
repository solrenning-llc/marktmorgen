import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromotionPlanner } from "@/components/promotion-planner";
import type { StatsData } from "@/lib/stats";
import { done, is, part } from "./check";
const row = { views: 100, sales: 1, cents: 12345, checkouts: 2 };
const data = { sales: "ok", partial: false, currency: "usd", days: [{date:"2026-10-16"}],
 products: [{id:"a",title:"A",d7:row,d30:row,d90:row}],
 channels:{d7:[{source:"x",visits:100,cents:12345,sales:1}],d30:[],d90:[]},
} as unknown as StatsData;
const products=[{id:"a",title:"<Product>",url:"https://shop.example/p/a?coupon=SAVE"}];
const html=(d=data,p=products)=>renderToStaticMarkup(createElement(PromotionPlanner,{data:d,range:"d7",products:p,campaignResults:true}));
part("The rendered planner uses public choices and communicates its limits");
is("empty eligible list does not render",html(data,[]),"");
is("product names are escaped",html().includes("&lt;Product&gt;"),true);
is("gross values are labeled",html().includes("$123.45")&&html().includes("gross revenue"),true);
is("every input has an explicit label",(html().match(/<label/g)??[]).length,6);
is("store channel is not claimed for product",html().includes("does not prove this product sold through that channel"),true);
is("no automatic post is promised",html().includes("Nothing is posted or sent for you"),true);
is("partial data does not expose money",html({...data,partial:true}).includes("$123.45"),false);
is("partial data uses page-view guidance",html({...data,partial:true}).includes("Products are ordered by page views"),true);
is("copy action present",html().includes("Copy campaign link"),true);
is("coupon is preserved",html().includes("coupon=SAVE"),true);
done();
