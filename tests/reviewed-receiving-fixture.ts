import { MOST_CORRECT_READING, receivingOf } from '../lib/receiving-costs';
import type {CustomerTaxInput,TaxContext} from '../lib/customer-tax-review';
import {txCustomerFixture} from './customer-tax-review-fixture';
/** Data only: hypothetical complete source/fact/FX/operation evidence, never
 * a calculation/approval override or a real tax review. Tests still invoke
 * reviewedUnitUnder itself and assert the actual result. */
export function reviewedReceivingTaxInput(priceCents:number,usageCents:number,scope:TaxContext,ownTransaction=true):CustomerTaxInput {
 const received=receivingOf(priceCents,MOST_CORRECT_READING,ownTransaction);
 const scenario=txCustomerFixture(received.revenueCents,received.totalCents+usageCents,scope);
 return {taxReview:scenario.taxReview!,taxContext:scenario.taxContext!};
}
