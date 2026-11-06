import {readFileSync} from "node:fs";
import {ownedRepositoryEnv,ownedRepositoryEvent} from "../../tooling/screen-reader/owned-repository.mjs";
/**
 * Added AX2 cases stay off for private, foreign or unknown repository visibility.
 * @param {Record<string, string | undefined>} [env] Only GitHub metadata is required; synthetic tests need no NODE_ENV.
 */
export function publicStandardAx2Run(env=process.env,readEvent=path=>JSON.parse(readFileSync(path,"utf8"))){
 if(!ownedRepositoryEnv(env)||!env.GITHUB_EVENT_PATH)return false;
 try{
  const repo=readEvent(env.GITHUB_EVENT_PATH)?.repository;
  return ownedRepositoryEvent(repo)&&repo.private===false&&repo.visibility==="public";
 }catch{return false;}
}
