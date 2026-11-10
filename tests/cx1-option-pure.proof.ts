import { optionDelivers, sellableOptions } from '@/lib/product-option';
import type { Listing } from '@/lib/store';
import { done, is } from './check';

const off={id:'off',label:'Off',priceCents:1000,file:null,link:'https://example.com/kept',details:[],best:false,offSale:true as const};
const on={...off,id:'on',label:'On',offSale:undefined};
for(const ownDelivery of [{},{course:{lessons:1}},{podcast:{episodes:1}},{shipping:{}}]){
  const product={options:[off,on],...ownDelivery} as unknown as Listing;
  is(`only offered option survives ${JSON.stringify(ownDelivery)}`,sellableOptions(product).map(x=>x.id),['on']);
}
is('empty options remain empty',sellableOptions({options:[]} as unknown as Listing),[]);
is('off-sale option retains delivery for an earlier buyer',optionDelivers(off),true);
done();
