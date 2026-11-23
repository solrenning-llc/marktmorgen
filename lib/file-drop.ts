/**
 * Deletes files nothing points at any more (a product's file replaced or taken off, a picture removed, a lesson file
 * dropped), after the record that let them go was saved. A delete that fails is not lost: the files go to the daily
 * job that deletes uploads nobody keeps (sweepTaskUploads, app/api/cron/courses), as a removed product's file and a
 * deleted person's files do (lib/person-erasure.ts). Otherwise nothing could ever delete them (the creator no longer
 * sees them) and they would count against the store's storage until it closes (outage drill, 14 November 2026).
 * Never throws: the change it follows is already saved.
 */
import { noteTaskUpload } from "@/lib/assignment";
import { deleteFile } from "@/lib/file-store";

export async function deleteOrSweep(paths: string | string[], what: string): Promise<void> {
  const all = (Array.isArray(paths) ? paths : [paths]).filter((path) => typeof path === "string" && path.length > 0);
  if (!all.length) return;
  try {
    await deleteFile(all);
  } catch (error) {
    console.error(`could not delete ${what}; it goes to the daily job`, error);
    for (const path of all) {
      await noteTaskUpload(path, 0).catch((noteError: unknown) =>
        console.error(`could not hand ${what} to the daily job; it is kept until the store closes`, noteError),
      );
    }
  }
}
