#!/usr/bin/env node
/*
 * Daily price-only stock-pool snapshot updater.
 *
 * This script deliberately does NOT fetch or infer financial statements.  It
 * only carries forward the existing dividend / EPS inputs and recalculates the
 * price-dependent cheapness value.  A run fails before writing if every pool
 * member is not covered by an official closing-price response.
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
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const tables = Array.isArray(node.tables) ? node.tables : [node];
    for (const table of tables) {
      const fields = table.fields || table.title || [];
      const rows = table.data || table.rows || [];
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

export async function officialPrices(date) {
  const urls = officialPriceUrls(date);
  const replies = await Promise.all(urls.map(async url => {
    const response = await fetch(url, { headers: { 'user-agent': 'stock-scoreboard-snapshot/1.0' } });
    if (!response.ok) throw new Error(`official source HTTP ${response.status}`);
    return rowMap(await response.json());
  }));
  return new Map(replies.flatMap(map => [...map]));
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

export function buildCandidate(stocks, prices, asOf) {
  const missing = [];
  const updated = stocks.map(stock => {
    const code = String(stock.code || '').padStart(4, '0');
    const close = prices.get(code);
    if (!code || close == null || close <= 0 || num(stock.J) == null || num(stock.cheap) == null) {
      missing.push(`${stock.name || code}(${code || '無代號'})`);
      return stock;
    }
    // Existing formula: cheap = (trailing dividend yield / 5y average yield).
    // On a price-only day the numerator changes solely with price, so this is
    // exactly oldCheap × oldClose / newClose while dividends remain unchanged.
    const cheap = +(num(stock.cheap) * num(stock.J) / close).toFixed(3);
    return { ...stock, J: close, Jdate: asOf, cheap };
  });
  if (missing.length) throw new Error(`coverage/validation failed (${missing.length}/${stocks.length}): ${missing.join(', ')}`);
  const medCheap = median(updated.map(s => num(s.cheap)));
  if (medCheap == null) throw new Error('median cheapness missing after validation');
  return { updated, medCheap: +medCheap.toFixed(3) };
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

function statementValues(rows, type) {
  return rows.filter(row => row.type === type && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && num(row.value) != null)
    .sort((a, b) => a.date.localeCompare(b.date));
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

function valuesByPeriod(rows, type) {
  const values = new Map();
  const conflicts = new Set();
  for (const row of statementValues(rows, type)) {
    const value = num(row.value);
    if (values.has(row.date) && values.get(row.date) !== value) conflicts.add(row.date);
    values.set(row.date, value);
  }
  return { values, conflicts };
}

function completePeriods(values, conflicts, count = 8) {
  const available = new Set();
  for (const periodEnd of values.keys()) {
    const periods = quarterEndsEndingAt(periodEnd, count);
    if (periods && periods.every(period => values.has(period) && !conflicts.has(period))) available.add(periodEnd);
  }
  return available;
}

function commonLatestPeriod(required, rowsByCode) {
  const availability = required.map(stock => {
    const code = String(stock.code || '').padStart(4, '0');
    const { values, conflicts } = valuesByPeriod(rowsByCode.get(code) || [], 'EPS');
    return { stock, periods: completePeriods(values, conflicts) };
  });
  const withoutEightQuarters = availability.filter(item => item.periods.size === 0).map(item => `${item.stock.name || item.stock.code}(${item.stock.code || '無代號'})`);
  if (withoutEightQuarters.length) throw new Error(`fundamental coverage failed: EPS找不到完整連續8季的股票：${withoutEightQuarters.join(', ')}`);
  const shared = [...availability[0].periods].filter(period => availability.every(item => item.periods.has(period))).sort().reverse();
  if (!shared.length) throw new Error(`fundamental coverage failed: ${required.length} 檔非ETF沒有共同完整8季EPS期末`);
  return shared[0];
}

// This is intentionally the same EPS/AK definition as index.html computeJS:
// latest 4 EPS versus prior 4 EPS; AK is null where prior-period EPS <= 0.
export function buildFundamentalsCandidate(stocks, rowsByCode, asOf) {
  const required = stocks.filter(stock => stock.type !== 'etf');
  const periodEnd = commonLatestPeriod(required, rowsByCode);
  const periods = quarterEndsEndingAt(periodEnd);
  const latest4Periods = periods.slice(-4);
  const prior4Periods = periods.slice(0, 4);
  const missing = [];
  const updated = stocks.map(stock => {
    if (stock.type === 'etf') return stock; // Existing system has no EPS/AK for ETF.
    const code = String(stock.code || '').padStart(4, '0');
    const rows = rowsByCode.get(code);
    const eps = valuesByPeriod(rows || [], 'EPS');
    if (periods.some(period => !eps.values.has(period) || eps.conflicts.has(period))) { missing.push(`${stock.name || code}(${code || '無代號'}): 共同期EPS不完整`); return stock; }
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
      AK: ak
    };
    const income = valuesByPeriod(rows || [], 'IncomeAfterTaxes');
    const revenue = valuesByPeriod(rows || [], 'Revenue');
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
  if (missing.length) throw new Error(`fundamental coverage failed (${missing.length}/${stocks.length}): ${missing.join(', ')}`);
  const validUntil = validUntilFor(periodEnd);
  if (!validUntil) throw new Error(`invalid financial period ${periodEnd}`);
  const medAK = median(updated.map(stock => num(stock.AK)));
  if (medAK == null) throw new Error('EPS growth median missing after validation');
  return { updated, medAK: +medAK.toFixed(4), periodEnd, validUntil };
}

export async function atomicWriteJson(file, value, options = {}) {
  const temp = `${file}.snapshot-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
  let existingSnapshot = null;
  try {
    const candidate = JSON.parse(await fs.readFile(SNAPSHOT_FILE, 'utf8'));
    if (candidate?.schemaVersion === 1 && Array.isArray(candidate.stocks) && candidate.stocks.length === data.value.length) existingSnapshot = candidate;
    else throw new Error('schema or stock count mismatch');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Ignoring invalid canonical snapshot: ${error.message}`);
  }
  let stocks = existingSnapshot?.stocks || data.value;
  let priceMeta = existingSnapshot?.price || brief.value.sourceMeta?.stockPool?.price;
  let fundamentals = existingSnapshot?.fundamentals || fundamentalsFrom(brief.value);
  if ((target === 'fundamentals') && !priceMeta) throw new Error('fundamentals-only update requires an existing canonical price snapshot; run --target=price or --target=both first');
  if (target === 'price' || target === 'both') {
    const candidate = buildCandidate(stocks, await officialPrices(requestedDate), requestedDate);
    stocks = candidate.updated;
    priceMeta = { source: 'TWSE／TPEx 官方日收盤資料', asOf: requestedDate, fetchedAt: new Date().toISOString(), coverage: `${stocks.length}/${stocks.length}`, medCheap: candidate.medCheap, method: '舊便宜度 × 舊收盤價 ÷ 新收盤價（股利／EPS未更新）' };
  }
  if (target === 'fundamentals' || target === 'both') {
    const rowsByCode = new Map();
    const required = stocks.filter(stock => stock.type !== 'etf');
    const queue = [...required];
    await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) { const stock = queue.shift(); rowsByCode.set(String(stock.code).padStart(4, '0'), await finMindFundamentals(String(stock.code))); } }));
    const candidate = buildFundamentalsCandidate(stocks, rowsByCode, requestedDate);
    stocks = candidate.updated;
    fundamentals = { source: 'FinMind TaiwanStockFinancialStatements', asOf: requestedDate, periodEnd: candidate.periodEnd, validUntil: candidate.validUntil, coverage: `${required.length}/${required.length}`, medAK: candidate.medAK, method: '近4季 EPS 合計 ÷ 前4季 EPS 合計 − 1（前4季合計≤0則不納入中位數）' };
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
    if (target === 'price' || target === 'both') console.log(`PRICE: coverage=${priceMeta.coverage}, medCheap=${priceMeta.medCheap}`);
    if (target === 'fundamentals' || target === 'both') console.log(`FUNDAMENTALS: coverage=${fundamentals.coverage}, periodEnd=${fundamentals.periodEnd}, validUntil=${fundamentals.validUntil}, medAK=${fundamentals.medAK}`);
    console.log('No files were changed. Re-run with --write only after reviewing this output.');
    return;
  }
  await atomicWriteJson(SNAPSHOT_FILE, snapshot, { failBeforeRename: args.has('--simulate-write-failure') });
  console.log(`WROTE ATOMIC SNAPSHOT: ${path.relative(ROOT, SNAPSHOT_FILE)}, target=${target}, stocks=${stocks.length}, date=${requestedDate}`);
}

function selfTest() {
  const stocks = [{ name: '甲', code: '0001', J: 100, cheap: 1 }, { name: '乙', code: '0002', J: 200, cheap: 0.5 }];
  const ok = buildCandidate(stocks, new Map([['0001', 80], ['0002', 250]]), '2026-07-29');
  if (ok.updated[0].cheap !== 1.25 || ok.updated[1].cheap !== 0.4 || ok.medCheap !== 1.25) throw new Error('price-only cheapness calculation test failed');
  let rejected = false;
  try { buildCandidate(stocks, new Map([['0001', 80]]), '2026-07-29'); } catch { rejected = true; }
  if (!rejected) throw new Error('partial coverage must fail');
  console.log('SELF-TEST OK: proportional cheapness, median, and partial-coverage rejection');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Snapshot update stopped: ${error.message}`); process.exitCode = 1; });
}
