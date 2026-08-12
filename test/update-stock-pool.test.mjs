import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { FIXED_STOCK_CODES, assertPriceDateReady, atomicWriteJson, buildCandidate, buildFundamentalsCandidate, finMindFundamentals, finMindPrice, officialPriceUrls, pricesWithFallback, rowMap, validateUniverse } from '../scripts/update-stock-pool.mjs';

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
