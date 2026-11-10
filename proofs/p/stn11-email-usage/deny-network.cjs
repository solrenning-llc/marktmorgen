const deny=()=>{throw Error('STN11 proof denies real network IO');};
globalThis.fetch=deny;
for(const name of ['http','https']){const m=require('node:'+name);m.request=deny;m.get=deny;}
for(const name of ['net','tls']){const m=require('node:'+name);m.connect=deny;if(m.createConnection)m.createConnection=deny;}
