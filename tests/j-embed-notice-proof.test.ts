import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CheckoutScriptEditor} from '@/components/checkout-script-editor';
import {buttonColors} from '@/lib/embed-rules';
import {contrast} from '@/lib/store-look';
test('the substituted-color notice must describe the actual emitted foreground',()=>{
 const colors=buttonColors('invalid','#ffcc00');
 assert.equal(colors.changed,true);assert.equal(colors.onFill,'#ffcc00');
 assert.ok(contrast(colors.fill,colors.onFill)>=7);
 const html=renderToStaticMarkup(createElement(CheckoutScriptEditor,{handle:'synthetic-store',products:[{id:'abc123',title:'Synthetic course'}],fill:'invalid',onFill:'#ffcc00',sites:[],signup:false}));
 assert.ok(html.includes('color:#ffcc00'),'the real editor emits a gold foreground');
 console.log('PARTIAL_COLOR_FALLBACK',colors,html.includes('The code uses dark and white'));
 assert.equal(html.includes('The code uses dark and white'),false,'a generic correction notice cannot promise a white foreground when the emitted foreground is gold');
});
