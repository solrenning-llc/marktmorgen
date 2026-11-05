import { parsePage, type PageBlock } from '@/lib/sales-page';
import { keepEveryBlock, pageWords, withWords } from '@/lib/page-translate';
import { blocksForPage, fitsPage, parseSection, readSectionInput, sectionBlocks } from '@/lib/saved-blocks';
import { done, is } from './check';

const booking = (heading = 'x'.repeat(95), id = 'book0001') => ({ id, kind: 'booking', product: 'call000001', heading });
const text = (heading: string) => ({ id: 'text0001', kind: 'text', heading, body: '' });
for (const variantOnly of [false, true]) {
  const a = [booking(variantOnly ? 'Main' : undefined), text('Start today')];
  const b = [booking(undefined, 'book0002'), text('Begin today')];
  const page = parsePage({ blocks: a, variant: { blocks: b } });
  const before = JSON.stringify(page);
  const next = keepEveryBlock(page, withWords(page, pageWords(page).map(w => w.length === 95 ? w + ' more words' : w.toUpperCase())));
  is(`distinct versions retained ${variantOnly}`, !!next.page.variant, true);
  is(`only displayed restored blocks counted ${variantOnly}`, next.untranslated, variantOnly ? 1 : 2);
  is(`original is untouched ${variantOnly}`, JSON.stringify(page), before);
}
{
  const page = parsePage({ blocks: [booking(), text('Start today')], variant: { blocks: [booking(), text('Begin today')] } });
  const next = keepEveryBlock(page, withWords(page, pageWords(page).map(w => /today/.test(w) ? 'Comienza hoy' : w + ' more words')));
  is('equal version is dropped', next.page.variant, null);
  is('a dropped restored block is not counted', next.untranslated, 1);
  const kept = keepEveryBlock(page, withWords(page, pageWords(page).map(w => w)));
  is('unchanged words do not count as failed restorations', kept.untranslated, 0);
}
const b = parsePage({ blocks: [booking('Reserve a call')] }).blocks[0] as PageBlock;
const section = { id: 'sect000001', name: 'Calls', blocks: [b], updatedAt: 1 };
is('well-formed booking input is refused by kind', readSectionInput('Calls', [b]), { ok: false, error: 'kind' });
is('legacy booking-only saved section cannot be loaded', parseSection(section), null);
is('booking-only section cannot fit even when allowed kinds include booking', fitsPage(section, ['booking']), false);
is('booking cannot be inserted from a legacy section', blocksForPage(section), []);
is('booking removed from section extraction', sectionBlocks([b]).blocks, []);
const mixed = parseSection({ ...section, blocks: [b, text('Ordinary words')] });
is('ordinary text remains from legacy mixed section', mixed?.blocks.map(b => b.kind), ['text']);
is('valid ordinary section input stays accepted', readSectionInput('Text', [text('Welcome')]).ok, true);
done();
