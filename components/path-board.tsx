"use client";
import { useRef, useState, useSyncExternalStore } from "react";
import { readPathBoardReply } from "@/lib/path-board-response";
import type { PathBoardRow } from "@/lib/path-board-rules";

const subscribeReady=()=>()=>{};
const clientReady=()=>true;
const serverReady=()=>false;

export function PathBoard({joined,alias,rows,privacyHref,withdrawOnly=false}:{joined:boolean;alias:string|null;rows:PathBoardRow[]|null;privacyHref:string;withdrawOnly?:boolean}) {
  // SSR controls cannot act until their consent/single-flight handlers exist.
  const ready=useSyncExternalStore(subscribeReady,clientReady,serverReady);
  const locked=useRef(false);
  const [uncertain,setUncertain]=useState(false);
  const [consent,setConsent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  async function change(join:boolean) {
    if(!ready || locked.current || (join && !consent))return;
    locked.current=true;setBusy(true);setMessage("");
    try {
      const response=await fetch("/api/store/path",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:join?"board_join":"board_leave",...(join?{consent:true}:{})})});
      const result=readPathBoardReply(response.status,await response.json());
      if(result.state==="saved"){window.location.reload();return;}
      setMessage(result.message);
      if(result.state==="uncertain")setUncertain(true);
      else locked.current=false;
      setBusy(false);
    } catch {
      setMessage(readPathBoardReply(0,null).message);setUncertain(true);setBusy(false);
    }
  }
  return <section className="mt-8 rounded-2xl border border-line bg-white p-5" aria-labelledby="path-board-title" aria-busy={busy}>
    <h2 id="path-board-title" className="text-xl font-semibold">{withdrawOnly?"Board participation":"Mission board"}</h2>
    <p className="mt-3">Optional, ordered only by recorded missions. No sales amounts or levels are shared. Your real name, store address, answers and goal stay private.</p>
    {joined?<><p className="mt-3">You appear as <strong>{alias}</strong>.</p><button type="button" className="btn mt-3" disabled={!ready||busy||uncertain} onClick={()=>void change(false)}>Leave the mission board</button></>:withdrawOnly?<p className="mt-3">You are not on the mission board.</p>:<>
      <p className="mt-3 text-sm text-ink-soft">Joining uses four studio requests and about 2 KB of your data room, plus the small private record. Leaving stays available through privacy controls when your monthly studio allowance is used.</p>
      <label className="mt-4 flex min-h-11 items-start gap-3"><input type="checkbox" autoComplete="off" className="mt-1" checked={consent} onChange={event=>setConsent(event.target.checked)} disabled={!ready||busy||uncertain}/><span>Share my recorded mission count, a generated pseudonym and the reading time with other Path owners on the board.</span></label>
      <button type="button" className="btn mt-4" disabled={!ready||!consent||busy||uncertain} onClick={()=>void change(true)}>Join the mission board</button>
    </>}
    <p className="mt-3 text-sm" role="status" aria-live="polite">{message}</p>
    {!withdrawOnly?<a href={privacyHref} className="mt-3 inline-flex min-h-11 items-center underline">Manage board privacy</a>:null}
    {joined && !withdrawOnly?<><p className="mt-5 text-sm text-ink-soft">Up to 20 entries, from each owner&apos;s last verified Path reading. Counts update when that owner opens Path; later changes may not be reflected yet. Ties share a place.</p>
      {rows===null?<p className="notice mt-3" role="alert">The board could not be read. Your participation has not changed.</p>:rows.length?<div className="mt-3 overflow-x-auto"><table className="w-full table-fixed text-left text-sm"><caption className="sr-only">Recorded mission counts and their reading times</caption><thead><tr><th scope="col" className="w-12 p-2">Place</th><th scope="col" className="p-2">Creator</th><th scope="col" className="w-20 p-2">Missions</th><th scope="col" className="p-2">Last read (UTC)</th></tr></thead><tbody>{rows.map(row=><tr key={row.token} className="border-t border-line"><th scope="row" className="p-2">{row.rank}</th><td className="break-all p-2">{row.alias}{row.mine?" (you)":""}</td><td className="p-2">{row.score}</td><td className="break-all p-2 text-xs">{new Date(row.at).toISOString().replace("T"," ").replace(".000Z","")}</td></tr>)}</tbody></table></div>:<p className="mt-3">No entries could be shown from this reading.</p>}
    </>:null}
  </section>;
}
