import test from "node:test";
import assert from "node:assert/strict";
import {OWNED_REPOSITORY_ID,ORIGINAL_REPOSITORY,ownedRepositoryEnv,ownedRepositoryEvent} from "./owned-repository.mjs";
test("the repository is ours by its permanent ID or by its original name",()=>{
 assert.equal(ownedRepositoryEnv({GITHUB_REPOSITORY:ORIGINAL_REPOSITORY}),true);
 assert.equal(ownedRepositoryEnv({GITHUB_REPOSITORY:"new-owner/marktmorgen",GITHUB_REPOSITORY_ID:OWNED_REPOSITORY_ID}),true);
 assert.equal(ownedRepositoryEvent({id:Number(OWNED_REPOSITORY_ID),full_name:"new-owner/marktmorgen"}),true);
 assert.equal(ownedRepositoryEvent({id:1,full_name:ORIGINAL_REPOSITORY}),true);
});
test("a fork, a copy or missing metadata is never ours",()=>{
 for(const env of [{},{GITHUB_REPOSITORY:"someone/marktmorgen"},{GITHUB_REPOSITORY:"someone/marktmorgen",GITHUB_REPOSITORY_ID:"1334793725"},
  {GITHUB_REPOSITORY_ID:" 1334793724"},{GITHUB_REPOSITORY_ID:"01334793724"}])assert.equal(ownedRepositoryEnv(env),false);
 for(const repository of [undefined,{},{id:1334793725,full_name:"someone/marktmorgen"},{id:"x",full_name:"someone/another"}])
  assert.equal(ownedRepositoryEvent(repository),false);
});
