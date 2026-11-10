"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AUDIENCES, AUDIENCE_WORDS, MINUTES, type PathAnswers } from "@/lib/path-rules";
import { readMoney, parseCurrency, moneyField, decimalsOf } from "@/lib/money";
import { readPathWriteReply } from "@/lib/path-write-response";
import { useLeaveGuard } from "@/components/leave-guard";
import { ConfirmAction } from "@/components/confirm-action";
/** Asked before the Path is deleted: what goes and what stays. */
export const FORGET_PATH_QUESTION = "Delete your Path answers, check-in days and saved level? Your store and orders stay as they are.";

export function PathOnboarding({currency, answers}: {currency: string; answers?: PathAnswers}) {
 const [busy,setBusy]=useState(false);
 const goalId=useId();
 const goalField=useRef<HTMLInputElement>(null);
 const [goalError,setGoalError]=useState("");
 const [dirty,setDirty]=useState(false);
 const [acknowledged,setAcknowledged]=useState(false);
 useLeaveGuard(dirty&&!acknowledged);
 // The leave guard cleans up before this effect reloads an acknowledged write.
 useEffect(()=>{if(acknowledged)window.location.reload();},[acknowledged]);
 const [uncertain,setUncertain]=useState(false);
 const locked=useRef(false);
 const [message,setMessage]=useState("");
 async function request(body: unknown) {
  if(locked.current)return;
  locked.current=true;setBusy(true);setMessage("");
  try {
   const response=await fetch("/api/store/path",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
   const result=readPathWriteReply(response.status,await response.json());
   if(result.state==="saved"){setAcknowledged(true);return;}
   setMessage(result.message);
   if(result.state==="uncertain")setUncertain(true);
   else locked.current=false;
   setBusy(false);
  } catch {
   setMessage(readPathWriteReply(0,null).message);setUncertain(true);setBusy(false);
  }
 }
 function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();if(locked.current)return;
  const form=new FormData(event.currentTarget);
  const goalCents=readMoney(String(form.get("goal") || "0"),parseCurrency(currency));
  if(goalCents===null){setMessage("");setGoalError("Please enter a plain amount in your store's currency.");goalField.current?.focus();return;}
  void request({action:"start",answers:{goalCents,skills:form.get("skills"),subject:form.get("subject"),minutes:Number(form.get("minutes")),audience:form.get("audience"),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}});
 }
 return <form onChange={event=>{setDirty(true);if(event.target instanceof HTMLInputElement&&event.target.name==="goal")setGoalError("");}} onSubmit={submit} aria-label={answers?"Your Path answers":"Start your Path"} aria-busy={busy} className="mt-6 grid max-w-xl gap-5">
  <div className="grid gap-2">
   <label htmlFor={goalId} className="font-semibold">1. What is your personal monthly goal?</label>
   <p id={goalId+"-help"} className="text-sm text-ink-soft">Optional, in {currency.toUpperCase()}. Your own goal, without a forecast.</p>
   <input id={goalId} ref={goalField} className="field" disabled={busy} name="goal" type="number" inputMode={decimalsOf(currency)===0?"numeric":"decimal"} min="0" step={decimalsOf(currency)===0?"1":"0.01"} aria-invalid={goalError?true:undefined} aria-describedby={goalId+"-help"+(goalError?" "+goalId+"-error":"")} defaultValue={answers?.goalCurrency===currency?moneyField(answers.goalCents,currency):"0"}/>
   {goalError?<p id={goalId+"-error"} role="alert" className="text-sm text-danger-text">{goalError}</p>:null}
  </div>
  <fieldset className="grid gap-3"><legend className="font-semibold">2. What could you help someone with?</legend>
   <label className="grid gap-2">Your skills<input className="field" disabled={busy} name="skills" maxLength={120} required defaultValue={answers?.skills}/></label>
   <label className="grid gap-2">Your subject<input className="field" disabled={busy} name="subject" maxLength={80} required defaultValue={answers?.subject}/></label>
  </fieldset>
  <label className="grid gap-2 font-semibold">3. How much time would you like to set aside each day?
   <select className="field" disabled={busy} name="minutes" defaultValue={answers?.minutes || 15}>{MINUTES.map(n=><option key={n} value={n}>{n} minutes</option>)}</select>
  </label>
  <label className="grid gap-2 font-semibold">4. Where do people already hear from you?
   <select className="field" disabled={busy} name="audience" defaultValue={answers?.audience || "none"}>{AUDIENCES.map(a=><option key={a} value={a}>{AUDIENCE_WORDS[a]}</option>)}</select>
  </label>
  <p className="text-sm text-ink-soft">Your browser&apos;s time zone sets your check-in days. Sundays and two rest days each week are yours.</p>
  <div className="flex flex-wrap gap-3"><button disabled={busy||uncertain} className="btn btn-primary">{busy?"Saving…":answers?"Save your answers":"Start your Path"}</button>
   {/* Asked on the page, never in a browser dialog (485 [IT2]): it cannot be undone, so it keeps its question. */}
   {answers?<ConfirmAction className="btn btn-secondary" disabled={busy||uncertain} busy={busy} question={FORGET_PATH_QUESTION} yes="Yes, delete my Path" onConfirm={()=>locked.current?undefined:request({action:"forget"})}>Delete your Path</ConfirmAction>:null}</div>
  {message?<p role="alert" className="notice notice-error">{message}</p>:null}
 </form>;
}
