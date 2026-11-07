import { creatorFrom, countStudio } from "@/lib/studio-route";
import { PATH_BOARD_JOIN_UNITS } from "@/lib/path-board-rules";
import {writePathWording} from "@/lib/path-wording";
import {currentWordingSource} from "@/lib/path-wording-source";
import {withinEssentialLimit} from "@/lib/request-guard";
import {AI_PER_MINUTE} from "@/lib/ai-rules";
import { sendPathReminder } from "@/lib/path-reminder";
import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { ensureStoreId, storeRef } from "@/lib/store";
import { readAnswers } from "@/lib/path-rules";
import { readPath, forgetPath, startPath, joinPathBoard, leavePathBoard } from "@/lib/path";

/**
 * Marktmorgen Path's answers (lib/path-rules.ts, lib/path.ts): the four
 * questions and the time zone, from the studio's path page. The owner's
 * alone: the path is about the person who runs the store, and what they
 * answer is theirs. One studio request (lib/studio-route.ts), and the
 * record's room taken in the store's data room before it is written.
 *
 *   POST { action: "start", answers: { goalCents, skills, subject, minutes, audience, timeZone } }
 *   POST { action: "forget" }   deletes the path: the answers, the days and the level kept
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, body => body.action === "board_leave" || body.action === "forget" ? "delete" : "settings", 2_000);
  if (!guarded.ok) return guarded.response;
  if (guarded.role !== "owner") return Response.json({ ok: false, error: "role" }, { status: 403 });
  const { body } = guarded;
  try {
    const store = guarded.store.sid ? guarded.store : await ensureStoreId(storeRef(guarded.store));
    if (!store?.sid) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    if(body.action==="wording"){
      if(!(await withinEssentialLimit("ai",store.sid,AI_PER_MINUTE,60)))return Response.json({ok:false,error:"slow"},{status:429,headers:{"Cache-Control":"no-store"}});
      const record=await readPath(store);
      const source=record?currentWordingSource(store,record):null;
      if(!source||body.mission!==source.mission)return Response.json({ok:false,error:"changed"},{status:409,headers:{"Cache-Control":"no-store"}});
      return Response.json(await writePathWording(store,source),{headers:{"Cache-Control":"no-store"}});
    }
    if(body.action==="board_join" || body.action==="board_leave") {
      if(body.action==="board_join") {
        if(body.consent!==true)return Response.json({ok:false,error:"consent"},{status:400});
        if(!(await countStudio(store,null,PATH_BOARD_JOIN_UNITS-1)).ok)return Response.json({ok:false,error:"allowance"},{status:429});
      }
      const result=body.action==="board_join"?await joinPathBoard(store):await leavePathBoard(store);
      return Response.json(result.ok?{ok:true}:{ok:false,error:result.reason},{status:result.ok?200:result.reason==="unavailable"?503:409,headers:{"Cache-Control":"no-store"}});
    }
    if (body.action === "remind") {
      const result = await sendPathReminder(store);
      return Response.json(result, {status: result.ok ? 200 : result.reason === "allowance" ? 429 : 409, headers: {"Cache-Control":"no-store"}});
    }
    if (body.action === "forget") {
      await forgetPath(store);
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action !== "start") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    const read = readAnswers(body.answers, store.currency);
    if (!read.ok) return Response.json({ ok: false, error: "invalid", message: read.message }, { status: 400 });
    const started = await startPath(store, read.answers);
    if (!started.ok) {
      return Response.json(
        { ok: false, error: started.reason, message: started.reason === "full" ? "Your store has no room to keep this right now. Nothing was changed." : started.reason === "conflict" ? "Your Path changed while saving. Reload and try again." : "This can't be saved right now. Try again in a minute." },
        { status: started.reason === "full" || started.reason === "conflict" ? 409 : 503 },
      );
    }
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("saving a store's path failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

/** The owner's private Path file uses the existing essential privacy allowance. */
export async function GET(request: NextRequest) {
  const creator=await creatorFrom(request,"delete");
  if(creator instanceof Response)return creator;
  if(creator.role!=="owner")return Response.json({ok:false,error:"role"},{status:403});
  try {
    const record=await readPath(creator.store);
    // The internal compare-and-swap revision is not part of the owner's data file.
    const data=record?{answers:record.answers,startedAt:record.startedAt,checkins:record.checkins,best:record.best,bestAt:record.bestAt,money:record.money,counts:record.counts,returnStep:record.returnStep??null,board:record.board??null}:null;
    return Response.json({path:data},{headers:{"Cache-Control":"private, no-store","Content-Disposition":'attachment; filename="marktmorgen-path.json"',"X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"}});
  } catch {
    return Response.json({ok:false,error:"unavailable"},{status:503,headers:{"Cache-Control":"no-store"}});
  }
}
