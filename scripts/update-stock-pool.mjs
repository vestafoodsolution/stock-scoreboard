#!/usr/bin/env node
/*
 * Stock-pool snapshot updater.
 *
 * The fixed 59-member roster is always preserved.  Official source gaps are
 * filled from FinMind TaiwanStockPrice, but a snapshot is valid only when all
 * 59 members have a usable price for the requested date.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const INDEX_FILE = path.join(ROOT, 'index.html');
const MORNING_FILE = path.join(ROOT, 'morning.html');
const SNAPSHOT_FILE = path.join(ROOT, 'data', 'stock-pool-snapshot.json');
const args = new Set(process.argv.slice(2));
const dryRun = !args.has('--write');
const requestedDate = [...args].find(a => a.startsWith('--date='))?.slice(7) || taipeiDate();
const target = [...args].find(a => a.startsWith('--target='))?.slice(9) || 'price';
const cacheDirArg = [...args].find(a => a.startsWith('--cache-dir='))?.slice(12) || null;
export const FIXED_STOCK_CODES = Object.freeze('6669,5283,6112,8044,8454,2317,2454,2330,2303,2409,2912,1216,5904,2729,1268,2327,2492,3026,3556,2915,9945,1532,2855,6016,2002,1101,1102,1802,3008,2404,1305,2881,2603,2618,6176,2108,3260,6121,2357,3034,1301,1702,2890,0056,3702,5871,2727,1737,2886,1817,2748,2379,6005,6195,3078,1537,1227,2548,6581'.split(','));

function taipeiDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const clean = String(value ?? '').replace(/,/g, '').replace(/--|—/g, '').trim();
  const n = Number(clean);
  return clean !== '' && Number.isFinite(n) ? n : null;
}

function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : null; // matches index.html currentGauge()
}

function taipeiMinutes(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(part => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function assertPriceDateReady(date, now = new Date()) {
  if (date === taipeiDate(now) && taipeiMinutes(now) < 14 * 60) {
    throw new Error(`price date ${date} is not ready before the Taiwan market close`);
  }
}

function normalizedCode(stock) {
  const raw = typeof stock === 'string' ? stock : stock?.code;
  const code = String(raw ?? '').trim();
  return /^\d{4,6}$/.test(code) ? code.padStart(4, '0') : null;
}

export function validateUniverse(stocks, referenceStocks = FIXED_STOCK_CODES) {
  if (!Array.isArray(stocks) || !Array.isArray(referenceStocks)) throw new Error('stock universe mismatch: roster must be an array');
  const codes = stocks.map(normalizedCode);
  const expected = referenceStocks.map(normalizedCode);
  const unique = new Set(codes);
  const expectedUnique = new Set(expected);
  if (codes.includes(null) || expected.includes(null) || expectedUnique.size !== expected.length ||
      codes.length !== expected.length || unique.size !== expected.length || expected.some(code => !unique.has(code))) {
    throw new Error(`stock universe mismatch: expected ${expected.length} unique fixed members`);
  }
  return true;
}

function dataStatus(stock, patch = {}) {
  const current = stock.dataStatus || {};
  const status = {
    price: current.price || 'ok',
    fundamentals: current.fundamentals || (stock.type === 'etf' ? 'na' : 'ok'),
    cheap: current.cheap || (current.price === 'missing' ? 'missing' : 'ok'),
    medAK: current.medAK || (current.fundamentals === 'missing' ? 'missing' : (stock.type === 'etf' ? 'na' : 'ok')),
    ...patch
  };
  const excludedFrom = [];
  if (status.price === 'missing') excludedFrom.push('price');
  if (status.cheap === 'missing') excludedFrom.push('medCheap', 'score', 'signal');
  if (status.fundamentals === 'missing') excludedFrom.push('fundamentals');
  if (status.medAK === 'missing') excludedFrom.push('medAK', 'score', 'signal');
  status.excludedFrom = [...new Set(excludedFrom)];
  return status;
}

function parseEmbeddedJson(text, name, end = ';') {
  const start = text.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`${name} not found`);
  const from = start + `const ${name} = `.length;
  const to = text.indexOf(end, from);
  if (to < 0) throw new Error(`${name} terminator not found`);
  return { value: JSON.parse(text.slice(from, to)), start: from, end: to };
}

function parseBrief(text) {
  const match = text.match(/const BRIEF = \/\*DATA\*\/(.*?)\/\*END\*\//s);
  if (!match) throw new Error('BRIEF data block not found');
  return { value: JSON.parse(match[1]), start: match.index + 'const BRIEF = /*DATA*/'.length, end: match.index + match[0].length - '/*END*/'.length };
}

function replaceRange(text, range, serialized) {
  return text.slice(0, range.start) + serialized + text.slice(range.end);
}

export function rowMap(payload) {
  const result = new Map();
  const seen = new WeakSet();
  const visit = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const fields = node.fields || node.title || [];
    const rows = node.data || node.rows || [];
    if (Array.isArray(fields) && Array.isArray(rows)) {
      const codeIndex = fields.findIndex(x => /代號|證券代碼|股票代碼/.test(String(x)));
      // TWSE labels this 收盤價; TPEx currently labels it 收盤 in its OTC table.
      const closeIndex = fields.findIndex(x => /收盤價|收盤|Close/.test(String(x)));
      if (codeIndex >= 0 && closeIndex >= 0) {
        for (const row of rows) {
          const code = String(row[codeIndex] ?? '').trim();
          const close = num(row[closeIndex]);
          if (/^\d{4,6}$/.test(code) && close != null && close > 0) result.set(code.padStart(4, '0'), close);
        }
      }
    }
    Object.values(node).forEach(value => { if (value && typeof value === 'object') visit(value); });
  };
  visit(payload);
  return result;
}

function tpexRocDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || year < 1912) {
    throw new Error(`cannot convert invalid Gregorian date to TPEx ROC date: ${date}`);
  }
  return `${String(year - 1911).padStart(3, '0')}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

export function officialPriceUrls(date) {
  const compact = date.replaceAll('-', '');
  // TPEx's current official API requires an ROC-calendar date and type=EW
  // (all OTC securities excluding warrants).  A Gregorian date or omitted
  // type returns a successful but empty table, which must never look valid.
  const rocDate = tpexRocDate(date);
  return [
    `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${compact}&type=ALLBUT0999&response=json`,
    `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${encodeURIComponent(rocDate)}&type=EW&response=json`
  ];
}

async function officialPricesDetailed(date, { fetchImpl = fetch, tolerateErrors = false } = {}) {
  const urls = officialPriceUrls(date);
  const replies = await Promise.all(urls.map(async url => {
    try {
      const response = await fetchImpl(url, { headers: { 'user-agent': 'stock-scoreboard-snapshot/1.0' } });
      if (!response.ok) throw new Error(`official source HTTP ${response.status}`);
      return { prices: rowMap(await response.json()), error: null };
    } catch (error) {
      if (!tolerateErrors) throw error;
      return { prices: new Map(), error };
    }
  }));
  return {
    prices: new Map(replies.flatMap(reply => [...reply.prices])),
    errors: replies.filter(reply => reply.error).map(reply => reply.error.message)
  };
}

export async function officialPrices(date, options = {}) {
  return (await officialPricesDetailed(date, options)).prices;
}

const FINMIND_MAX_ATTEMPTS = 3;
const FINMIND_RETRY_DELAYS_MS = [1000, 2000];

function finMindDatasetUrl(dataset, code, start, end = null, token = process.env.FINMIND_TOKEN?.trim()) {
  const params = new URLSearchParams({ dataset, data_id: String(code), start_date: start });
  if (end) params.set('end_date', end);
  // The optional token is deliberately read only from the environment.  Never
  // log this URL: its query string may contain the credential.
  if (token) params.set('token', token);
  return `https://api.finmindtrade.com/api/v4/data?${params}`;
}

