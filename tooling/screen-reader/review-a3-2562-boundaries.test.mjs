import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NVDAKeyCodeCommands, WindowsKeyCodes, WindowsModifiers} from '@guidepup/guidepup';
import {navigateToContent} from './navigate-to-content.mjs';

// Actual helper/Guidepup commands; deterministic OS boundary only. No native
// Windows, browser, screen-reader session or accessibility certification.
function boundary({initialSwitches=0, recoveryThrows=false, secondLoss=false}={}) {
  const title='Synthetic A3 review page';
  const browser=title+' - Chromium';
  const events=[];
  const state={title:initialSwitches?'Another application':browser, switches:0, activations:0, resets:0, headings:0, spoken:''};
  const failure=new Error('Synthetic activation failed');
  const reader={
    async perform(command) {
      if(command===NVDAKeyCodeCommands.reportTitle) {
        state.spoken=state.title;events.push(['title',state.title]);return;
      }
      if(command.keyCode?.includes?.(WindowsKeyCodes.Escape)&&command.modifiers?.includes?.(WindowsModifiers.Alt)) {
        state.switches++;events.push(['switch',state.switches]);
        if(state.switches>=initialSwitches&&state.resets===0)state.title=browser;
      }
      if(command.keyCode?.includes?.(WindowsKeyCodes.Home)&&command.modifiers?.includes?.(WindowsModifiers.Control)) {
        state.resets++;events.push(['reset',state.resets]);
        if(state.resets===1||secondLoss)state.title='Search';
      }
    },
    async lastSpokenPhrase(){return state.spoken;},
    async nextHeading(){state.headings++;events.push(['heading']);},
  };
  const page={
    async bringToFront(){
      state.activations++;events.push(['activate',state.activations]);
      if(state.activations===2) {
        if(recoveryThrows)throw failure;
        state.title=browser;
      }
    },
    async title(){return title;},
    locator(selector){assert.equal(selector,'body');return {async focus(){},async click(){},async blur(){}};},
  };
  const run=async()=>{await navigateToContent(reader,page,'nvda');await reader.nextHeading();};
  return {state,events,browser,failure,run};
}

test('A3: a single activation may recover after all ten shared switches were already consumed',async()=>{
  const f=boundary({initialSwitches:10});
  await f.run();
  assert.equal(f.state.switches,10);
  assert.equal(f.state.activations,2);
  assert.equal(f.state.resets,2);
  assert.equal(f.state.headings,1);
  assert.deepEqual(f.events.slice(-3),[['reset',2],['title',f.browser],['heading']]);
  const recovery=f.events.findIndex(event=>event[0]==='activate'&&event[1]===2);
  assert.deepEqual(f.events[recovery-1],['title','Search'],'native mismatch is observed before activation');
  assert.deepEqual(f.events[recovery+1],['title',f.browser],'activation must be followed by native title proof');
});

test('A3: activation failure propagates before any heading or fallback switch',async()=>{
  const f=boundary({recoveryThrows:true});
  await assert.rejects(f.run,error=>error===f.failure);
  assert.equal(f.state.activations,2);
  assert.equal(f.state.switches,0);
  assert.equal(f.state.resets,1);
  assert.equal(f.state.headings,0);
});

test('A3: a second loss at the final reset never grants another activation',async()=>{
  const f=boundary({secondLoss:true});
  await assert.rejects(f.run,/foreground window did not match.*after final document reset/);
  assert.equal(f.state.activations,2);
  assert.equal(f.state.switches,0);
  assert.equal(f.state.resets,2);
  assert.equal(f.state.headings,0);
  assert.deepEqual(f.events.at(-1),['title','Search']);
});
