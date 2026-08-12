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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const INDEX_FILE = path.join(ROOT, 'index.html');
const MORNING_FILE = path.join(ROOT, 'morning.html');
const SNAPSHOT_FILE = path.join(ROOT, 'data', 'stock-pool-snapshot.json');
const args = new Set(process.argv.slice(2));
const dryRun = !args.has('--write');
const requestedDate = [...args].find(a => a.startsWith('--date='))?.slice(7) || taipeiDate();
const target = [...args].find(a => a.startsWith('--target='))?.slice(9) || 'price';
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

function finMindUrl(code, start, token = process.env.FINMIND_TOKEN?.trim()) {
  const params = new URLSearchParams({
    dataset: 'TaiwanStockFinancialStatements',
    data_id: String(code),
    start_date: start
  });
  // The optional token is deliberately read only from the environment.  Never
  // log this URL: its query string may contain the credential.
  if (token) params.set('token', token);
  return `https://api.finmindtrade.com/api/v4/data?${params}`;
}

function finMindPriceUrl(code, start, end = start, token = process.env.FINMIND_TOKEN?.trim()) {
  const params = new URLSearchParams({
    dataset: 'TaiwanStockPrice',
    data_id: String(code),
    start_date: start,
    end_date: end
  });
  // The optional token is deliberately read only from the environment.  Never
  // log this URL: its query string may contain the credential.
  if (token) params.set('token', token);
  return `https://api.finmindtrade.com/api/v4/data?${params}`;
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
  const updated = stocks.map(stock => {
    const code = normalizedCode(stock);
    const close = prices.get(code);
    if (!code || close == null || close <= 0) {
      excludedCodes.push(code || String(stock.code ?? ''));
      return { ...stock, dataStatus: dataStatus(stock, { price: 'missing', cheap: 'missing' }) };
    }
    const divEarn = num(stock.divEarn1);
    const divAll = num(stock.div1);
    const averageYield = num(stock.avgYld5);
    const divYldEarn = divEarn == null ? null : +(divEarn / close).toFixed(4);
    const divYldAll = divAll == null ? null : +(divAll / close).toFixed(4);
    const cheap = divAll != null && averageYield > 0 ? +((divAll / close) / averageYield).toFixed(3) : null;
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
  const medCheapValues = updated
    .filter(stock => !stock.dataStatus?.excludedFrom?.includes('medCheap') && num(stock.divYldAll) > 0)
    .map(stock => num(stock.cheap));
  const medCheap = median(medCheapValues);
  if (medCheap == null) throw new Error('median cheapness missing after validation');
  const cheapSampleSize = medCheapValues.filter(Number.isFinite).length;
  return {
    updated,
    medCheap: +medCheap.toFixed(3),
    covered,
    priceCovered: covered,
    cheapSampleSize,
    medCheapSample: cheapSampleSize,
    excludedCodes
  };
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

const CORPORATE_ACTIONS = {
  // 國巨 2025-08-25 股票面額由 10 元變更為 2.5 元；變更前每股數字需除以 4
  // 才能與變更後 EPS 放在同一個每股基準比較。
  '2327': [{ effectiveDate: '2025-08-25', factor: 4 }]
};

function corporateActionFactor(code, periodEnd) {
  return (CORPORATE_ACTIONS[code] || []).reduce((factor, action) => (
    periodEnd < action.effectiveDate ? factor * action.factor : factor
  ), 1);
}

function statementIndex(rows, code) {
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
    const value = row.type === 'EPS' ? rawValue / corporateActionFactor(code, row.date) : rawValue;
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
    return [code, statementIndex(rowsByCode.get(code) || [], code)];
  }));
  const selection = commonLatestPeriod(required, statementsByCode);
  const { periodEnd, includedCodes, excludedCodes } = selection;
  const periods = quarterEndsEndingAt(periodEnd);
  const latest4Periods = periods.slice(-4);
  const prior4Periods = periods.slice(0, 4);
  const updated = stocks.map(stock => {
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
  if (!['price', 'fundamentals', 'both'].includes(target)) throw new Error('--target must be price, fundamentals, or both');
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
  if ((target === 'fundamentals') && !priceMeta) throw new Error('fundamentals-only update requires an existing canonical price snapshot; run --target=price or --target=both first');
  if (target === 'price' || target === 'both') {
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
  if (target === 'fundamentals' || target === 'both') {
    const rowsByCode = new Map();
    const required = stocks.filter(stock => stock.type !== 'etf');
    const queue = [...required];
    const failures = [];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const stock = queue.shift();
        const code = String(stock.code).padStart(4, '0');
        try { rowsByCode.set(code, await finMindFundamentals(code)); }
        catch (error) { rowsByCode.set(code, []); failures.push(`${code}: ${error.message}`); }
      }
    }));
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
  }
  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    price: priceMeta,
    fundamentals,
    stocks
  };
  if (dryRun) {
    console.log(`DRY RUN OK: target=${target}, stocks=${stocks.length}, date=${requestedDate}`);
    if (target === 'price' || target === 'both') console.log(`PRICE: coverage=${priceMeta.coverage}, cheapSampleSize=${priceMeta.cheapSampleSize}, medCheap=${priceMeta.medCheap}`);
    if (target === 'fundamentals' || target === 'both') console.log(`FUNDAMENTALS: coverage=${fundamentals.coverage}, medAKSampleSize=${fundamentals.medAKSampleSize}, periodEnd=${fundamentals.periodEnd}, validUntil=${fundamentals.validUntil}, medAK=${fundamentals.medAK}`);
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
  console.log('SELF-TEST OK: recomputation, full-coverage gate, and partial-coverage rejection');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Snapshot update stopped: ${error.message}`); process.exitCode = 1; });
}