function finMindUrl(code, start, token) {
  return finMindDatasetUrl('TaiwanStockFinancialStatements', code, start, null, token);
}

function finMindPriceUrl(code, start, end = start, token) {
  return finMindDatasetUrl('TaiwanStockPrice', code, start, end, token);
}

async function fetchFinMindWithRetry(url, code, { fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; attempt <= FINMIND_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { 'user-agent': 'stock-scoreboard-snapshot/1.0' } });
    } catch {
      if (attempt === FINMIND_MAX_ATTEMPTS) throw new Error(`FinMind network error for ${code} after ${attempt} attempts`);
      await sleep(FINMIND_RETRY_DELAYS_MS[attempt - 1]);
      continue;
    }
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < FINMIND_MAX_ATTEMPTS) {
      await sleep(FINMIND_RETRY_DELAYS_MS[attempt - 1]);
      continue;
    }
    if (response.status === 429) throw new Error(`FinMind rate limit (HTTP 429) for ${code} after ${attempt} attempts`);
    if (response.status === 402) throw new Error(`FinMind 額度已用完（HTTP 402）for ${code}，約一小時後再試或設定 FINMIND_TOKEN`);
    if (response.status >= 500) throw new Error(`FinMind server error (HTTP ${response.status}) for ${code} after ${attempt} attempts`);
    throw new Error(`FinMind HTTP ${response.status} for ${code}`);
  }
  throw new Error(`FinMind request exhausted for ${code}`);
}

export async function finMindFundamentals(code, options = {}) {
  // Same dataset and field definitions used by index.html's existing computeJS().
  // A rate limit, schema change, or missing member fails the whole quarterly
  // run before any output is written.  FINMIND_TOKEN is optional and never
  // appears in output or errors.
  const start = options.start || `${new Date().getUTCFullYear() - 3}-01-01`;
  const url = finMindUrl(code, start);
  const response = await fetchFinMindWithRetry(url, code, options);
  const body = await response.json();
  if (body.status !== 200 || !Array.isArray(body.data)) throw new Error(`FinMind data unavailable for ${code}`);
  return body.data;
}

async function finMindPriceRecord(code, date, options = {}) {
  const start = options.start || date;
  const end = options.end || date;
  const url = finMindPriceUrl(code, start, end);
  const response = await fetchFinMindWithRetry(url, code, options);
  const body = await response.json();
  if (body.status !== 200 || !Array.isArray(body.data)) throw new Error(`FinMind price data unavailable for ${code}`);
  const rows = body.data
    .filter(item => String(item.date) === date && num(item.close) != null && num(item.close) > 0);
  const row = rows[0];
  const close = num(row?.close);
  if (close == null || close <= 0) throw new Error(`FinMind price missing for ${code} on ${date}`);
  return { close, asOf: String(row.date) };
}

export async function finMindPrice(code, date, options = {}) {
  // Only the exact requested trading date is valid; never relabel an older
  // close as the requested day's price.
  return (await finMindPriceRecord(code, date, options)).close;
}

export async function pricesWithFallback(stocks, date, options = {}) {
  const { fetchImpl = fetch, sleep, ...requestOptions } = options;
  assertPriceDateReady(date, options.now || new Date());
  const official = await officialPricesDetailed(date, { fetchImpl, tolerateErrors: true });
  const codes = [...new Set(stocks.map(stock => String(stock.code || '').padStart(4, '0')))].filter(code => /^\d{4,6}$/.test(code));
  const missing = codes.filter(code => !official.prices.has(code));
  const queue = [...missing];
  const fallback = new Map();
  const fallbackDates = new Map();
  const failures = [];
  const workerCount = Math.min(3, queue.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const code = queue.shift();
      try {
        const record = await finMindPriceRecord(code, date, { fetchImpl, sleep, ...requestOptions });
        fallback.set(code, record.close);
        fallbackDates.set(code, record.asOf);
      } catch (error) {
        failures.push(`${code}: ${error.message}`);
      }
    }
  }));
  const excludedCodes = missing.filter(code => !fallback.has(code));
  if (failures.length || excludedCodes.length) {
    const details = failures.length ? failures.join('; ') : excludedCodes.join(', ');
    throw new Error(`price coverage failed (${codes.length - excludedCodes.length}/${codes.length}): FinMind補檔失敗：${details}`);
  }
  return {
    prices: new Map([...official.prices, ...fallback]),
    officialErrors: official.errors,
    fallbackCodes: [...fallback.keys()],
    fallbackDates,
    excludedCodes,
    failures
  };
}

export function buildCandidate(stocks, prices, asOf, priceDates = new Map()) {
  const excludedCodes = [];
  const updated = stocks.map(original => {
    const code = normalizedCode(original);
    const close = prices.get(code);
    if (!code || close == null || close <= 0) {
      excludedCodes.push(code || String(original.code ?? ''));
      return { ...original, dataStatus: dataStatus(original, { price: 'missing', cheap: 'missing' }) };
    }
    // 收盤價是生效後的新基準，股利也要先換到同一基準再算殖利率與便宜度。
    const stock = adjustStoredPerShare(original, asOf);
    const { divYldEarn, divYldAll, cheap } = yieldFields(stock, close);
    return {
      ...stock,
      J: close,
      Jdate: priceDates.get(code) || asOf,
      divYldEarn,
      divYldAll,
      cheap,
      dataStatus: dataStatus(stock, { price: 'ok', cheap: cheap != null && divYldAll > 0 ? 'ok' : 'missing' })
    };
  });
  const covered = stocks.length - excludedCodes.length;
  if (excludedCodes.length) {
    const labels = excludedCodes.join(', ');
    throw new Error(`coverage/validation failed (${covered}/${stocks.length}): ${labels}`);
  }
  const { medCheap, cheapSampleSize } = cheapSummary(updated);
  if (medCheap == null) throw new Error('median cheapness missing after validation');
  return {
    updated,
    medCheap,
    covered,
    priceCovered: covered,
    cheapSampleSize,
    medCheapSample: cheapSampleSize,
    excludedCodes
  };
}

export function cheapSummary(stocks) {
  const values = stocks
    .filter(stock => !stock.dataStatus?.excludedFrom?.includes('medCheap') && num(stock.divYldAll) > 0)
    .map(stock => num(stock.cheap));
  const medCheap = median(values);
  return { medCheap: medCheap == null ? null : +medCheap.toFixed(3), cheapSampleSize: values.filter(Number.isFinite).length };
}

function validUntilFor(periodEnd) {
  const [year, month] = periodEnd.split('-').map(Number);
  // This records the next statutory reporting deadline for readers.  It is
  // not a deletion deadline: a later failed fetch must leave the last complete
  // financial snapshot available, clearly dated, rather than inventing newer
  // figures or replacing it with a partial result.
  if (month === 3) return `${year}-08-14`;
  if (month === 6) return `${year}-11-14`;
  if (month === 9) return `${year + 1}-03-31`;
  if (month === 12) return `${year + 1}-05-15`;
  return null;
}

