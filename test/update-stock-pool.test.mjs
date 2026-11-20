import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CORPORATE_ACTIONS, FIXED_STOCK_CODES, adjustStoredPerShare, buildDividendCandidate, compareOfficialDividends, corporateActionFindings, loadPageCompute, parseOfficialDividendEvents, parseOfficialReductions, assertPriceDateReady, atomicWriteJson, buildCandidate, buildFundamentalsCandidate, cheapSummary, finMindFundamentals, finMindPrice, officialPriceUrls, pricesWithFallback, rowMap, validateUniverse } from '../scripts/update-stock-pool.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/twse-closing-sample.json', import.meta.url), 'utf8'));
const fundamentalFixture = JSON.parse(await fs.readFile(new URL('./fixtures/fundamentals-common-period.json', import.meta.url), 'utf8'));
const prices = rowMap(fixture);
assert.equal(prices.get('2330'), 2300);
assert.equal(prices.get('0056'), 51.25);
assert.equal(prices.get('3556'), 64.2, 'TPEx 收盤 column must be accepted');
for (const code of ['8044', '5904', '2729', '1268', '3556', '6016', '3260', '6121', '6195', '3078']) {
  assert.ok(prices.get(code) > 0, `official TPEx fixture must cover ${code}`);
}
assert.equal(prices.has('1101'), false, 'non-price official placeholder must not be accepted');

const [twseUrl, tpexUrl] = officialPriceUrls('2026-07-29');
assert.match(twseUrl, /date=20260729/);
assert.match(tpexUrl, /date=115%2F07%2F29&type=EW/);

const stocks = [
  { name: '甲', code: '2330', J: 2300, divEarn1: 22, div1: 22, avgYld5: 0.0201 },
  { name: '乙', code: '0056', type: 'etf', J: 50.75, divEarn1: 3.598, div1: 3.598, avgYld5: 0.0998 }
];
const next = buildCandidate(stocks, prices, '2026-07-29');
assert.equal(next.updated[0].cheap, 0.476);
assert.equal(next.updated[1].cheap, 0.703);
assert.equal(next.updated[1].divYldAll, 0.0702);
assert.equal(next.medCheap, 0.703);
assert.throws(
  () => buildCandidate(stocks, new Map([['2330', 2300]]), '2026-07-29'),
  /coverage\/validation failed \(1\/2\)/,
  'partial price coverage must not produce a candidate'
);
assert.throws(
  () => buildCandidate(stocks, new Map(), '2026-07-29'),
  /coverage\/validation failed \(0\/2\)/,
  'zero price coverage must fail'
);
const priceWithoutCheap = buildCandidate(
  [...stocks, { name: '丙', code: '5904', J: 60 }],
  new Map([['2330', 2300], ['0056', 51.25], ['5904', 64.2]]),
  '2026-07-29'
);
assert.equal(priceWithoutCheap.priceCovered, 3);
assert.equal(priceWithoutCheap.cheapSampleSize, 2);
assert.equal(priceWithoutCheap.medCheapSample, 2, 'legacy median sample field remains available');
assert.deepEqual(priceWithoutCheap.updated[2].dataStatus.excludedFrom, ['medCheap', 'score', 'signal']);
assert.doesNotThrow(() => assertPriceDateReady('2026-08-07', new Date('2026-08-07T06:01:00Z')));
assert.throws(() => assertPriceDateReady('2026-08-07', new Date('2026-08-07T04:00:00Z')), /not ready before/);
assert.equal(validateUniverse(stocks, stocks), true);
assert.throws(() => validateUniverse([stocks[0], stocks[0]], stocks), /universe mismatch/);
const fixedUniverse = FIXED_STOCK_CODES.map(code => ({ code }));
assert.equal(FIXED_STOCK_CODES.length, 59);
assert.equal(validateUniverse(fixedUniverse), true);
assert.throws(() => validateUniverse(fixedUniverse.slice(1)), /universe mismatch/, 'missing fixed member must fail');
assert.throws(() => validateUniverse(fixedUniverse.map((stock, i) => i === 1 ? fixedUniverse[0] : stock)), /universe mismatch/, 'duplicate fixed member must fail');
assert.throws(() => validateUniverse(fixedUniverse.map((stock, i) => i === 0 ? { code: '9999' } : stock)), /universe mismatch/, 'wrong fixed member must fail');
assert.throws(() => validateUniverse(fixedUniverse.map((stock, i) => i === 0 ? { code: '' } : stock)), /universe mismatch/, 'missing stock code must fail');

const formalStocks = Array.from({ length: 59 }, (_, i) => ({
  name: `正式規模${i + 1}`,
  code: String(1001 + i),
  J: 100,
  divEarn1: 5,
  div1: 5,
  avgYld5: 0.05,
  type: 'stock'
}));
const formal58Prices = new Map(formalStocks.slice(0, 58).map(stock => [stock.code, 100]));
assert.throws(
  () => buildCandidate(formalStocks, formal58Prices, '2026-07-29'),
  /coverage\/validation failed \(58\/59\)/,
  '58/59 price coverage must not build a candidate'
);

