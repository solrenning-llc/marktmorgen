import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sealBackup, openBackup, type BackupSnapshot } from "@/lib/backup-codec";

/** What a backup is written to and read back from: create-only, no replace. lib/backup-store.ts is the R2 one. */
export type BackupObjectStore = {
 putNew: (id:string, bytes:Uint8Array)=>Promise<void>;
 read: (id:string, maxBytes:number)=>Promise<Uint8Array>;
};
/** One object the backup wrote, as the bucket lists it: its id and when the bucket says it was written, in ms. */
export type BackupListedObject = { id:string; writtenAt:number };
/** One page of the backup's own objects; `next` goes on from it, null on the last page. */
export type BackupListPage = { objects:BackupListedObject[]; next:string|null };
/**
 * The bucket the daily run uses (lib/backup-run.ts): the store, plus a listing of its own objects and a delete by id,
 * which only the run's retention calls (inbox C4-49), for copies past the review's retention. Every failure throws.
 */
export type BackupBucket = BackupObjectStore & {
 list: (next:string|null)=>Promise<BackupListPage>;
 delete: (id:string)=>Promise<void>;
};
export type VerifiedBackup = { id:string; keys:number; bytes:number };
export async function verifyBackupRoundtrip(snapshot:BackupSnapshot,key:Uint8Array,store:BackupObjectStore,maxBytes:number):Promise<VerifiedBackup>{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<34||maxBytes>4*1024*1024+65536)throw new Error("Invalid backup bound");
 const sealed=sealBackup(snapshot,key);
 if(sealed.length>maxBytes)throw new Error("Backup exceeds object bound");
 // Unique create-only identity; this round trip never deletes or overwrites (the run's retention is lib/backup-run.ts).
 // Failed verification leaves every previous verified object intact.
 const id=randomUUID();
 await store.putNew(id,sealed);
 const read=await store.read(id,maxBytes);
 if(read.byteLength>maxBytes)throw new Error("Backup read exceeds bound");
 const restored=openBackup(read,key);
 if(!isDeepStrictEqual(restored,snapshot))throw new Error("Backup read-back mismatch");
 return{id,keys:restored.rows.length,bytes:read.byteLength};
}
