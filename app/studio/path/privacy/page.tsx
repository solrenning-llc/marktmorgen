import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { countStudio, studioPath, studioView } from "@/lib/studio-route";
import { readPath } from "@/lib/path";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { PathBoard } from "@/components/path-board";
export const metadata:Metadata={title:"Path board privacy — Marktmorgen",robots:{index:false,follow:false}};
export default async function PathBoardPrivacyPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const query=await searchParams;
  // Withdrawal uses the existing essential deletion allowance, never the exhausted monthly studio figure.
  const found=await studioView(await cookies(),typeof query.store==="string"?query.store:undefined,"delete",{count:false});
  if(!found.ok)redirect(found.reason==="signed_out"?"/signin":"/studio");
  const access=found.view;
  if(access.role!=="owner")redirect(studioPath(access.store,"team=forbidden"));
  if(!(await countStudio(access.store,"delete")).ok)redirect(studioPath(access.store,"","paused"));
  const reading=await readPath(access.store).then(record=>({record,failed:false})).catch(()=>({record:null,failed:true}));
  const board=reading.record?.board;
  return <div className="min-h-screen bg-paper text-ink">
    <StudioHeader current={access.store} role={access.role} stores={access.stores} owned={access.owned} action={{href:studioPath(access.store),label:"Back to the studio",short:"Studio"}}/>
    <StudioStorePin sid={access.store.sid}><main id="content" className="container-page break-words pb-20 pt-10">
      <StudioTrail store={access.store} path={[{ label: "Marktmorgen Path", href: studioPath(access.store, "", "path") }]} here="Privacy" />
      <h1 className="t-h2 mt-3">Path board privacy</h1>
      <p className="mt-3 text-ink-soft">Leaving the mission board preserves your private answers, check-in days and reached level. This page does not record a check-in or refresh sales.</p>
      <p className="mt-3"><a className="underline" href={`/api/store/path?store=${encodeURIComponent(access.store.sid)}`}>Download my private Path data</a></p>
      {reading.failed?<p className="notice mt-6" role="alert">Your participation could not be read. Please try again.</p>:<PathBoard key={board?.token || "not-joined"} joined={Boolean(board)} alias={board?"Creator "+board.token.slice(0,12):null} rows={null} privacyHref="" withdrawOnly/>}
    </main></StudioStorePin>
  </div>;
}