const fallbackRequests = [];
const fallbackPriceResult = await pricesWithFallback(
  [{ name: '上市', code: '2330' }, { name: '官方缺檔', code: '5904' }],
  '2026-08-07',
  {
    fetchImpl: async url => {
      const parsed = new URL(url);
      fallbackRequests.push(parsed);
      if (parsed.hostname === 'www.twse.com.tw') {
        return new Response(JSON.stringify({ tables: [{ fields: ['代號', '收盤價'], data: [['2330', '2370']] }] }), { status: 200 });
      }
      if (parsed.hostname === 'www.tpex.org.tw') {
        return new Response(JSON.stringify({ tables: [] }), { status: 200 });
      }
      assert.equal(parsed.searchParams.get('dataset'), 'TaiwanStockPrice');
      assert.equal(parsed.searchParams.get('data_id'), '5904');
      assert.equal(parsed.searchParams.get('start_date'), '2026-08-07');
      assert.equal(parsed.searchParams.get('end_date'), '2026-08-07');
      return new Response(JSON.stringify({ status: 200, data: [{ date: '2026-08-07', close: 64.2 }] }), { status: 200 });
    },
    sleep: async () => {}
  }
);
assert.equal(fallbackPriceResult.prices.get('2330'), 2370);
assert.equal(fallbackPriceResult.prices.get('5904'), 64.2);
assert.deepEqual(fallbackPriceResult.fallbackCodes, ['5904']);
assert.equal(fallbackRequests.filter(url => url.searchParams.get('dataset') === 'TaiwanStockPrice').length, 1);
let missingDayCalls = 0;
await assert.rejects(
  () => pricesWithFallback(
    [{ name: '上市', code: '2330' }, { name: '無當日成交', code: '5904' }],
    '2026-08-07',
    {
      fetchImpl: async url => {
        const parsed = new URL(url);
        if (parsed.hostname === 'www.twse.com.tw') {
          return new Response(JSON.stringify({ tables: [{ fields: ['代號', '收盤價'], data: [['2330', '2370']] }] }), { status: 200 });
        }
        if (parsed.hostname === 'www.tpex.org.tw') {
          return new Response(JSON.stringify({ tables: [] }), { status: 200 });
        }
        missingDayCalls += 1;
        return new Response(JSON.stringify({ status: 200, data: [{ date: '2026-07-29', close: 720 }] }), { status: 200 });
      },
      sleep: async () => {}
    }
  ),
  /price coverage failed \(1\/2\)/,
  'FinMind補檔後仍缺一檔時不得產生候選'
);
assert.equal(missingDayCalls, 1, 'missing same-day price must not trigger a prior-date lookback');
const incompleteFallbackPrices = new Map(fallbackPriceResult.prices);
incompleteFallbackPrices.delete('5904');
assert.throws(
  () => buildCandidate(
    [{ name: '上市', code: '2330', J: 2300, div1: 22, avgYld5: 0.0201 }, { name: '官方缺檔', code: '5904', J: 60, div1: 3, avgYld5: 0.1 }],
    incompleteFallbackPrices,
    '2026-08-07'
  ),
  /coverage\/validation failed \(1\/2\)/,
  'price write gate still rejects any stock not covered after fallback'
);
await assert.rejects(
  () => finMindPrice('5904', '2026-08-07', {
    fetchImpl: async () => new Response(JSON.stringify({ status: 200, data: [{ date: '2026-08-06', close: 63 }] }), { status: 200 })
  }),
  /price missing for 5904 on 2026-08-07/,
  'FinMind neighboring dates must not satisfy the requested trading date'
);

const epsRows = dates => dates.flatMap((date, i) => [
  { date, type: 'EPS', value: i < 4 ? 1 : 2 },
  { date, type: 'IncomeAfterTaxes', value: i < 4 ? 10 : 20 },
  { date, type: 'Revenue', value: 100 }
]);
const fundamentalStocks = [{ name: '甲', code: '2330', type: 'stock' }, { name: '乙ETF', code: '0056', type: 'etf', AK: null }];
const eightDates = ['2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31'];
const fundamentals = buildFundamentalsCandidate(fundamentalStocks, new Map([['2330', epsRows(eightDates)]]), '2026-05-10');
assert.equal(fundamentals.updated[0].AK, 1);
assert.equal(fundamentals.updated[0].AA, 20);
assert.equal(fundamentals.medAK, 1);
assert.equal(fundamentals.periodEnd, '2026-03-31');
assert.equal(fundamentals.validUntil, '2026-08-14');
assert.equal(fundamentals.covered, 1);
assert.equal(fundamentals.updated[1].dataStatus.fundamentals, 'na');
assert.deepEqual(
  Object.fromEntries(['q1Period', 'q2Period', 'q3Period', 'q4Period'].map(key => [key, fundamentals.updated[0][key]])),
  { q1Period: '2025Q2', q2Period: '2025Q3', q3Period: '2025Q4', q4Period: '2026Q1' },
  'canonical EPS values must carry the four exact FinMind source quarters for index.html safety gate'
);
assert.throws(() => buildFundamentalsCandidate(fundamentalStocks, new Map([['2330', epsRows(eightDates.slice(1))]]), '2026-05-10'), /no analyzable fundamental samples/);
const carriedForwardFundamentals = buildFundamentalsCandidate(fundamentalStocks, new Map([['2330', epsRows(eightDates)]]), '2026-08-15');
assert.equal(carriedForwardFundamentals.periodEnd, '2026-03-31');
assert.equal(carriedForwardFundamentals.validUntil, '2026-08-14');
assert.equal(carriedForwardFundamentals.updated[0].q4Period, '2026Q1', 'last complete financial window remains usable after the next filing deadline');
const zeroIncome = epsRows(eightDates).map(row => row.type === 'IncomeAfterTaxes' ? { ...row, value: 0 } : row);
assert.equal(buildFundamentalsCandidate([{ ...fundamentalStocks[0], AA: 7 }], new Map([['2330', zeroIncome]]), '2026-05-10').updated[0].AA, 7, 'AA=0 must preserve existing value like computeJS');

