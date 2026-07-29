import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson, buildCandidate, buildFundamentalsCandidate, rowMap } from '../scripts/update-stock-pool.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/twse-closing-sample.json', import.meta.url), 'utf8'));
const prices = rowMap(fixture);
assert.equal(prices.get('2330'), 2300);
assert.equal(prices.get('0056'), 51.25);
assert.equal(prices.get('3556'), 64.2, 'TPEx 收盤 column must be accepted');
assert.equal(prices.has('1101'), false, 'non-price official placeholder must not be accepted');

const stocks = [{ name: '甲', code: '2330', J: 2300, cheap: 0.476 }, { name: '乙', code: '0056', J: 50.75, cheap: 0.71 }];
const next = buildCandidate(stocks, prices, '2026-07-29');
assert.equal(next.updated[0].cheap, 0.476);
assert.equal(next.updated[1].cheap, 0.703);
assert.equal(next.medCheap, 0.703);
assert.throws(() => buildCandidate(stocks, new Map([['2330', 2300]]), '2026-07-29'));

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
assert.equal(fundamentals.validUntil, '2026-05-15');
assert.throws(() => buildFundamentalsCandidate(fundamentalStocks, new Map([['2330', epsRows(eightDates.slice(1))]]), '2026-05-10'));
assert.throws(() => buildFundamentalsCandidate(fundamentalStocks, new Map([['2330', epsRows(eightDates)]]), '2026-05-16'));
const zeroIncome = epsRows(eightDates).map(row => row.type === 'IncomeAfterTaxes' ? { ...row, value: 0 } : row);
assert.equal(buildFundamentalsCandidate([{ ...fundamentalStocks[0], AA: 7 }], new Map([['2330', zeroIncome]]), '2026-05-10').updated[0].AA, 7, 'AA=0 must preserve existing value like computeJS');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-snapshot-test-'));
const snapshotFile = path.join(temp, 'stock-pool-snapshot.json');
await fs.writeFile(snapshotFile, '{"old":true}\n');
await assert.rejects(() => atomicWriteJson(snapshotFile, { next: true }, { failBeforeRename: true }));
assert.equal(await fs.readFile(snapshotFile, 'utf8'), '{"old":true}\n');
await atomicWriteJson(snapshotFile, { schemaVersion: 1, next: true });
assert.deepEqual(JSON.parse(await fs.readFile(snapshotFile, 'utf8')), { schemaVersion: 1, next: true });
console.log('FIXTURE TEST OK: official table parsing, price/fundamental formulas, AA=0 preservation, all-or-nothing coverage, and atomic snapshot replacement');