// 面額／股數變更（分割、面額變更、大額股票股利）：生效日前的每股數字需除以
// factor，才能與生效後的收盤價、EPS 放在同一個每股基準比較。
// factor 一律取自官方公告的換股率或配股率，不用前後收盤價反推。
export const CORPORATE_ACTIONS = Object.freeze({
  // 國巨 2025-08-25 股票面額由 10 元變更為 2.5 元；每 1 股換發 4 股。
  '2327': [{ effectiveDate: '2025-08-25', factor: 4 }],
  // 寶雅 股票面額由 10 元變更為 1 元，每 1 股換發 10 股（流通股數 106,443,826 →
  // 1,064,438,260）。舊股最後交易日 2026-07-29，新股 2026-08-10 起恢復上櫃買賣。
  // 來源：公開資訊觀測站 2026-07-02 重大訊息「股票面額變更之換股作業計畫」；
  // 櫃買中心 115.06.24 證櫃監字第 1150004034 號函。
  '5904': [{ effectiveDate: '2026-08-10', factor: 10 }],
  // 緯穎 2025 年度盈餘轉增資，113 年度第一次海外可轉債轉換後，公司公告調整配股率為
  // 每千股配發 1,982.7946 股（2026-08-07 原公告 1,984.22578 股），2026-09-02 除權：
  // 每 1 舊股變 2.9827946 股。證交所除權除息計算結果表：除權前收盤 7,800、
  // 除權參考價 2,614.99（≈ 7,800 ÷ 2.9827946），每千股無償配股 1,982.8 股。
  '6669': [{ effectiveDate: '2026-09-02', factor: 2.9827946 }],
  // 瑞儀 現金減資 25%：每仟股換發 750 股、每股退還 2.5 元，舊股最後交易日 2026-08-12，
  // 換發新股 2026-08-24 上市買賣（證交所減資恢復買賣參考價 105.06）。factor < 1 代表股數變少：
  // 生效前的每股數字除以 0.75 才是新股基準。來源：公開資訊觀測站現金減資基準日與換股公告。
  '6176': [{ effectiveDate: '2026-08-24', factor: 0.75 }]
});

// 快照裡的股利（近一年、五年平均）不是每次重抓，而是從 index.html DEFAULT_DATA
// 一路帶下來，基準日就是 DEFAULT_DATA 的價格日；之後才生效的事件要在第一次
// 日更或季更時除以 factor 一次，並用 perShareBasis 記下已換算到哪一天，避免
// 重複除。四季 EPS 由季更從 FinMind 原始列重寫，基準跟著各季財報走：只有
// 期末早於生效日的那幾季（q{n}Period 標籤）才需要除；沒有標籤時才整批除。
export const STORED_PER_SHARE_BASELINE = '2026-07-17';
const STORED_DIVIDEND_FIELDS = Object.freeze(['div1', 'divEarn1', 'div5']);
const STORED_EPS_FIELDS = Object.freeze(['q1', 'q2', 'q3', 'q4']);

function actionsEffectiveBy(code, asOf) {
  // 已公告但尚未生效的事件不得提前套用，否則回補舊日期時會把舊基準價格
  // 配上新基準股利或 EPS。
  return (CORPORATE_ACTIONS[code] || []).filter(action => action.effectiveDate <= asOf);
}

function factorBefore(actions, periodEnd) {
  return actions.reduce((factor, action) => (periodEnd < action.effectiveDate ? factor * action.factor : factor), 1);
}

function corporateActionFactor(code, periodEnd, asOf) {
  return factorBefore(actionsEffectiveBy(code, asOf), periodEnd);
}

function quarterLabelEnd(label) {
  const match = String(label || '').match(/^(\d{4})Q([1-4])$/);
  return match ? `${match[1]}-${['03-31', '06-30', '09-30', '12-31'][Number(match[2]) - 1]}` : null;
}

function yieldFields(stock, close) {
  const divEarn = num(stock.divEarn1);
  const divAll = num(stock.div1);
  const averageYield = num(stock.avgYld5);
  return {
    divYldEarn: divEarn == null ? null : +(divEarn / close).toFixed(4),
    divYldAll: divAll == null ? null : +(divAll / close).toFixed(4),
    cheap: divAll != null && averageYield > 0 ? +((divAll / close) / averageYield).toFixed(3) : null
  };
}

export function adjustStoredPerShare(stock, asOf) {
  const code = normalizedCode(stock);
  let basis = STORED_PER_SHARE_BASELINE;
  if (stock.perShareBasis != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stock.perShareBasis)) throw new Error(`invalid perShareBasis for ${code}: ${JSON.stringify(stock.perShareBasis)}`);
    basis = stock.perShareBasis;
    // 每股數字已換到 basis 基準，不能再用更早日期的收盤價去配。
    if (asOf < basis) throw new Error(`cannot rebuild ${code} for ${asOf}: per-share figures are already on the ${basis} basis`);
  }
  const pending = actionsEffectiveBy(code, asOf).filter(action => action.effectiveDate > basis);
  if (!pending.length) return stock;
  const factor = pending.reduce((product, action) => product * action.factor, 1);
  const next = { ...stock, perShareBasis: asOf };
  for (const key of STORED_DIVIDEND_FIELDS) {
    const value = num(stock[key]);
    if (value != null) next[key] = +(value / factor).toFixed(3);
  }
  for (const key of STORED_EPS_FIELDS) {
    const value = num(stock[key]);
    if (value == null) continue;
    const periodEnd = quarterLabelEnd(stock[`${key}Period`]);
    const epsFactor = periodEnd ? factorBefore(pending, periodEnd) : factor;
    if (epsFactor !== 1) next[key] = +(value / epsFactor).toFixed(2);
  }
  // 快照裡的收盤價若已是生效後的價格，順手把股利率與便宜度換成新基準；
  // 否則留給下一次日更用當日收盤重算。
  const lastEffective = pending.map(action => action.effectiveDate).sort().at(-1);
  const close = num(stock.J);
  if (close > 0 && typeof stock.Jdate === 'string' && stock.Jdate >= lastEffective) Object.assign(next, yieldFields(next, close));
  return next;
}

function statementIndex(rows, code, asOf) {
  const byType = new Map();
  const validRows = rows.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && num(row.value) != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const row of validRows) {
    let entry = byType.get(row.type);
    if (!entry) {
      entry = { values: new Map(), conflicts: new Set() };
      byType.set(row.type, entry);
    }
    const rawValue = num(row.value);
    const value = row.type === 'EPS' ? rawValue / corporateActionFactor(code, row.date, asOf) : rawValue;
    if (entry.values.has(row.date) && entry.values.get(row.date) !== value) entry.conflicts.add(row.date);
    entry.values.set(row.date, value);
  }
  return byType;
}

function quarterEndsEndingAt(periodEnd, count = 8) {
  const match = String(periodEnd).match(/^(\d{4})-(03-31|06-30|09-30|12-31)$/);
  if (!match) return null;
  let year = Number(match[1]);
  let quarter = ['03-31', '06-30', '09-30', '12-31'].indexOf(match[2]);
  const periods = [];
  for (let i = 0; i < count; i += 1) {
    periods.push(`${year}-${['03-31', '06-30', '09-30', '12-31'][quarter]}`);
    quarter -= 1;
    if (quarter < 0) { quarter = 3; year -= 1; }
  }
  return periods.reverse();
}