// One company has reported Q2, while the other has only Q1.  Both have a
// complete Q1 window, so Q1 is the newest valid common period.  AA is checked
// too: it must use the selected Q1 window rather than the first company's Q2.
const commonPeriodDates = fundamentalFixture.q1_2026;
const epsIncomeRevenue = dates => dates.flatMap((date, i) => [
  { date, type: 'EPS', value: i + 1 },
  { date, type: 'IncomeAfterTaxes', value: (i + 1) * 10 },
  { date, type: 'Revenue', value: 100 }
]);
const newerCompanyRows = epsIncomeRevenue([...commonPeriodDates, fundamentalFixture.q2_2026_extra]);
const q1CompanyRows = epsIncomeRevenue(commonPeriodDates);
const commonPeriodCandidate = buildFundamentalsCandidate(
  [{ name: '先公布Q2', code: '1111', type: 'stock' }, { name: '僅公布Q1', code: '2222', type: 'stock' }],
  new Map([['1111', newerCompanyRows], ['2222', q1CompanyRows]]),
  '2026-07-29'
);
assert.equal(commonPeriodCandidate.periodEnd, '2026-03-31');
assert.equal(commonPeriodCandidate.validUntil, '2026-08-14');
assert.equal(commonPeriodCandidate.updated[0].q4, 8, 'must not use this company’s Q2 EPS');
assert.equal(commonPeriodCandidate.updated[0].AA, 65, 'must calculate AA from the common Q1 window');
assert.equal(commonPeriodCandidate.medAK, 1.6);
assert.equal(commonPeriodCandidate.updated[0].q4Period, '2026Q1', 'source quarter must match the common, not the newest company-specific window');

const partialFundamentals = buildFundamentalsCandidate(
  [{ name: '已公布', code: '1111', type: 'stock' }, { name: '缺資料', code: '2222', type: 'stock', AK: 0.25 }],
  new Map([['1111', newerCompanyRows], ['2222', []]]),
  '2026-07-29'
);
assert.equal(partialFundamentals.covered, 1);
assert.deepEqual(partialFundamentals.excludedCodes, ['2222']);
assert.equal(partialFundamentals.updated[1].AK, 0.25, 'excluded stock retains its last-known display value');
assert.deepEqual(partialFundamentals.updated[1].dataStatus.excludedFrom, ['fundamentals', 'medAK', 'score', 'signal']);

const formal53Rows = new Map(formalStocks.slice(0, 53).map(stock => [stock.code, epsRows(eightDates)]));
const formal53Fundamentals = buildFundamentalsCandidate(formalStocks, formal53Rows, '2026-05-10');
assert.equal(formal53Fundamentals.covered, 53, '53/59 fundamental coverage must still build a candidate');
assert.equal(formal53Fundamentals.fundamentalsCovered, 53);
assert.equal(formal53Fundamentals.medAKSampleSize, 53);
assert.equal(formal53Fundamentals.medAKSample, 53, 'legacy median sample field remains available');
assert.equal(formal53Fundamentals.updated.length, 59, 'missing fundamentals must not remove canonical members');

const actionDates=['2024-03-31','2024-06-30','2024-09-30','2024-12-31','2025-03-31','2025-06-30','2025-09-30','2025-12-31'];
const actionRows=actionDates.map(date=>({date,type:'EPS',value:date<'2025-08-25'?4:1}));
const actionCandidate=buildFundamentalsCandidate([{name:'國巨',code:'2327',type:'stock'}],new Map([['2327',actionRows]]),'2026-01-10');
assert.equal(actionCandidate.updated[0].AK,0,'corporate-action normalization must keep pre/post split EPS comparable');
assert.deepEqual([actionCandidate.updated[0].q1,actionCandidate.updated[0].q2,actionCandidate.updated[0].q3,actionCandidate.updated[0].q4],[1,1,1,1]);

const disjointFundamentals = buildFundamentalsCandidate(
  [{ name: '舊期公司', code: '3333', type: 'stock' }, { name: '新期公司', code: '4444', type: 'stock' }],
  new Map([['3333', epsIncomeRevenue(fundamentalFixture.no_common_early)], ['4444', epsIncomeRevenue(fundamentalFixture.no_common_late)]]),
  '2026-07-29'
);
assert.equal(disjointFundamentals.periodEnd, '2026-12-31', 'equal coverage must prefer the newer period');
assert.equal(disjointFundamentals.covered, 1);
const noMedianRows = eightDates.map((date, i) => ({ date, type: 'EPS', value: i < 4 ? 0 : 1 }));
const mixedAKCandidate = buildFundamentalsCandidate(
  [{ name: '有效成長率', code: '1111', type: 'stock' }, { name: '無有效成長率', code: '2222', type: 'stock' }],
  new Map([['1111', epsRows(eightDates)], ['2222', noMedianRows]]),
  '2026-05-10'
);
assert.equal(mixedAKCandidate.fundamentalsCovered, 2);
assert.equal(mixedAKCandidate.medAKSampleSize, 1, 'fundamental coverage and effective medAK sample must be disclosed separately');
assert.deepEqual(mixedAKCandidate.updated[1].dataStatus.excludedFrom, ['medAK', 'score', 'signal']);
assert.throws(
  () => buildFundamentalsCandidate([{ name: '無有效成長率', code: '1111', type: 'stock' }], new Map([['1111', noMedianRows]]), '2026-05-10'),
  /EPS growth median missing/
);

