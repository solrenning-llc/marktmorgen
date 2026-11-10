import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PRICES_WITH_COMMISSION,TIERS} from '@/lib/plan';
import {ASSISTANT_ON_SALE,PLANS_ON_SALE} from '@/lib/opening';
import {commercialMarginReady} from '@/lib/commercial-margin';
import {maximumPretaxCostCents} from '@/lib/cost-envelope';
import {ASSISTANT_PRICE_CENTS,addOnFeeCents,assistantMeetsFloor,assistantMonthWorst} from '@/lib/store-assistant-rules';
import * as Receiving from '@/lib/receiving-costs';
import {MOST_CORRECT_READING,providerFeeCents,receivingOf} from '@/lib/receiving-costs';
import {MOST_TAX_READING,SIZING_READING,unitUnder as archivedUnitUnder} from './historical-receiving-model';
import {allUnits,evaluate,floorPriceCents,renderMarginAlignment,roomKept,currentPriceMarginRows,HISTORICAL_TAX_NOTICE} from './margin-alignment-table';
import {reviewedUnitUnder} from '@/lib/reviewed-receiving';
import {gateReading} from '@/lib/tax-gate';
import {reviewedReceivingTaxInput} from './reviewed-receiving-fixture';
import {syntheticTaxContext} from './customer-tax-review-fixture';
import {netOf} from './plan-cost-model';

test('the dated report remains explicitly historical and matches its reproducible figures',()=>{
 const generated=renderMarginAlignment(PLANS_ON_SALE,ASSISTANT_ON_SALE);
 assert.ok(generated.startsWith(HISTORICAL_TAX_NOTICE));
 assert.equal(readFileSync('docs/margin-alignment-2026-10-18.md','utf8'),generated);
});