function quarterLabel(periodEnd) {
  const match = String(periodEnd).match(/^(\d{4})-(03-31|06-30|09-30|12-31)$/);
  if (!match) throw new Error(`invalid quarterly period end: ${periodEnd}`);
  const quarter = ['03-31', '06-30', '09-30', '12-31'].indexOf(match[2]) + 1;
  return `${match[1]}Q${quarter}`;
}

function valuesByPeriod(index, type) {
  return index.get(type) || { values: new Map(), conflicts: new Set() };
}

function completePeriods(values, conflicts, count = 8) {
  const available = new Set();
  for (const periodEnd of values.keys()) {
    const periods = quarterEndsEndingAt(periodEnd, count);
    if (periods && periods.every(period => values.has(period) && !conflicts.has(period))) available.add(periodEnd);
  }
  return available;
}

function commonLatestPeriod(required, statementsByCode) {
  const availability = required.map(stock => {
    const code = normalizedCode(stock);
    const { values, conflicts } = valuesByPeriod(statementsByCode.get(code), 'EPS');
    return { code, periods: completePeriods(values, conflicts) };
  });
  const candidates = [...new Set(availability.flatMap(item => [...item.periods]))].map(periodEnd => ({
    periodEnd,
    includedCodes: availability.filter(item => item.periods.has(periodEnd)).map(item => item.code)
  })).sort((a, b) => b.includedCodes.length - a.includedCodes.length || b.periodEnd.localeCompare(a.periodEnd));
  if (!candidates.length || candidates[0].includedCodes.length === 0) throw new Error('no analyzable fundamental samples');
  const best = candidates[0];
  const includedCodes = new Set(best.includedCodes);
  return {
    periodEnd: best.periodEnd,
    includedCodes,
    excludedCodes: availability.filter(item => !includedCodes.has(item.code)).map(item => item.code)
  };
}

// This is intentionally the same EPS/AK definition as index.html computeJS:
// latest 4 EPS versus prior 4 EPS; AK is null where prior-period EPS <= 0.
export function buildFundamentalsCandidate(stocks, rowsByCode, asOf) {
  const required = stocks.filter(stock => stock.type !== 'etf');
  const statementsByCode = new Map(required.map(stock => {
    const code = normalizedCode(stock);
    return [code, statementIndex(rowsByCode.get(code) || [], code, asOf)];
  }));
  const selection = commonLatestPeriod(required, statementsByCode);
  const { periodEnd, includedCodes, excludedCodes } = selection;
  const periods = quarterEndsEndingAt(periodEnd);
  const latest4Periods = periods.slice(-4);
  const prior4Periods = periods.slice(0, 4);
  const updated = stocks.map(original => {
    // 季更也套同一份面額／股數調整：股利先換到新基準並記下 perShareBasis，
    // 之後的日更才不會再除一次；q1–q4 隨後由 FinMind 原始列重算覆蓋。
    const stock = adjustStoredPerShare(original, asOf);
    if (stock.type === 'etf') return { ...stock, dataStatus: dataStatus(stock, { fundamentals: 'na', medAK: 'na' }) };
    const code = normalizedCode(stock);
    if (!includedCodes.has(code)) return { ...stock, dataStatus: dataStatus(stock, { fundamentals: 'missing', medAK: 'missing' }) };
    const statements = statementsByCode.get(code);
    const eps = valuesByPeriod(statements, 'EPS');
    const prior = prior4Periods.reduce((sum, period) => sum + eps.values.get(period), 0);
    const current = latest4Periods.reduce((sum, period) => sum + eps.values.get(period), 0);
    const ak = prior > 0 ? +(current / prior - 1).toFixed(4) : null;
    // index.html's safety gate accepts a company only when its four EPS
    // values carry explicit source periods.  These labels come directly from
    // the selected common FinMind quarter window; do not infer dividend dates
    // here because TaiwanStockFinancialStatements does not provide them.
    const next = {
      ...stock,
      q1: +eps.values.get(latest4Periods[0]).toFixed(2), q1Period: quarterLabel(latest4Periods[0]),
      q2: +eps.values.get(latest4Periods[1]).toFixed(2), q2Period: quarterLabel(latest4Periods[1]),
      q3: +eps.values.get(latest4Periods[2]).toFixed(2), q3Period: quarterLabel(latest4Periods[2]),
      q4: +eps.values.get(latest4Periods[3]).toFixed(2), q4Period: quarterLabel(latest4Periods[3]),
      AK: ak,
      dataStatus: dataStatus(stock, { fundamentals: 'ok', medAK: ak == null ? 'missing' : 'ok' })
    };
    const income = valuesByPeriod(statements, 'IncomeAfterTaxes');
    const revenue = valuesByPeriod(statements, 'Revenue');
    // AA must use the same common four quarters as EPS.  If a financial
    // statement does not expose revenue, leave its existing AA untouched;
    // do not pull a newer, incompatible four-quarter window.
    if (latest4Periods.every(period => income.values.has(period) && revenue.values.has(period) && !income.conflicts.has(period) && !revenue.conflicts.has(period))) {
      const ni = latest4Periods.reduce((sum, period) => sum + income.values.get(period), 0);
      const rev = latest4Periods.reduce((sum, period) => sum + revenue.values.get(period), 0);
      // Keep index.html computeJS() semantics: a zero TTM net income does not
      // overwrite AA with a misleading 0; it remains unavailable/unchanged.
      if (ni && rev > 0) next.AA = +(ni / rev * 100).toFixed(2);
    }
    return next;
  });
  const validUntil = validUntilFor(periodEnd);
  if (!validUntil) throw new Error(`invalid financial period ${periodEnd}`);
  const medAKValues = updated.filter(stock => !stock.dataStatus?.excludedFrom?.includes('medAK')).map(stock => num(stock.AK));
  const medAK = median(medAKValues);
  if (medAK == null) throw new Error('EPS growth median missing after validation');
  const medAKSampleSize = medAKValues.filter(Number.isFinite).length;
  return {
    updated,
    medAK: +medAK.toFixed(4),
    medAKSample: medAKSampleSize,
    medAKSampleSize,
    periodEnd,
    validUntil,
    covered: includedCodes.size,
    fundamentalsCovered: includedCodes.size,
    eligible: required.length,
    excludedCodes,
    notApplicableCodes: stocks.filter(stock => stock.type === 'etf').map(normalizedCode)
  };
}