const savedToken = process.env.FINMIND_TOKEN;
process.env.FINMIND_TOKEN = 'test-token-must-not-leak';
let attempts = 0;
let requestedUrl = '';
await assert.rejects(
  () => finMindFundamentals('2330', {
    start: '2023-01-01',
    fetchImpl: async url => {
      requestedUrl = String(url);
      attempts += 1;
      return new Response('rate limited', { status: 429 });
    },
    sleep: async () => {}
  }),
  error => {
    assert.match(error.message, /rate limit \(HTTP 429\).*after 3 attempts/);
    assert.ok(!error.message.includes('test-token-must-not-leak'));
    assert.ok(!error.message.includes('api.finmindtrade.com'));
    return true;
  }
);
assert.equal(attempts, 3, '429 must use finite retry attempts');
assert.ok(requestedUrl.includes('token=test-token-must-not-leak'), 'token is sent only to FinMind request');
let serverAttempts = 0;
await assert.rejects(
  () => finMindFundamentals('2330', {
    start: '2023-01-01',
    fetchImpl: async () => {
      serverAttempts += 1;
      return new Response('temporarily unavailable', { status: 503 });
    },
    sleep: async () => {}
  }),
  /server error \(HTTP 503\).*after 3 attempts/
);
assert.equal(serverAttempts, 3, '5xx must use finite retry attempts');
if (savedToken === undefined) delete process.env.FINMIND_TOKEN;
else process.env.FINMIND_TOKEN = savedToken;

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-snapshot-test-'));
const snapshotFile = path.join(temp, 'stock-pool-snapshot.json');
await fs.writeFile(snapshotFile, '{"old":true}\n');
await assert.rejects(() => atomicWriteJson(snapshotFile, { next: true }, { failBeforeRename: true }));
assert.equal(await fs.readFile(snapshotFile, 'utf8'), '{"old":true}\n');
await atomicWriteJson(snapshotFile, { schemaVersion: 1, next: true });
assert.deepEqual(JSON.parse(await fs.readFile(snapshotFile, 'utf8')), { schemaVersion: 1, next: true });
assert.equal(await fs.readFile(snapshotFile, 'utf8'), '{"schemaVersion":1,"next":true}\n', 'canonical snapshot stays compact without changing JSON values');

