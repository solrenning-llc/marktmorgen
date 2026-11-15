/**
 * EU VAT, unit 2 (IVA, 14/11/2026): the ECB's euro reference rates as the OSS return reads them. The fixture is four
 * rows of the ECB Data Portal's own CSV answer, read on 14/11/2026 from
 * https://data-api.ecb.europa.eu/service/data/EXR/D.GBP+USD.EUR.SP00.A?startPeriod=2026-09-30&endPeriod=2026-10-06&format=csvdata
 * (2026-10-03 and 2026-10-04, a weekend, have no row). The rate of a period's last day is the one published that
 * day, or on the next day of publication (Directive art. 366(2)), never an earlier one. Nothing reaches the network.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ECB_NEXT_PUBLICATION_DAYS, ecbRatesUrl, fetchEcbRates, periodEndRate, readEcbCsv } from "@/lib/ecb-rates";

const OFFICIAL = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK,OBS_COM,TIME_FORMAT,BREAKS,COLLECTION,COMPILING_ORG,DISS_ORG,DOM_SER_IDS,PUBL_ECB,PUBL_MU,PUBL_PUBLIC,UNIT_INDEX_BASE,COMPILATION,COVERAGE,DECIMALS,NAT_TITLE,SOURCE_AGENCY,SOURCE_PUB,TITLE,TITLE_COMPL,UNIT,UNIT_MULT\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-30,1.1355,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,\"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)\",USD,0\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-02,1.1225,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,\"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)\",USD,0\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-05,1.1204,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,\"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)\",USD,0\nEXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-09-30,0.85463,A,F,,,P1D,,A,,,,,,,99Q1=100,,,5,,4F0,,Pound sterling/Euro ECB reference exchange rate,\"ECB reference exchange rate, Pound sterling/Euro, 2.15 pm (C.E.T.)\",GBP,0";

test("the ECB's CSV reads into decimal strings per currency and day", () => {
  const rates = readEcbCsv(OFFICIAL)!;
  assert.deepEqual([...rates.get("USD")!], [["2026-09-30", "1.1355"], ["2026-10-02", "1.1225"], ["2026-10-05", "1.1204"]]);
  assert.deepEqual([...rates.get("GBP")!], [["2026-09-30", "0.85463"]]);
});

test("the last day's rate, or the next publication's; never an earlier one, never past the window", () => {
  const rates = readEcbCsv(OFFICIAL)!;
  assert.deepEqual(periodEndRate(rates, "USD", "2026-09-30"), { perEuro: "1.1355", day: "2026-09-30" });
  assert.deepEqual(periodEndRate(rates, "USD", "2026-10-03"), { perEuro: "1.1204", day: "2026-10-05" }, "a Saturday takes Monday's");
  assert.deepEqual(periodEndRate(rates, "EUR", "2026-09-30"), { perEuro: "1", day: "2026-09-30" });
  assert.equal(periodEndRate(rates, "USD", "2026-10-06"), null);
  assert.equal(periodEndRate(rates, "JPY", "2026-09-30"), null);
  assert.equal(periodEndRate(rates, "USD", "2026-09-31"), null);
  const far = readEcbCsv(OFFICIAL.replace("2026-10-05", "2026-10-15"))!;
  assert.equal(periodEndRate(far, "USD", "2026-10-03"), null, `more than ${ECB_NEXT_PUBLICATION_DAYS} days`);
});

test("an answer that is not the daily euro reference rate, or does not read, is no rates at all", () => {
  for (const broken of [
    "", "not,a,csv", OFFICIAL.replace(",D,USD,", ",M,USD,"), OFFICIAL.replace(",EUR,SP00,A,2026-09-30,1.1355", ",EUR,SP00,A,2026-09-30,abc"),
    OFFICIAL.replace("2026-10-02", "2026-02-30"), OFFICIAL.replace(",EUR,SP00,A,2026-09-30,1.1355", ",EUR,SP00,A,2026-09-30,-1"),
    OFFICIAL + "\n" + OFFICIAL.split("\n")[1].replace("1.1355", "1.2000"),
  ]) assert.equal(readEcbCsv(broken), null, broken.slice(0, 80));
  assert.equal(readEcbCsv(null), null);
});

test("the address names the currencies, the days and the CSV format; one request, never a throw", async () => {
  assert.equal(ecbRatesUrl(["USD", "GBP"], "2026-09-30", "2026-10-06"),
    "https://data-api.ecb.europa.eu/service/data/EXR/D.GBP+USD.EUR.SP00.A?startPeriod=2026-09-30&endPeriod=2026-10-06&format=csvdata");
  assert.equal(ecbRatesUrl(["EUR"], "2026-09-30", "2026-10-06"), null);
  assert.equal(ecbRatesUrl(["USD"], "2026-10-06", "2026-09-30"), null);
  const asked: string[] = [];
  const ok = await fetchEcbRates(["USD"], "2026-09-30", "2026-10-06", async (url) => { asked.push(url); return { status: 200, text: async () => OFFICIAL }; });
  assert.equal(ok?.get("USD")?.get("2026-09-30"), "1.1355");
  assert.equal(asked.length, 1);
  assert.equal(await fetchEcbRates(["USD"], "2026-09-30", "2026-10-06", async () => ({ status: 503, text: async () => OFFICIAL })), null);
  assert.equal(await fetchEcbRates(["USD"], "2026-09-30", "2026-10-06", async () => { throw new Error("offline"); }), null);
});