export async function atomicWriteJson(file, value, options = {}) {
  const temp = `${file}.snapshot-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, `${JSON.stringify(value)}\n`, 'utf8');
    if (options.failBeforeRename) throw new Error('simulated atomic snapshot failure');
    await fs.rename(temp, file); // Same-directory rename: readers see old or complete new JSON, never a partial file.
  } catch (error) {
    try { await fs.unlink(temp); } catch { /* absent after successful rename or failed staging */ }
    throw error;
  }
}

// ── 股利與風險欄位（每週更新）────────────────────────────────────────────
// 算法不在這裡另寫：直接執行 index.html 裡 STOCK-COMPUTE 標記之間的 computeJS，
// 網頁「完整更新」與快照因此永遠是同一套公式。
const DIVIDEND_FIELDS = Object.freeze(['div1', 'divEarn1', 'div5', 'divYears', 'avgYld5', 'mdd', 'vol', 'fillRate', 'fillN', 'fillDays']);
const DIVIDEND_DATE_FIELDS = Object.freeze(['exDate', 'lastBuyDate', 'payDate']);
export const CORPORATE_ACTION_CHECK_FROM = '2026-01-01';
const DAY_MS = 864e5;
const OFFICIAL_HEADERS = { headers: { 'user-agent': 'stock-scoreboard-snapshot/1.0' } };

export function loadPageCompute(indexText, asOf = null) {
  const begin = indexText.indexOf('// ==STOCK-COMPUTE-BEGIN==');
  const end = indexText.indexOf('// ==STOCK-COMPUTE-END==');
  if (begin < 0 || end < begin) throw new Error('index.html STOCK-COMPUTE block not found');
  const globals = {
    localStorage: { getItem: () => null },
    fetch: () => { throw new Error('page compute must not fetch'); }
  };
  if (asOf) {
    // 網頁的「現在」固定成計算日：caFactor 不換算計算日之後才生效的事件，回補舊日期也一樣。
    const fixedNow = asOfMillis(asOf);
    globals.Date = class extends Date { static now() { return fixedNow; } };
  }
  const context = vm.createContext(globals);
  vm.runInContext(`${indexText.slice(begin, end)}\n;globalThis.__pageCompute = { computeJS, caFactor, CORP_ACTIONS };`, context, { filename: 'index.html#STOCK-COMPUTE' });
  return context.__pageCompute;
}

function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function asOfMillis(date) {
  return Date.parse(`${date}T06:00:00Z`); // 台北 14:00，當日收盤後
}

function inDividendWindow(date, asOf) {
  return typeof date === 'string' && date > shiftDate(asOf, -365) && date <= asOf; // 與 computeJS 的 t-365 天 < 除息日 ≤ t 相同
}

function cashOf(row) {
  return (num(row.CashEarningsDistribution) || 0) + (num(row.CashStatutorySurplus) || 0);
}

function stockDividendOf(row) {
  return (num(row.StockEarningsDistribution) || 0) + (num(row.StockStatutorySurplus) || 0);
}

async function finMindRows(dataset, code, start, end, options = {}) {
  const response = await fetchFinMindWithRetry(finMindDatasetUrl(dataset, code, start, end), code, options);
  const body = await response.json();
  if (body.status !== 200 || !Array.isArray(body.data)) throw new Error(`FinMind ${dataset} unavailable for ${code}`);
  return body.data;
}

export async function fetchDividendInputs(codes, asOf, { cacheDir = null, fetchImpl = fetch, sleep } = {}) {
  // 每檔兩次 FinMind 呼叫。免 token 額度用完時停止，已抓的存在 cacheDir，同一日期重跑會接著抓。
  const inputs = new Map();
  const failures = [];
  const queue = [...codes];
  const dir = cacheDir ? path.join(cacheDir, asOf) : null;
  if (dir) await fs.mkdir(dir, { recursive: true });
  let stop = false;
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length && !stop) {
      const code = queue.shift();
      const file = dir ? path.join(dir, `${code}.json`) : null;
      try {
        if (file) {
          try { inputs.set(code, JSON.parse(await fs.readFile(file, 'utf8'))); continue; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const [prices, dividends] = await Promise.all([
          finMindRows('TaiwanStockPrice', code, shiftDate(asOf, -(365 * 7 + 30)), asOf, { fetchImpl, sleep }),
          finMindRows('TaiwanStockDividend', code, shiftDate(asOf, -365 * 12), null, { fetchImpl, sleep })
        ]);
        const input = { asOf, pr: prices.map(row => ({ date: String(row.date), close: num(row.close) })).filter(row => row.close > 0), dv: dividends };
        const lastDate = input.pr.filter(row => row.date <= asOf).at(-1)?.date;
        if (lastDate !== asOf) throw new Error(`FinMind 還沒有 ${asOf} 的股價（最後 ${lastDate ?? '無'}），不存快取，晚點再跑`);
        inputs.set(code, input);
        if (file) await fs.writeFile(file, JSON.stringify(input), 'utf8');
      } catch (error) {
        failures.push(`${code}: ${error.message}`);
        stop = true;
      }
    }
  }));
  if (failures.length || inputs.size !== codes.length) {
    const hint = dir ? `；已存 ${inputs.size}/${codes.length} 檔於 ${dir}，用同一個 --cache-dir 重跑會接著抓` : '';
    throw new Error(`dividend inputs incomplete (${inputs.size}/${codes.length}): ${failures.join('; ')}${hint}`);
  }
  return inputs;
}

export function buildDividendCandidate(stocks, inputs, asOf, compute) {
  const asOfMs = asOfMillis(asOf);
  const guardedCodes = [];
  const changedCodes = [];
  const updated = stocks.map(original => {
    const code = normalizedCode(original);
    const input = inputs.get(code);
    if (!input) throw new Error(`dividend input missing for ${code}`);
    const close = num(original.J);
    if (original.Jdate !== asOf || !(close > 0)) throw new Error(`${code} 股價日期是 ${original.Jdate}，不是 ${asOf}；要先跑同一天的股價更新`);
    const prices = input.pr.filter(row => row.date <= asOf);
    if (prices.at(-1)?.date !== asOf) throw new Error(`FinMind price for ${code} ends at ${prices.at(-1)?.date ?? 'none'}, expected ${asOf}`);
    if (!Array.isArray(input.dv) || !input.dv.length) throw new Error(`FinMind dividend history empty for ${code}`);
    const o = compute.computeJS(prices, input.dv, [], [], code, asOfMs);
    // 先把其他每股數字（四季 EPS）換到現行基準，再換上新算的股利；之後記下基準日，避免重複換算。
    const next = { ...adjustStoredPerShare(original, asOf), perShareBasis: asOf };
    for (const key of DIVIDEND_FIELDS) next[key] = o[key] ?? null;
    if (o.div1 == null) { next.div1 = 0; next.divEarn1 = 0; }
    for (const key of DIVIDEND_DATE_FIELDS) { if (o[key]) next[key] = o[key]; else delete next[key]; }
    const sameClose = Number.isFinite(o.J) && Math.abs(o.J - close) < 0.005;
    Object.assign(next, sameClose && o.cheap != null ? { divYldEarn: o.divYldEarn, divYldAll: o.divYldAll, cheap: o.cheap } : yieldFields(next, close));
    if (next.div1 === 0) Object.assign(next, { divYldEarn: 0, divYldAll: 0, cheap: next.avgYld5 > 0 ? 0 : null });
    const plainWindow = input.dv
      .filter(row => inDividendWindow(row.CashExDividendTradingDate, asOf) && cashOf(row) > 0)
      .reduce((sum, row) => sum + cashOf(row) / compute.caFactor(code, row.CashExDividendTradingDate), 0);
    if (Math.abs(plainWindow - next.div1) > 0.0015) guardedCodes.push(code);
    if (num(original.div1) !== next.div1 || num(original.cheap) !== next.cheap) changedCodes.push(code);
    next.dataStatus = dataStatus(next, { cheap: next.cheap != null && next.divYldAll > 0 ? 'ok' : 'missing' });
    return next;
  });
  return { updated, guardedCodes, changedCodes, ...cheapSummary(updated) };
}

export function officialDividendUrls(asOf) {
  const start = shiftDate(asOf, -364);
  return {
    twse: `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${start.replaceAll('-', '')}&endDate=${asOf.replaceAll('-', '')}&response=json`,
    tpex: `https://www.tpex.org.tw/web/stock/exright/dailyquo/exDailyQ_result.php?l=zh-tw&d=${encodeURIComponent(tpexRocDate(start))}&ed=${encodeURIComponent(tpexRocDate(asOf))}&o=json`,
    reductions: `https://www.twse.com.tw/rwd/zh/reducation/TWTAUU?startDate=${CORPORATE_ACTION_CHECK_FROM.replaceAll('-', '')}&endDate=${asOf.replaceAll('-', '')}&response=json`,
    tpexReductions: `https://www.tpex.org.tw/www/zh-tw/bulletin/revivt?startDate=${CORPORATE_ACTION_CHECK_FROM.replaceAll('-', '/')}&endDate=${asOf.replaceAll('-', '/')}&response=json`
  };
}

