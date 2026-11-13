import { presetCustomRange, type CustomRangePreset } from "@/lib/custom-range-dates";
import { CustomRangePresets } from "@/components/custom-range";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { done, is, part } from "./check";
const DAY=86400000;
const presets=[["7d-closed",7],["30d-closed",30],["90d-closed",90]] as const;
part("Completed rolling periods have the requested UTC length");
for(const today of ["2026-10-15","2026-01-01","2024-03-01","2025-03-01","2026-11-02"]){
 for(const [preset,days] of presets){
  const range=presetCustomRange(preset,today)!;
  is(preset+" ends yesterday on "+today,range.to,new Date(Date.parse(today+"T00:00:00Z")-DAY).toISOString().slice(0,10));
  is(preset+" inclusive duration on "+today,(Date.parse(range.to+"T00:00:00Z")-Date.parse(range.from+"T00:00:00Z"))/DAY+1,days);
  is(preset+" starts exactly N days before anchor",range.from,new Date(Date.parse(today+"T00:00:00Z")-days*DAY).toISOString().slice(0,10));
 }
}
part("Invalid anchors remain unavailable");
for(const [preset] of presets){
 for(const today of ["2026-02-30","bad","2026-13-01"]){is(preset+" rejects "+today,presetCustomRange(preset,today),null);}
}
part("Existing rolling shortcuts still include today");
for(const [preset,days] of [["7d",7],["30d",30],["90d",90]] as const){
 const open=presetCustomRange(preset,"2026-10-15")!,closed=presetCustomRange((preset+"-closed") as CustomRangePreset,"2026-10-15")!;
 is(preset+" keeps today",open.to,"2026-10-15");
 is(preset+" completed window moves start back one day",Date.parse(open.from)-Date.parse(closed.from),DAY);
 is(preset+" keeps duration",(Date.parse(open.to)-Date.parse(open.from))/DAY+1,days);
}
const render=(busy=false)=>renderToStaticMarkup(createElement(CustomRangePresets,{today:"2026-10-15",busy,onSelect:()=>{}}));
const html=render();
for(const days of [7,30,90])is("completed shortcut label "+days,html.includes("Last "+days+" completed days"),true);
is("completed UTC policy visible",html.includes("completed-day shortcuts exclude today and use completed UTC dates"),true);
is("all nine controls disabled during a reading",(render(true).match(/aria-disabled="true"/g)??[]).length,9);
is("all controls remain non-submitting",(html.match(/type="button"/g)??[]).length,9);
done();
