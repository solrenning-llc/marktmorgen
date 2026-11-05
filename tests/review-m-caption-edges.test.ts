import {toVtt} from '@/lib/captions';
let count=0,fail=0;function check(name:string,got:unknown,want:unknown){count++;if(JSON.stringify(got)!==JSON.stringify(want)){fail++;console.log('FAIL',name,got,want);}}
const cue='00:00:01.000 --> 00:00:02.000\nWords.';
const expected={ok:true,vtt:'WEBVTT\n\n'+cue+'\n',cues:1};
for(const newline of ['\n','\r\n','\r'])for(const marker of ['NOTE','NOTE explanation','NOTE\tmetadata','STYLE','STYLE \t','REGION','REGION\t ']){
 const metadata=marker.startsWith('STYLE')?marker+'\n::cue { color: red }':marker.startsWith('REGION')?marker+'\nid:one':marker+'\nmetadata';
 check('recognized metadata/newline',toVtt(('\ufeffWEBVTT\nKind: captions\nLanguage: en\n\n'+metadata+'\n\n'+cue+'\n').replaceAll('\n',newline)),expected);
}
for(const bad of ['Speech without timing','2\n00:03.000 -> 00:04.000\nLost words','2\n00:03.000 00:04.000\nLost words','NOTES\nLost words','STYLES\nLost words','REGIONS\nLost words','WEBVTT2\nLost words'])for(const where of ['before','after']){
 const blocks=where==='before'?[bad,cue]:[cue,bad];check('unknown block refused '+bad+' '+where,toVtt('WEBVTT\n\n'+blocks.join('\n\n')),{ok:false,reason:'format'});
}
for(const position of ['beginning','middle','end']){
 const rows=position==='beginning'?['This --> that.','Good.']:position==='middle'?['Good.','This --> that.','More.']:['Good.','This --> that.'];check('forbidden payload separator '+position,toVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n'+rows.join('\n')),{ok:false,reason:'format'});
}
check('named NOTE-like cue is not mistaken for a comment',toVtt('WEBVTT\n\nNOTEBOOK\n'+cue),expected);
check('missing header still accepts SRT',toVtt('1\n00:00:01,000 --> 00:00:02,000\nWords.'),expected);
check('confirmed empty timed pause before cue',toVtt('WEBVTT\n\n00:00:00.000 --> 00:00:00.500\n\n'+cue),expected);
check('native input never coerced',toVtt({toString(){throw Error('not text');}}),{ok:false,reason:'empty'});
console.log(JSON.stringify({count,fail}));process.exitCode=fail?1:0;
