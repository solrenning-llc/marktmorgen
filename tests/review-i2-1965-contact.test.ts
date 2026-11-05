/** Independent review: real pages/contact predicate, synthetic session and Redis. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Children, isValidElement, type ReactNode } from 'react';
import ContactPage from '@/app/[handle]/contact/page';
import StudioCardPage from '@/app/studio/card/page';
import { StoreContactBox } from '@/components/store-contact-box';
import { contactOpen } from '@/lib/store-contact';
import { claimHandle,ensureStatsId,ensureStoreId,setContact } from '@/lib/store';
import { saveCreatorCard } from '@/lib/creator-card';
import {store as redis} from './redis-stub';
import {useStore} from './review-i2-1965-world';

function forms(node: unknown): number {
 if(!isValidElement(node))return 0;
 const props=node.props as {children?:ReactNode};
 return Number(node.type===StoreContactBox)+Children.toArray(props.children).reduce<number>((sum,child)=>sum+forms(child),0);
}
test('public card keeps the actual contact form behind its existing predicate',async()=>{
 redis.clear();process.env.RESEND_API_KEY='re_synthetic_contact_review';
 await claimHandle('review-card-owner@example.test','reviewcard','Synthetic shop','');
 await ensureStatsId('review-card-owner@example.test');await ensureStoreId('review-card-owner@example.test');
 let shop=(await setContact('review-card-owner@example.test',{on:true,heading:'',line:''}))!;
 await saveCreatorCard(shop.statsId!,{on:true,name:'Synthetic creator',title:'',email:'',phone:'',website:'',note:''},shop);
 const page=()=>ContactPage({params:Promise.resolve({handle:'@reviewcard'}),searchParams:Promise.resolve({})});
 assert.equal(contactOpen(shop),true);assert.equal(forms(await page()),1);
 const html=renderToStaticMarkup(StoreContactBox({store:shop}));
 assert.match(html,/action="\/api\/store\/contact"/);assert.match(html,/name="website"/);assert.match(html,/name="handle" value="reviewcard"/);
 shop=(await setContact('review-card-owner@example.test',{on:false,heading:'',line:''}))!;
 assert.equal(contactOpen(shop),false);assert.equal(forms(await page()),0);
 assert.equal(forms(await ContactPage({params:Promise.resolve({handle:'@reviewcard'}),searchParams:Promise.resolve({status:'sent'})})),0);
});
test('LEVE: enabled contact form is not reported as switched off when its provider is unavailable',async()=>{
 const shop=(await setContact('review-card-owner@example.test',{on:true,heading:'',line:''}))!;
 useStore(shop);
 for(const key of ['RESEND_API_KEY','RESEND_CREATORS_API_KEY','AWS_SES_ROLE_ARN','AWS_SES_REGION','AWS_SES_CONFIGURATION_SET','AWS_SES_TOPIC_ARN'])delete process.env[key];
 assert.equal(shop.contact.on,true);assert.equal(contactOpen(shop),false);
 const html=renderToStaticMarkup(await StudioCardPage({searchParams:Promise.resolve({})}));
 console.log(JSON.stringify({enabled:shop.contact.on,available:contactOpen(shop),saysOff:html.includes('contact form is off'),offersTurnOn:html.includes('Turn on the contact form')}));
 assert.equal(html.includes('contact form is off'),false,'unknown provider availability must not be presented as the creator switching the form off');
});
