globalThis.fetch=()=>{throw Error('External fetch denied before graph')};require('node:net').Socket.prototype.connect=()=>{throw Error('External socket denied before graph')};
