import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson, buildCandidate, buildFundamentalsCandidate, finMindFundamentals, finMindPrice, officialPriceUrls, pricesWithFallback, rowMap } from '../scripts/update-stock-pool.mjs';

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

const stocks = [{ name: '甲', code: '2330', J: 2300, cheap: 0.476 }, { name: '乙', code: '0056', J: 50.75, cheap: 0.71 }];
const next = buildCandidate(stocks, prices, '2026-07-29');
assert.equal(next.updated[0].cheap, 0.476);
assert.equal(next.updated[1].cheap, 0.703);
assert.equal(next.medCheap, 0.703);
assert.throws(() => buildCandidate(stocks, new Map([['2330', 2300]]), '2026-07-29'));

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
let carryForwardCalls = 0;
const carryForwardResult = await pricesWithFallback(
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
      carryForwardCalls += 1;
      const data = carryForwardCalls === 1 ? [] : [{ date: '2026-07-29', close: 720 }];
      return new Response(JSON.stringify({ status: 200, data }), { status: 200 });
    },
    sleep: async () => {}
  }
);
assert.equal(carryForwardCalls, 2, 'missing same-day price must use one bounded FinMind lookback');
assert.equal(carryForwardResult.prices.get('5904'), 720);
assert.equal(carryForwardResult.fallbackDates.get('5904'), '2026-07-29');
const carriedCandidate = buildCandidate(
  [{ name: '上市', code: '2330', J: 2300, cheap: 0.476 }, { name: '無當日成交', code: '5904', J: 60, cheap: 0.5 }],
  carryForwardResult.prices,
  '2026-08-07',
  carryForwardResult.fallbackDates
);
assert.equal(carriedCandidate.updated[1].Jdate, '2026-07-29', 'carried-forward price keeps its real FinMind source date');
const incompleteFallbackPrices = new Map(fallbackPriceResult.prices);
incompleteFallbackPrices.delete('5904');
assert.throws(
  () => buildCandidate(
    [{ name: '上市', code: '2330', J: 2300, cheap: 0.476 }, { name: '官方缺檔', code: '5904', J: 60, cheap: 0.5 }],
    incompleteFallbackPrices,
    '2026-08-07'
  ),
  /coverage\/validation failed.*官方缺檔/,
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
assert.deepEqual(
  Object.fromEntries(['q1Period', 'q2Period', 'q3Period', 'q4Period'].map(key => [key, fundamentals.updated[0][key]])),
  { q1Period: '2025Q2', q2Period: '2025Q3', q3Period: '2025Q4', q4Period: '2026Q1' },
  'canonical EPS values must carry the four exact FinMind source quarters for index.html safety gate'
);
assert.throws(() => buildFundamentalsCandidate(fundamentalStocks, new Map([['2330', epsRows(eightDates.slice(1))]]), '2026-05-10'));
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

assert.throws(
  () => buildFundamentalsCandidate(
    [{ name: '舊期公司', code: '3333', type: 'stock' }, { name: '新期公司', code: '4444', type: 'stock' }],
    new Map([['3333', epsIncomeRevenue(fundamentalFixture.no_common_early)], ['4444', epsIncomeRevenue(fundamentalFixture.no_common_late)]]),
    '2026-07-29'
  ),
  /沒有共同完整8季EPS期末/
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

const [indexHtml, morningHtml] = await Promise.all([
  fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../morning.html', import.meta.url), 'utf8')
]);
assert.match(indexHtml, /最後完整資料照此日期計算，非即時報價/);
assert.match(indexHtml, /dataInsufficient = s\.epsInsufficient===true \|\| !hasFourEPS/);
assert.match(indexHtml, /const hasProv = !!s\.q1Period;/);
assert.match(indexHtml, /dataPending = !hasProv;/);
assert.match(indexHtml, /if\(dataPending\) M='資料待更新';/);
assert.doesNotMatch(indexHtml, /dataStale = !hasProv/);
assert.match(morningHtml, /meta\.state='snapshot';/);
assert.match(morningHtml, /資料截至 /);
assert.match(morningHtml, /predictionDisplayStatus\(pred\)/);
assert.match(morningHtml, /status==='overdue'\?'待結算'/);
assert.match(morningHtml, /if\(metaUsable\(meta\.index\)&&metaUsable\(meta\.margin\)/);
assert.doesNotMatch(morningHtml, /股價已過期|財報已過有效期限/);
console.log('FIXTURE TEST OK: official TWSE/TPEx parsing, ROC TPEx URL, FinMind TaiwanStockPrice same-day/lookback fallback with 59/59 gate, price/fundamental formulas, common-quarter alignment/rejection, last-complete snapshot carry-forward, safe FinMind token/retry, AA=0 preservation, atomic snapshot replacement, and dated snapshot UI policy');
