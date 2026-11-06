import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stanComparison, HOME_QUESTIONS, homeQuestions } from '../lib/home-faq';
import { HELP_SECTIONS } from '../lib/help-content';

// The Stan comparison left the home page (VS1, owner 31/10/2026) for the help
// center; its capability wording is held where it now lives.
test('the Stan comparison describes the server-provided PayPal availability',()=>{
 assert.match(stanComparison(false),/PayPal at checkout/);assert.doesNotMatch(stanComparison(true),/PayPal at checkout/);
});
test('callers without deployment capabilities use the conservative defaults',()=>{
 assert.equal(stanComparison(),stanComparison(false));
 assert.deepEqual(HOME_QUESTIONS,homeQuestions());
 const help=HELP_SECTIONS.flatMap(section=>section.items).find(item=>item.q==="How does Marktmorgen compare with Stan?");
 assert.ok(help);assert.deepEqual(help.a,[stanComparison(false)]);
});
test("the comparison preserves implemented meeting-provider capability with connection conditions",()=>{
 const answer=stanComparison(false);
 assert.doesNotMatch(answer,/Zoom links made for each booking and webinar/);
 assert.match(answer,/Google Meet and Zoom links for supported connected accounts/);
 assert.match(answer,/provider availability and connection requirements/);
});
