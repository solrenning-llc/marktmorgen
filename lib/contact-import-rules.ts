/** Local work charged to the existing studio allowance before a pasted import. */
export const CONTACT_IMPORT_WORK = {
  chunkRows: 500,
  commandsPerRow: 8,
  commandsPerChunk: 64,
  fixedCommands: 16,
  bytesPerRow: 16384,
  bytesPerChunk: 65536,
  commandsPerStudioUnit: 20,
  bytesPerStudioUnit: 50000,
} as const;

export function pastedContactWork(rows: number): { commands: number; bytes: number; extraStudioUnits: number } {
  if (!Number.isSafeInteger(rows) || rows < 0) throw new Error("The contacts could not be counted. Try again.");
  if (rows === 0) return { commands: 0, bytes: 0, extraStudioUnits: 0 };
  const w = CONTACT_IMPORT_WORK;
  const chunks = Math.ceil(rows / w.chunkRows);
  const commands = w.fixedCommands + rows * w.commandsPerRow + chunks * w.commandsPerChunk;
  const bytes = rows * w.bytesPerRow + chunks * w.bytesPerChunk;
  if (!Number.isSafeInteger(commands) || !Number.isSafeInteger(bytes)) throw new Error("The contacts could not be counted. Try again.");
  // The route's guard already took one studio unit. Commands and transfer
  // each fit the complete total before contact reads or writes begin.
  const units = Math.max(Math.ceil(commands / w.commandsPerStudioUnit), Math.ceil(bytes / w.bytesPerStudioUnit));
  return { commands, bytes, extraStudioUnits: Math.max(0, units - 1) };
}
