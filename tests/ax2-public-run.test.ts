import {publicStandardAx2Run} from "./e2e/ax2-public-run.mjs";
import {is,done,part} from "./check";
part("Additional AX2 cases require explicit canonical public visibility");
const env={GITHUB_REPOSITORY:"viniciussucupira/marktmorgen",GITHUB_EVENT_PATH:"synthetic-event.json"};
const repository={full_name:"viniciussucupira/marktmorgen",private:false,visibility:"public"};
is("allow verified canonical public metadata",publicStandardAx2Run(env,()=>({repository})),true);
for(const [name,repo] of [
 ["private",{...repository,private:true,visibility:"private"}],
 ["unknown private flag",{...repository,private:undefined}],
 ["unknown visibility",{...repository,visibility:undefined}],
 ["foreign repository",{...repository,full_name:"someone/another"}],
 ["contradictory visibility",{...repository,visibility:"private"}],
 ["missing repository",undefined],
] as const)is("disable "+name,publicStandardAx2Run(env,()=>({repository:repo})),false);
is("allow the same repository after a move to another owner, by its ID",publicStandardAx2Run({GITHUB_REPOSITORY:"new-owner/marktmorgen",GITHUB_REPOSITORY_ID:"1334793724",GITHUB_EVENT_PATH:"synthetic-event.json"},()=>({repository:{id:1334793724,full_name:"new-owner/marktmorgen",private:false,visibility:"public"}})),true);
is("disable a copy under another owner with another ID",publicStandardAx2Run({GITHUB_REPOSITORY:"new-owner/marktmorgen",GITHUB_REPOSITORY_ID:"99",GITHUB_EVENT_PATH:"synthetic-event.json"},()=>({repository:{id:99,full_name:"new-owner/marktmorgen",private:false,visibility:"public"}})),false);
is("disable unknown environment",publicStandardAx2Run({},()=>({repository})),false);
is("disable foreign environment",publicStandardAx2Run({...env,GITHUB_REPOSITORY:"someone/another"},()=>({repository})),false);
is("disable missing event path",publicStandardAx2Run({GITHUB_REPOSITORY:env.GITHUB_REPOSITORY},()=>({repository})),false);
is("disable unreadable event",publicStandardAx2Run(env,()=>{throw Error("unavailable");}),false);
done();
