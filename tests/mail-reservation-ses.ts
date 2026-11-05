export * from '../lib/ses';
export const sesObservation={configured:true,room:100000};
export const isSesConfigured=()=>sesObservation.configured;
export const sesReady=async()=>sesObservation.configured?{ready:true,why:'',max24:100000,rate:100,hold:0,at:Math.floor(Date.now()/1000)}:null;
export const sesBulkRoom=async()=>sesObservation.room;
