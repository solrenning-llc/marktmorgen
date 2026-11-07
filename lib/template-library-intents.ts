/** Serialized unsaved library intents; no delivery, saving or activation. */
export type LibraryEmailDraft={label:string;subject:string;body:string;preview?:string};
export type LibrarySequenceDraft={name:string;trigger:"joined"|"bought";steps:{id:string;delayHours:number;subject:string;body:string}[]};