function officialIsoDate(text) {
  const compact = String(text ?? '').trim().match(/^(\d{3})(\d{2})(\d{2})$/); // 櫃買中心 1150112＝民國 115 年 1 月 12 日
  if (compact) return `${Number(compact[1]) + 1911}-${compact[2]}-${compact[3]}`;
  const m = String(text ?? '').match(/(\d{2,4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const year = Number(m[1]) < 1000 ? Number(m[1]) + 1911 : Number(m[1]);
  return `${year}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function fieldIndex(fields, name) {
  const index = (fields || []).findIndex(field => String(field).trim() === name);
  if (index < 0) throw new Error(`official table field missing: ${name}`);
  return index;
}

export function parseOfficialDividendEvents({ twse, tpex }) {
  // 現金股利依除息日分組。證交所「權息」列只給權值＋息值合計，拆不出現金，金額記為 null（只核對日期）。
  const events = new Map();
  const add = (code, event) => { if (!events.has(code)) events.set(code, []); events.get(code).push(event); };
  if (twse?.stat !== 'OK' || !Array.isArray(twse.data)) throw new Error('證交所除權息資料無法取得');
  const tw = { date: fieldIndex(twse.fields, '資料日期'), code: fieldIndex(twse.fields, '股票代號'), kind: fieldIndex(twse.fields, '權/息'), value: fieldIndex(twse.fields, '權值+息值') };
  for (const row of twse.data) {
    const kind = String(row[tw.kind] ?? '').trim();
    if (kind === '權') continue;
    add(String(row[tw.code]).trim(), { date: officialIsoDate(row[tw.date]), cash: kind === '息' ? num(row[tw.value]) : null, source: 'TWSE' });
  }
  const table = tpex?.tables?.[0];
  if (!table || !Array.isArray(table.data)) throw new Error('櫃買中心除權息資料無法取得');
  const tp = { date: fieldIndex(table.fields, '除權息日期'), code: fieldIndex(table.fields, '代號'), cash: fieldIndex(table.fields, '現金股利') };
  for (const row of table.data) {
    const cash = num(row[tp.cash]);
    if (cash > 0) add(String(row[tp.code]).trim(), { date: officialIsoDate(row[tp.date]), cash, source: 'TPEx' });
  }
  return events;
}

export function compareOfficialDividends(stocks, inputs, official, asOf) {
  const mismatches = [];
  const mixedCodes = [];
  let matched = 0;
  for (const stock of stocks) {
    const code = normalizedCode(stock);
    const mine = new Map();
    for (const row of inputs.get(code)?.dv || []) {
      if (inDividendWindow(row.CashExDividendTradingDate, asOf) && cashOf(row) > 0) mine.set(row.CashExDividendTradingDate, (mine.get(row.CashExDividendTradingDate) || 0) + cashOf(row));
    }
    const theirs = (official.get(code) || []).filter(event => inDividendWindow(event.date, asOf));
    const mineDates = [...mine.keys()].sort().join(',');
    const theirDates = [...new Set(theirs.map(event => event.date))].sort().join(',');
    if (mineDates !== theirDates) { mismatches.push(`${code} 除息日 FinMind[${mineDates}] 官方[${theirDates}]`); continue; }
    const wrong = theirs.filter(event => event.cash != null && Math.abs(event.cash - mine.get(event.date)) > Math.max(0.01, event.cash * 0.005));
    if (wrong.length) { mismatches.push(`${code} 金額 ${wrong.map(event => `${event.date} FinMind ${+mine.get(event.date).toFixed(4)} 官方 ${event.cash}`).join('、')}`); continue; }
    if (theirs.some(event => event.cash == null)) mixedCodes.push(code);
    else matched += 1;
  }
  return { matched, mixedCodes, mismatches };
}

export function parseOfficialReductions(payload) {
  // 證交所 TWTAUU：{stat, fields, data}；櫃買中心 revivt：{tables:[{fields, data}]}。兩者欄名相同。
  const table = Array.isArray(payload?.tables) ? payload.tables[0] : payload;
  if (!Array.isArray(payload?.tables) && payload?.stat !== 'OK') {
    if (/沒有符合條件/.test(String(payload?.stat ?? ''))) return [];
    throw new Error('證交所減資資料無法取得');
  }
  if (!table || !Array.isArray(table.data)) throw new Error('櫃買中心減資資料無法取得');
  if (!table.data.length) return [];
  const idx = { date: fieldIndex(table.fields, '恢復買賣日期'), code: fieldIndex(table.fields, '股票代號') };
  return table.data.map(row => ({ date: officialIsoDate(row[idx.date]), code: String(row[idx.code]).trim() }));
}

export function corporateActionFindings(stocks, inputs, reductions, compute, asOf, from = CORPORATE_ACTION_CHECK_FROM) {
  // 兩道檢查：(1) 證交所減資表裡有、但兩張分割表沒登錄的事件；(2) 扣除除息與配股後，
  // 單日漲跌仍超過 10.5%（台股漲跌幅上限 10%）的價格，通常代表沒登錄的分割、減資或面額變更。
  const findings = [];
  const codes = new Set(stocks.map(normalizedCode));
  for (const { code, date } of reductions) {
    if (codes.has(code) && date >= from && !(CORPORATE_ACTIONS[code] || []).some(action => action.effectiveDate === date)) findings.push(`${code} ${date} 官方減資未登錄`);
  }
  for (const stock of stocks) {
    const code = normalizedCode(stock);
    const input = inputs.get(code);
    const rows = (input?.pr || []).filter(row => row.date >= from && row.date <= asOf);
    const cash = new Map();
    const stockDiv = new Map();
    for (const row of input?.dv || []) {
      if (row.CashExDividendTradingDate) cash.set(row.CashExDividendTradingDate, (cash.get(row.CashExDividendTradingDate) || 0) + cashOf(row));
      if (row.StockExDividendTradingDate) stockDiv.set(row.StockExDividendTradingDate, (stockDiv.get(row.StockExDividendTradingDate) || 0) + stockDividendOf(row));
    }
    for (let i = 1; i < rows.length; i += 1) {
      const before = rows[i - 1];
      const after = rows[i];
      const fBefore = compute.caFactor(code, before.date);
      const fAfter = compute.caFactor(code, after.date);
      const between = date => date > before.date && date <= after.date; // 除息日可能落在休市日（如颱風假），要算到下一個交易日
      const registered = (CORPORATE_ACTIONS[code] || []).some(action => between(action.effectiveDate));
      const cashBetween = [...cash].filter(([date]) => between(date)).reduce((sum, [, value]) => sum + value, 0);
      const stockBetween = registered ? 0 : [...stockDiv].filter(([date]) => between(date)).reduce((sum, [, value]) => sum + value, 0);
      const reference = (before.close / fBefore - cashBetween / fAfter) / (1 + stockBetween / 10);
      const change = (after.close / fAfter) / reference - 1;
      if (Math.abs(change) > 0.105) findings.push(`${code} ${after.date} 單日 ${(change * 100).toFixed(1)}%`);
    }
  }
  return findings;
}

async function fetchOfficialJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, OFFICIAL_HEADERS);
  if (!response.ok) throw new Error(`official source HTTP ${response.status}`);
  return response.json();
}

export async function dividendUpdate(stocks, asOf, indexText, { cacheDir = null, fetchImpl = fetch, sleep } = {}) {
  const compute = loadPageCompute(indexText, asOf);
  const codes = stocks.map(normalizedCode);
  const urls = officialDividendUrls(asOf);
  const [twse, tpex, twseReductions, tpexReductions] = await Promise.all([urls.twse, urls.tpex, urls.reductions, urls.tpexReductions].map(url => fetchOfficialJson(url, fetchImpl)));
  const official = parseOfficialDividendEvents({ twse, tpex });
  const reductions = [...parseOfficialReductions(twseReductions), ...parseOfficialReductions(tpexReductions)];
  const inputs = await fetchDividendInputs(codes, asOf, { cacheDir, fetchImpl, sleep });
  const check = compareOfficialDividends(stocks, inputs, official, asOf);
  if (check.mismatches.length) throw new Error(`官方股利核對不一致（${check.mismatches.length} 檔），不寫入：${check.mismatches.join('；')}`);
  const findings = corporateActionFindings(stocks, inputs, reductions, compute, asOf);
  if (findings.length) throw new Error(`發現未登錄的股數變更，不寫入：${findings.join('；')}`);
  const candidate = buildDividendCandidate(stocks, inputs, asOf, compute);
  return { ...candidate, check, reductionsChecked: reductions.length, windowStart: shiftDate(asOf, -364) };
}

function fundamentalsFrom(brief) {
  const old = brief.sourceMeta?.stockPool?.fundamentals;
  if (old) return old; // Never manufacture dates or a quarterly update.
  return {
    source: '既有股票池財報／EPS快照（尚未建立可驗證季度 metadata）',
    asOf: null, periodEnd: null, validUntil: null
  };
}

async function main() {
  if (args.has('--self-test')) return selfTest();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) throw new Error('--date must be YYYY-MM-DD');
  if (!['price', 'dividends', 'fundamentals', 'both', 'weekly'].includes(target)) throw new Error('--target must be price, dividends, fundamentals, both, or weekly');
  const doPrice = ['price', 'both', 'weekly'].includes(target);
  const doDividends = ['dividends', 'weekly'].includes(target);
  const doFundamentals = ['fundamentals', 'both', 'weekly'].includes(target);
  const [indexText, morningText] = await Promise.all([fs.readFile(INDEX_FILE, 'utf8'), fs.readFile(MORNING_FILE, 'utf8')]);
  const data = parseEmbeddedJson(indexText, 'DEFAULT_DATA');
  const brief = parseBrief(morningText);
  validateUniverse(data.value);
  let existingSnapshot = null;
  try {
    const candidate = JSON.parse(await fs.readFile(SNAPSHOT_FILE, 'utf8'));
    if (candidate?.schemaVersion === 1 && Array.isArray(candidate.stocks)) {
      validateUniverse(candidate.stocks);
      existingSnapshot = candidate;
    }
    else throw new Error('schema or stock count mismatch');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`invalid canonical snapshot: ${error.message}`);
  }
  let stocks = existingSnapshot?.stocks || data.value;
  let priceMeta = existingSnapshot?.price || brief.value.sourceMeta?.stockPool?.price;
  let fundamentals = existingSnapshot?.fundamentals || fundamentalsFrom(brief.value);
  let dividends = existingSnapshot?.dividends || null;
  if ((target === 'fundamentals') && !priceMeta) throw new Error('fundamentals-only update requires an existing canonical price snapshot; run --target=price or --target=both first');
  if (doPrice) {
    const priceResult = await pricesWithFallback(stocks, requestedDate);
    const candidate = buildCandidate(stocks, priceResult.prices, requestedDate, priceResult.fallbackDates);
    if (candidate.covered !== stocks.length || candidate.excludedCodes.length !== 0) {
      throw new Error(`price coverage gate failed (${candidate.covered}/${stocks.length}); refusing to write snapshot`);
    }
    stocks = candidate.updated;
    const fallbackUsed = priceResult.fallbackCodes.length > 0;
    priceMeta = {
      source: fallbackUsed ? 'TWSE／TPEx 官方日收盤資料；缺檔由 FinMind TaiwanStockPrice 補齊' : 'TWSE／TPEx 官方日收盤資料',
      asOf: requestedDate,
      fetchedAt: new Date().toISOString(),
      coverage: `${candidate.covered}/${stocks.length}`,
      priceCoverage: `${candidate.priceCovered}/${stocks.length}`,
      officialCoverage: `${candidate.covered - priceResult.fallbackCodes.length}/${stocks.length}`,
      fallbackCoverage: `${priceResult.fallbackCodes.length}/${stocks.length}`,
      fallbackCodes: priceResult.fallbackCodes,
      fallbackAsOf: Object.fromEntries(priceResult.fallbackDates),
      excludedCodes: candidate.excludedCodes,
      failures: priceResult.failures,
      officialErrors: priceResult.officialErrors,
      medCheap: candidate.medCheap,
      medCheapSample: candidate.medCheapSample,
      cheapSampleSize: candidate.cheapSampleSize,
      method: '依當日收盤價重算股利率與便宜度；僅在 59/59 價格完整覆蓋時寫入'
    };
  }
  if (doDividends) {
    if (!doPrice && priceMeta?.asOf !== requestedDate) throw new Error(`股利更新需要 ${requestedDate} 的股價快照（目前 ${priceMeta?.asOf ?? '無'}）；請改用 --target=weekly`);
    const result = await dividendUpdate(stocks, requestedDate, indexText, { cacheDir: cacheDirArg });
    stocks = result.updated;
    priceMeta = { ...priceMeta, medCheap: result.medCheap, medCheapSample: result.cheapSampleSize, cheapSampleSize: result.cheapSampleSize };
    dividends = {
      source: 'FinMind TaiwanStockPrice＋TaiwanStockDividend（算法同 index.html computeJS）',
      asOf: requestedDate,
      fetchedAt: new Date().toISOString(),
      coverage: `${stocks.length}/${stocks.length}`,
      officialCheck: { source: '證交所 TWT49U、櫃買中心除權息', from: result.windowStart, to: requestedDate, matched: result.check.matched, cashAndStockCombined: result.check.mixedCodes },
      corporateActionCheck: { source: '證交所 TWTAUU、櫃買中心減資恢復買賣', from: CORPORATE_ACTION_CHECK_FROM, officialReductions: result.reductionsChecked, unregistered: 0 },
      guardedCodes: result.guardedCodes,
      changedCodes: result.changedCodes,
      method: '近一年現金股利與五年平均殖利率都只算最近一次除息往前 300 天內的配息（18 個月內配過不算 0）；另含回撤、波動、填息率；官方核對 59/59 且無未登錄股數變更才寫入'
    };
  }
  if (doFundamentals) {
    const rowsByCode = new Map();
    const required = stocks.filter(stock => stock.type !== 'etf');
    const queue = [...required];
    const failures = [];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const stock = queue.shift();
        const code = String(stock.code).padStart(4, '0');
        // 有 --cache-dir 時財報原始列也存起來：乾跑與正式寫入用同一份，不重抓、不多耗 FinMind 額度。
        const cacheFile = cacheDirArg ? path.join(cacheDirArg, requestedDate, `fundamentals-${code}.json`) : null;
        try {
          let rows = null;
          if (cacheFile) { try { rows = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
          if (!rows) {
            rows = await finMindFundamentals(code);
            if (cacheFile) { await fs.mkdir(path.dirname(cacheFile), { recursive: true }); await fs.writeFile(cacheFile, JSON.stringify(rows), 'utf8'); }
          }
          rowsByCode.set(code, rows);
        }
        catch (error) { rowsByCode.set(code, []); failures.push(`${code}: ${error.message}`); }
      }
    }));
    const quota = failures.find(failure => /HTTP 402/.test(failure));
    if (quota) throw new Error(`財報抓取中斷，不寫入：${quota}`);
    // 每週更新不接受任何一檔財報抓取失敗（網路錯誤、429、5xx 等），整批不寫入，下週或重跑時再補。
    if (target === 'weekly' && failures.length) throw new Error(`財報抓取失敗 ${failures.length} 檔，不寫入：${failures.slice(0, 3).join('；')}`);
    const candidate = buildFundamentalsCandidate(stocks, rowsByCode, requestedDate);
    stocks = candidate.updated;
    fundamentals = {
      source: 'FinMind TaiwanStockFinancialStatements',
      asOf: requestedDate,
      periodEnd: candidate.periodEnd,
      validUntil: candidate.validUntil,
      coverage: `${candidate.covered}/${candidate.eligible}`,
      fundamentalsCoverage: `${candidate.fundamentalsCovered}/${candidate.eligible}`,
      excludedCodes: candidate.excludedCodes,
      notApplicableCodes: candidate.notApplicableCodes,
      failures,
      medAK: candidate.medAK,
      medAKSample: candidate.medAKSample,
      medAKSampleSize: candidate.medAKSampleSize,
      method: '近4季 EPS 合計 ÷ 前4季 EPS 合計 − 1；缺少完整8季者不納入中位數、評分與訊號（前4季合計≤0不納入中位數）'
    };
    if (target === 'fundamentals' && priceMeta) {
      // 面額／股數調整可能在季更時重算了個股便宜度，中繼資料的中位數要跟上。
      const summary = cheapSummary(stocks);
      if (summary.medCheap != null) priceMeta = { ...priceMeta, medCheap: summary.medCheap, medCheapSample: summary.cheapSampleSize, cheapSampleSize: summary.cheapSampleSize };
    }
  }
  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    price: priceMeta,
    fundamentals,
    ...(dividends ? { dividends } : {}),
    stocks
  };
  if (dryRun) {
    console.log(`DRY RUN OK: target=${target}, stocks=${stocks.length}, date=${requestedDate}`);
    if (doPrice) console.log(`PRICE: coverage=${priceMeta.coverage}, cheapSampleSize=${priceMeta.cheapSampleSize}, medCheap=${priceMeta.medCheap}`);
    if (doDividends) console.log(`DIVIDENDS: coverage=${dividends.coverage}, officialMatched=${dividends.officialCheck.matched}, cashAndStockCombined=${dividends.officialCheck.cashAndStockCombined.join('|') || '-'}, guarded=${dividends.guardedCodes.join('|') || '-'}, changed=${dividends.changedCodes.length}, medCheap=${priceMeta.medCheap}`);
    if (doFundamentals) console.log(`FUNDAMENTALS: coverage=${fundamentals.coverage}, medAKSampleSize=${fundamentals.medAKSampleSize}, periodEnd=${fundamentals.periodEnd}, validUntil=${fundamentals.validUntil}, medAK=${fundamentals.medAK}`);
    console.log('No files were changed. Re-run with --write only after reviewing this output.');
    return;
  }
  await atomicWriteJson(SNAPSHOT_FILE, snapshot, { failBeforeRename: args.has('--simulate-write-failure') });
  console.log(`WROTE ATOMIC SNAPSHOT: ${path.relative(ROOT, SNAPSHOT_FILE)}, target=${target}, stocks=${stocks.length}, date=${requestedDate}`);
}

function selfTest() {
  const stocks = [
    { name: '甲', code: '0001', J: 100, divEarn1: 8, div1: 8, avgYld5: 0.1 },
    { name: '乙', code: '0002', J: 200, divEarn1: 10, div1: 10, avgYld5: 0.1 }
  ];
  const ok = buildCandidate(stocks, new Map([['0001', 80], ['0002', 250]]), '2026-07-29');
  if (ok.updated[0].cheap !== 1 || ok.updated[1].cheap !== 0.4 || ok.medCheap !== 1) throw new Error('price/yield/cheapness calculation test failed');
  let rejected = false;
  try { buildCandidate(stocks, new Map([['0001', 80]]), '2026-07-29'); } catch (error) {
    rejected = /coverage\/validation failed \(1\/2\)/.test(error.message);
  }
  if (!rejected) throw new Error('partial price coverage must fail');
  // 面額／股數變更：生效前基準的股利除以 factor 一次，再跑一次不得重複除。
  const split = { name: '丙', code: '5904', J: 720, Jdate: '2026-07-29', div1: 23, divEarn1: 23, div5: 24.62, avgYld5: 0.0593, q1: 7.59, q2: 8.98, q3: 9.3, q4: 8.15 };
  const once = buildCandidate([split], new Map([['5904', 72.7]]), '2026-11-03').updated[0];
  const twice = buildCandidate([once], new Map([['5904', 72.7]]), '2026-11-04').updated[0];
  if (once.div1 !== 2.3 || once.div5 !== 2.462 || once.q4 !== 0.82 || once.cheap !== 0.534 || once.perShareBasis !== '2026-11-03') throw new Error('corporate action per-share adjustment test failed');
  if (twice.div1 !== 2.3 || twice.cheap !== 0.534) throw new Error('corporate action adjustment must not be applied twice');
  const yageo = buildCandidate([{ name: '丁', code: '2327', J: 617, Jdate: '2026-08-11', div1: 5.999, avgYld5: 0.0445 }], new Map([['2327', 617]]), '2026-11-03').updated[0];
  if (yageo.div1 !== 5.999 || yageo.perShareBasis !== undefined) throw new Error('actions before the stored baseline must not be reapplied');
  console.log('SELF-TEST OK: recomputation, full-coverage gate, partial-coverage rejection, and corporate-action basis adjustment');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Snapshot update stopped: ${error.message}`); process.exitCode = 1; });
}
