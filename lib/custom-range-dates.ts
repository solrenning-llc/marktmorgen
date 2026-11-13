export type CustomDatePeriod={from:string;to:string};
const DAY=86400000;
const day=(value:string):number|null=>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
 const at=Date.parse(value+"T00:00:00Z");
 return Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===value?at:null;
};
/** A period only when both ends are real days: before 0000-01-01, toISOString() writes "-000001-12-31" (input fuzz, Claude 7). */
const real=(from:string,to:string):CustomDatePeriod|null=>day(from)!==null&&day(to)!==null?{from,to}:null;
/** Shift an inclusive UTC period without clipping its duration or crossing retained dates. */
export function adjacentCustomRange(period:CustomDatePeriod,direction:-1|1,today:string):CustomDatePeriod|null {
 const start=day(period.from),end=day(period.to),current=day(today);
 if(start===null||end===null||current===null||start>end||(direction!==-1&&direction!==1))return null;
 const earliest=current-399*DAY;
 if(start<earliest||end>current)return null;
 const shift=(end-start+DAY)*direction;
 const from=start+shift,to=end+shift;
 if(from<earliest||to>current)return null;
 return real(new Date(from).toISOString().slice(0,10),new Date(to).toISOString().slice(0,10));
}

export const CUSTOM_RANGE_PRESETS = [
 {value:"yesterday",label:"Yesterday"},
 {value:"7d",label:"Last 7 days"},
 {value:"30d",label:"Last 30 days"},
 {value:"90d",label:"Last 90 days"},
 {value:"month",label:"This month"},
 {value:"last-month",label:"Last month"},
 {value:"7d-closed",label:"Last 7 completed days"},
 {value:"30d-closed",label:"Last 30 completed days"},
 {value:"90d-closed",label:"Last 90 completed days"},
] as const;
export type CustomRangePreset = typeof CUSTOM_RANGE_PRESETS[number]["value"];
/** Relative dates use UTC; closed shortcuts end before today, independently of paid coverage. */
export function presetCustomRange(preset:CustomRangePreset,today:string):CustomDatePeriod|null {
 const current=day(today);
 if(current===null)return null;
 if(preset==="yesterday"){const date=new Date(current-DAY).toISOString().slice(0,10);return real(date,date);}
 if(preset==="last-month"){
  const end=new Date(Date.parse(today.slice(0,8)+"01T00:00:00Z")-DAY).toISOString().slice(0,10);
  return real(end.slice(0,8)+"01",end);
 }
 if(preset==="month")return real(today.slice(0,8)+"01",today);
 const completedDays=preset==="7d-closed"?7:preset==="30d-closed"?30:preset==="90d-closed"?90:null;
 if(completedDays!==null)return real(new Date(current-completedDays*DAY).toISOString().slice(0,10),new Date(current-DAY).toISOString().slice(0,10));
 const days=preset==="7d"?7:preset==="30d"?30:preset==="90d"?90:null;
 if(days===null)return null;
 return real(new Date(current-(days-1)*DAY).toISOString().slice(0,10),today);
}