const [indexHtml, morningHtml, updaterScript] = await Promise.all([
  fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../morning.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../scripts/update-stock-pool.mjs', import.meta.url), 'utf8')
]);
assert.match(indexHtml, /最後完成交易日/);
assert.match(indexHtml, /非即時報價/);
assert.match(indexHtml, /stock-pool-snapshot\.json',\{cache:'no-cache'\}/);
assert.match(indexHtml, /dataInsufficient = s\.epsInsufficient===true \|\| !hasFourEPS/);
assert.match(indexHtml, /const hasProv = !!s\.q1Period;/);
assert.match(indexHtml, /dataPending = !hasProv;/);
assert.match(indexHtml, /if\(dataPending\) M='資料待更新';/);
assert.doesNotMatch(indexHtml, /dataStale = !hasProv/);
assert.match(morningHtml, /meta\.state='snapshot';/);
assert.match(morningHtml, /stock-pool-snapshot\.json',\{cache:'no-cache'\}/);
assert.match(morningHtml, /資料截至 /);
assert.match(morningHtml, /predictionDisplayStatus\(pred\)/);
assert.doesNotMatch(morningHtml, /status==='overdue'/);
assert.match(morningHtml, /待結算/);
assert.match(morningHtml, /暫無法判定命中或未中/);
assert.match(morningHtml, /const PREDICTION_VERIFICATIONS=/);
assert.match(morningHtml, /const PREDICTION_CALIBRATION_POLICY=/);
assert.match(morningHtml, /p2:\{status:'hit'/);
assert.match(morningHtml, /p5:\{status:'hit'/);
assert.match(morningHtml, /p6:\{status:'miss'/);
assert.match(morningHtml, /價格門檻過窄/);
assert.match(morningHtml, /市場狀態轉折/);
assert.match(morningHtml, /未達 10 筆校準門檻/);
assert.match(morningHtml, /const memberRows=/);
assert.match(morningHtml, /class="section-note"/);
assert.match(morningHtml, /附註：\$\{g\.note\}/);
assert.doesNotMatch(morningHtml, /return BRIEF\.members;/);
assert.match(morningHtml, /if\(!CANONICAL_STOCK_POOL\)/);
assert.match(morningHtml, /缺資料者不作本次價位判斷，其餘個股照常分析/);
assert.match(morningHtml, /focusStocks/);
assert.match(morningHtml, /CANONICAL_STOCK_POOL=\{price:s\.price\|\|\{\},fundamentals:s\.fundamentals\|\|\{\},stocks:s\.stocks\}/);
assert.doesNotMatch(morningHtml, /item\.sub=joinSub\(item\.sub,stockPoolMetaText\(stock\)/);
assert.doesNotMatch(morningHtml, /sub:joinSub\(sub,meta\?metaShort\(meta\):''\)/);
assert.match(morningHtml, /if\(p\.status==='pending'&&valuationUnavailable/);
assert.match(morningHtml, /p\.due<taipeiDate\(\)/);
assert.match(indexHtml, /當次股價缺漏|本次排除/);
assert.match(indexHtml, /hasFixedUniverse/);
assert.match(morningHtml, /fixed stock universe/);
assert.match(morningHtml, /if\(metaUsable\(meta\.index\)&&metaUsable\(meta\.margin\)/);
assert.doesNotMatch(morningHtml, /股價已過期|財報已過有效期限/);
assert.match(updaterScript, /priceCoverage/);
assert.match(updaterScript, /cheapSampleSize/);
assert.match(updaterScript, /fundamentalsCoverage/);
assert.match(updaterScript, /medAKSampleSize/);
assert.doesNotMatch(updaterScript, /MIN_ANALYSIS_COVERAGE|minimumCoverage|minimum-coverage gate/);
assert.doesNotMatch(updaterScript, /Ignoring invalid canonical snapshot/);
console.log('FIXTURE TEST OK: official price parsing, exact-day FinMind fallback, 59/59 price gate, fundamental coverage, zero-sample rejection, coverage/sample disclosure, common-period selection, corporate actions, fixed-roster validation, safe retries, atomic replacement, and UI policy');

// 2026 面額／股數變更：寶雅 1→10 股、緯穎 1→2.9827946 股。快照沿用的股利與
// 四季 EPS 只能除一次，殖利率與便宜度必須用新基準算。
const corporateFixture = JSON.parse(await fs.readFile(new URL('./fixtures/corporate-actions-2026.json', import.meta.url), 'utf8'));
const [poyaBefore, wiwynnBefore] = corporateFixture.stocks;
assert.equal(CORPORATE_ACTIONS['5904'][0].factor, 10);
assert.equal(CORPORATE_ACTIONS['6669'][0].factor, 2.9827946);
const poya = buildCandidate([poyaBefore], new Map(Object.entries(corporateFixture.closes['2026-11-03'])), '2026-11-03').updated[0];
assert.equal(poya.div1, 2.3);
assert.equal(poya.divEarn1, 2.3);
assert.equal(poya.div5, 2.462);
assert.deepEqual([poya.q1, poya.q2, poya.q3, poya.q4], [0.76, 0.9, 0.93, 0.82]);
assert.equal(poya.divYldAll, 0.0316, '寶雅 殖利率須以 1/10 股利對新收盤價');
assert.equal(poya.cheap, 0.534, '寶雅 便宜度不得再是分割前基準的 4.45');
assert.equal(poya.perShareBasis, '2026-11-03');
assert.equal(poya.avgYld5, 0.0593, '五年平均殖利率是比率，不受股數變更影響');
const wiwynn = buildCandidate([wiwynnBefore], new Map(Object.entries(corporateFixture.closes['2026-09-02'])), '2026-09-02').updated[0];
assert.equal(wiwynn.div1, 48.408);
assert.equal(wiwynn.div5, 24.634);
assert.equal(wiwynn.q4, 26.96);
assert.equal(wiwynn.divYldAll, 0.0185);
assert.equal(wiwynn.cheap, 0.394, '緯穎 除權日便宜度須以 1/2.9827946 股利計算');
const wiwynnDayBefore = buildCandidate([wiwynnBefore], new Map(Object.entries(corporateFixture.closes['2026-09-01'])), '2026-09-01').updated[0];
assert.equal(wiwynnDayBefore.div1, 144.392, '除權前一日仍是舊基準，不得提前調整');
assert.equal(wiwynnDayBefore.perShareBasis, undefined);
assert.equal(adjustStoredPerShare(poyaBefore, '2026-08-09').div1, 23, '新股買賣日前不得調整');
const adjustedTwice = buildCandidate([poya, wiwynn], new Map([['5904', 72.7], ['6669', 2610]]), '2026-11-04').updated;
assert.equal(adjustedTwice[0].div1, 2.3, '再跑一次日更不得重複除以 10');
assert.equal(adjustedTwice[1].div1, 48.408, '再跑一次日更不得重複除以 2.9827946');
assert.equal(adjustedTwice[0].cheap, 0.534);
assert.equal(adjustStoredPerShare({ code: '2327', div1: 5.999, div5: 15.229 }, '2026-11-03').div1, 5.999, '國巨 2025-08-25 已在既有資料反映，不得再除以 4');
assert.equal(adjustStoredPerShare({ code: '2330', div1: 22 }, '2026-11-03').div1, 22, '無事件的公司原樣不動');

// 季更：除權前期末的 FinMind EPS 列除以 factor，除權後的季別不動；股利同時換基準並記下
// perShareBasis，但快照收盤價仍是除權前時不改便宜度，留給下一次日更。
const wiwynnRows = ['2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30'].map(date => ({ date, type: 'EPS', value: 30 }));
wiwynnRows.push({ date: '2026-09-30', type: 'EPS', value: 10 });
const wiwynnQuarterly = buildFundamentalsCandidate([wiwynnBefore], new Map([['6669', wiwynnRows]]), '2026-11-14').updated[0];
assert.equal(wiwynnQuarterly.q3, 10.06, '2026Q2 EPS 30 ÷ 2.9827946');
assert.equal(wiwynnQuarterly.q4, 10, '2026Q3 已是除權後基準，不得再除');
assert.equal(wiwynnQuarterly.q4Period, '2026Q3');
assert.equal(wiwynnQuarterly.div1, 48.408, '季更也要把股利換到新基準');
assert.equal(wiwynnQuarterly.perShareBasis, '2026-11-14');
assert.equal(wiwynnQuarterly.cheap, 0.517, '快照收盤 2026-08-11 仍是除權前價格，便宜度留給日更重算');
const wiwynnAfterBoth = buildCandidate([wiwynnQuarterly], new Map([['6669', 2610]]), '2026-11-14').updated[0];
assert.equal(wiwynnAfterBoth.div1, 48.408, '季更之後的日更不得再除一次');
assert.equal(wiwynnAfterBoth.cheap, 0.394);
assert.equal(wiwynnAfterBoth.q3, 10.06, '日更不得改動季更已換基準的 EPS');

// 四種執行順序都只能除一次；日更→日更、季更→日更已在上方驗過，這裡補另外兩種。
const dailyThenQuarterly = buildFundamentalsCandidate([buildCandidate([wiwynnBefore], new Map([['6669', 1770]]), '2026-11-03').updated[0]], new Map([['6669', wiwynnRows]]), '2026-11-14').updated[0];
assert.equal(dailyThenQuarterly.div1, 48.408, '日更→季更不得再除一次');
assert.equal(dailyThenQuarterly.perShareBasis, '2026-11-03', '季更不得改寫已記下的基準日');
assert.equal(dailyThenQuarterly.q3, 10.06);
assert.equal(dailyThenQuarterly.q4, 10);
assert.equal(dailyThenQuarterly.cheap, 0.581, '日更算好的便宜度不得被季更改掉');
const quarterlyTwice = buildFundamentalsCandidate([wiwynnQuarterly], new Map([['6669', wiwynnRows]]), '2026-11-21').updated[0];
assert.equal(quarterlyTwice.div1, 48.408, '季更→季更不得再除一次');
assert.equal(quarterlyTwice.perShareBasis, '2026-11-14');
assert.equal(quarterlyTwice.q3, 10.06);

// 審查補測：q1–q4 只除期末早於生效日的季別；已是新基準的 2026Q3 不得再除。
const wiwynnWithQ3 = { ...wiwynnBefore, q1: 74.21, q1Period: '2025Q4', q2: 75.95, q2Period: '2026Q1', q3: 80.43, q3Period: '2026Q2', q4: 27.5, q4Period: '2026Q3' };
const wiwynnMixed = buildCandidate([wiwynnWithQ3], new Map([['6669', 1770]]), '2026-11-20').updated[0];
assert.deepEqual([wiwynnMixed.q1, wiwynnMixed.q2, wiwynnMixed.q3, wiwynnMixed.q4], [24.88, 25.46, 26.96, 27.5], '2026Q3 EPS 已是除權後基準，日更只能除前三季');
assert.equal(wiwynnMixed.div1, 48.408);
const unlabeled = adjustStoredPerShare({ code: '5904', div1: 23, q4: 8.15 }, '2026-11-03');
assert.equal(unlabeled.q4, 0.82, '沒有季別標籤時整批除');
// 季更執行日早於生效日：FinMind EPS 列與股利都不得提前換基準。
const earlyQuarterly = buildFundamentalsCandidate([wiwynnBefore], new Map([['6669', wiwynnRows.slice(0, 7).concat([{ date: '2026-09-30', type: 'EPS', value: 30 }])]]), '2026-08-20').updated[0];
assert.equal(earlyQuarterly.q3, 30, '2026-08-20 執行時緯穎尚未除權，EPS 不得先除');
assert.equal(earlyQuarterly.div1, 144.392);
assert.equal(earlyQuarterly.perShareBasis, undefined);
// perShareBasis 壞掉或回補更早日期：直接報錯，不得無聲重複除或新舊基準混用。
assert.throws(() => adjustStoredPerShare({ code: '6669', div1: 48.408, perShareBasis: 'done' }, '2026-11-03'), /invalid perShareBasis for 6669/);
assert.throws(() => adjustStoredPerShare({ code: '6669', div1: 48.408, perShareBasis: '2026-11-03' }, '2026-09-01'), /already on the 2026-11-03 basis/);
assert.throws(() => buildCandidate([wiwynn], new Map([['6669', 7800]]), '2026-09-01'), /already on the 2026-09-02 basis/);
assert.equal(adjustStoredPerShare({ code: '6669', div1: 48.408, perShareBasis: '2026-11-03' }, '2026-11-03').div1, 48.408, '同一天重跑可以');
assert.deepEqual(cheapSummary([{ cheap: 0.5, divYldAll: 0.03 }, { cheap: 1.5, divYldAll: 0.02 }, { cheap: 0.7, divYldAll: 0.01 }, { cheap: 9, divYldAll: 0 }]), { medCheap: 0.7, cheapSampleSize: 3 }, '殖利率 0 的檔不進中位數樣本');

// 網頁「更新股價／完整更新」走 index.html 的 CORP_ACTIONS，更新器走 CORPORATE_ACTIONS；兩張表不一致時，
// 同一檔在網頁與快照會出現不同基準的數字。
const pageCorpMatch = indexHtml.match(/const CORP_ACTIONS=(\{[\s\S]*?\n\});/);
assert.ok(pageCorpMatch, 'index.html 必須有 CORP_ACTIONS');
const pageCorp = new Function(`return ${pageCorpMatch[1]};`)();
const pairs = table => Object.entries(table).flatMap(([code, actions]) => actions.map(action => [code, action.date ?? action.effectiveDate, action.factor])).sort();
assert.deepEqual(pairs(pageCorp), pairs(CORPORATE_ACTIONS), '網頁與更新器的面額／股數變更表必須相同');

// ── 股利每週更新（2026-11-20 Brook 確認的規則）──────────────────────────────
// 更新器直接執行 index.html STOCK-COMPUTE 段的 computeJS；這裡用小型假資料驗證規則本身。
const pageCompute = loadPageCompute(indexHtml);
assert.equal(typeof pageCompute.computeJS, 'function', '更新器必須能執行網頁的 computeJS');
assert.equal(pageCompute.CORP_ACTIONS['6176'][0].factor, 0.75, '瑞儀減資係數');
assert.equal(CORPORATE_ACTIONS['6176'][0].effectiveDate, '2026-08-24');
const flatPrices = (from, to, close = 100) => {
  const rows = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 864e5) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) rows.push({ date: d.toISOString().slice(0, 10), close });
  }
  return rows;
};
const at = date => Date.parse(`${date}T06:00:00Z`);
const cashRow = (date, cash, year) => ({ CashExDividendTradingDate: date, CashEarningsDistribution: cash, CashStatutorySurplus: 0, year });
const priceSeries = flatPrices('2019-01-01', '2027-03-01');
const ttmDiv = (rows, date) => pageCompute.computeJS(priceSeries.filter(r => r.date <= date), rows, [], [], '9999', at(date)).div1;
// 防呆 1：一年一配、除息日提早，一年視窗內有兩次時只算最新一次
const earlier = [cashRow('2024-07-16', 0.5, '112年'), cashRow('2025-07-15', 0.5, '113年'), cashRow('2026-06-30', 0.5, '114年')];
assert.equal(ttmDiv(earlier, '2026-07-10'), 0.5, '一年一配不得重複算兩次');
// 防呆 2：除息日延後、視窗內暫時沒有，18 個月內配過就算最近一次；超過 18 個月才算 0
const later = [cashRow('2024-06-20', 1.3, '112年'), cashRow('2025-06-17', 1.5, '113年'), cashRow('2026-08-11', 0.4, '114年')];
assert.equal(ttmDiv(later, '2026-07-10'), 1.5, '除息日延後時不得算成 0');
assert.equal(ttmDiv(later, '2026-08-11'), 0.4, '新一次除息後改算新的金額');
assert.equal(ttmDiv([cashRow('2022-07-26', 0.508, '110年')], '2026-11-19'), 0, '超過 18 個月沒配息才算 0');
// 半年配、季配不受防呆 1 影響，照常加總
assert.equal(ttmDiv([cashRow('2025-12-17', 9.5, '114年前半年度'), cashRow('2026-07-13', 12.3, '114年後半年度')], '2026-11-19'), 21.8);
assert.equal(ttmDiv([cashRow('2026-03-20', 17, '114年後半年度'), cashRow('2026-09-21', 18, '115年前半年度')], '2026-11-19'), 35);

// 股利欄位寫入：用官方收盤價、重新判定排除、清掉過期的除息日期、記下基準日
const divStock = { name: '測', code: '9999', type: 'stock', J: 100, Jdate: '2026-11-19', div1: 0, divEarn1: 0, avgYld5: 0.05, cheap: 0, divYldAll: 0, exDate: '2025-07-01', payDate: '2025-08-01',
  q1: 1, q2: 1, q3: 1, q4: 1, q1Period: '2025Q3', q2Period: '2025Q4', q3Period: '2026Q1', q4Period: '2026Q2',
  dataStatus: { price: 'ok', fundamentals: 'ok', cheap: 'missing', medAK: 'ok', excludedFrom: ['medCheap', 'score', 'signal'] } };
const divInputs = new Map([['9999', { pr: priceSeries.filter(r => r.date <= '2026-11-19'), dv: [cashRow('2024-07-10', 5, '112年'), cashRow('2025-07-10', 5, '113年'), cashRow('2026-07-10', 5, '114年')] }]]);
const divResult = buildDividendCandidate([divStock], divInputs, '2026-11-19', pageCompute);
const divRow = divResult.updated[0];
assert.equal(divRow.div1, 5);
assert.equal(divRow.divYldAll, 0.05);
assert.equal(divRow.cheap, 1);
assert.equal(divRow.perShareBasis, '2026-11-19');
assert.equal(divRow.exDate, undefined, '已過期的除息日期要清掉');
assert.equal(divRow.payDate, undefined);
assert.deepEqual(divRow.dataStatus.excludedFrom, [], '股利恢復後不得沿用舊的排除標記');
assert.deepEqual(divResult.changedCodes, ['9999']);
assert.deepEqual(buildDividendCandidate(divResult.updated, divInputs, '2026-11-19', pageCompute).updated, divResult.updated, '同一天重跑結果相同');
assert.throws(() => buildDividendCandidate([{ ...divStock, Jdate: '2026-11-18' }], divInputs, '2026-11-19', pageCompute), /要先跑同一天的股價更新/);
assert.throws(() => buildDividendCandidate([divStock], new Map([['9999', { ...divInputs.get('9999'), pr: priceSeries.filter(r => r.date <= '2026-11-18') }]]), '2026-11-19', pageCompute), /ends at 2026-11-18/);
const noDiv = buildDividendCandidate([divStock], new Map([['9999', { pr: divInputs.get('9999').pr, dv: [cashRow('2022-07-26', 0.5, '110年')] }]]), '2026-11-19', pageCompute).updated[0];
assert.equal(noDiv.div1, 0);
assert.equal(noDiv.cheap, 0);
assert.ok(noDiv.dataStatus.excludedFrom.includes('score'), '長期沒配息仍排除評分');

// 官方核對：除息日與現金股利要和證交所、櫃買中心一致；權息合併列示只核對日期
const twsePayload = { stat: 'OK', fields: ['資料日期', '股票代號', '股票名稱', '除權息前收盤價', '除權息參考價', '權值+息值', '權/息'], data: [
  ['115年07月10日', '9999', '測', '105', '100', '5.000000', '息'],
  ['115年08月01日', '9998', '混', '50', '45', '3.000000', '權息'],
  ['115年09月01日', '9997', '權', '50', '45', '1.000000', '權']] };
const tpexPayload = { tables: [{ fields: ['除權息日期', '代號', '名稱', '現金股利'], data: [['115/07/16', '9996', '櫃', '2.55000000']] }] };
const officialEvents = parseOfficialDividendEvents({ twse: twsePayload, tpex: tpexPayload });
assert.deepEqual(officialEvents.get('9999'), [{ date: '2026-07-10', cash: 5, source: 'TWSE' }]);
assert.equal(officialEvents.get('9998')[0].cash, null);
assert.equal(officialEvents.has('9997'), false, '純配股不算現金股利');
const checkStocks = ['9999', '9998', '9996', '9995'].map(code => ({ code }));
const checkInputs = new Map([
  ['9999', { dv: [cashRow('2026-07-10', 5, '114年')] }],
  ['9998', { dv: [cashRow('2026-08-01', 1, '114年')] }],
  ['9996', { dv: [cashRow('2026-07-16', 2.55, '114年')] }],
  ['9995', { dv: [] }]]);
const okCheck = compareOfficialDividends(checkStocks, checkInputs, officialEvents, '2026-11-19');
assert.deepEqual(okCheck, { matched: 3, mixedCodes: ['9998'], mismatches: [] });
const badInputs = new Map([...checkInputs, ['9999', { dv: [cashRow('2026-07-10', 4, '114年')] }], ['9995', { dv: [cashRow('2026-08-20', 1, '114年')] }]]);
const badCheck = compareOfficialDividends(checkStocks, badInputs, officialEvents, '2026-11-19');
assert.equal(badCheck.mismatches.length, 2, '金額或除息日對不上都要擋');
assert.throws(() => parseOfficialDividendEvents({ twse: { stat: '查詢日期大於可查詢最大日期' }, tpex: tpexPayload }), /證交所除權息資料無法取得/);

// 股數變更檢查：未登錄的減資、或扣除除息配股後仍超過漲跌幅的單日變動，都要擋下
assert.deepEqual(parseOfficialReductions({ stat: '很抱歉，沒有符合條件的資料!' }), []);
const reductions = parseOfficialReductions({ stat: 'OK', fields: ['恢復買賣日期', '股票代號', '名稱'], data: [['115/08/24', '6176', '瑞儀'], ['115/05/04', '9999', '測']] });
const jumpRows = [{ date: '2026-07-09', close: 542 }, { date: '2026-07-13', close: 467.5 }, { date: '2026-07-14', close: 468 }, { date: '2026-09-01', close: 468 }, { date: '2026-09-02', close: 300 }];
const caInputs = new Map([['9999', { pr: jumpRows, dv: [cashRow('2026-07-10', 23, '114年')] }], ['6176', { pr: [{ date: '2026-08-12', close: 81.3 }, { date: '2026-08-24', close: 101.5 }], dv: [] }]]);
const caFindings = corporateActionFindings([{ code: '9999' }, { code: '6176' }], caInputs, reductions, pageCompute, '2026-11-19');
assert.deepEqual(caFindings, ['9999 2026-05-04 官方減資未登錄', '9999 2026-09-02 單日 -35.9%'], '休市日除息不誤報、已登錄的瑞儀減資不誤報');
// 櫃買中心減資表（民國年 7 碼日期）也要納入核對
assert.deepEqual(parseOfficialReductions({ tables: [{ fields: ['恢復買賣日期', '股票代號', '名稱'], data: [['1150112', '8093', '保銳']] }] }), [{ date: '2026-01-12', code: '8093' }]);
assert.deepEqual(parseOfficialReductions({ tables: [{ fields: [], data: [] }] }), []);
// 已登錄但計算日之後才生效的事件，不得提前換算（避免股利先換基準、生效後又再除一次）
const futureHtml = indexHtml.replace("const CORP_ACTIONS={", "const CORP_ACTIONS={\n  '9999':[{date:'2026-12-15', factor:2}],");
const futureCompute = loadPageCompute(futureHtml, '2026-11-19');
assert.equal(futureCompute.caFactor('9999', '2026-07-10'), 1, '計算日 11/19 時，12/15 才生效的事件不得換算');
assert.equal(buildDividendCandidate([divStock], divInputs, '2026-11-19', futureCompute).updated[0].div1, 5, '股利不得被提前除以 2');
assert.equal(loadPageCompute(futureHtml, '2026-12-16').caFactor('9999', '2026-07-10'), 2, '生效後才換算');
console.log('DIVIDEND TEST OK: page computeJS reuse, annual dedupe, 18-month fallback, field write-back, official cross-check, corporate-action guard');
