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
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((out, p) => ({ ...out, [p.type]: p.value }), {}).year + '-' +
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).reduce((out, p) => ({ ...out, [p.type]: p.value }), {}).month + '-' +
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).reduce((out, p) => ({ ...out, [p.type]: p.value }), {}).day;
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

async function officialPrices(date) {
  const compact = date.replaceAll('-', '');
  const slash = date.replaceAll('-', '/');
  const urls = [
    `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${compact}&type=ALLBUT0999&response=json`,
    `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${encodeURIComponent(slash)}&response=json`
  ];
  const replies = await Promise.all(urls.map(async url => {
    const response = await fetch(url, { headers: { 'user-agent': 'stock-scoreboard-snapshot/1.0' } });
    if (!response.ok) throw new Error(`official source HTTP ${response.status}`);
    return rowMap(await response.json());
  }));
  return new Map(replies.flatMap(map => [...map]));
}

async function finMindFundamentals(code) {
  // Same dataset and field definitions used by index.html's existing computeJS().
  // No token is embedded; a rate limit, schema change, or missing member fails
  // the whole quarterly run before any output is written.
  const start = `${new Date().getUTCFullYear() - 3}-01-01`;
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id=${encodeURIComponent(code)}&start_date=${start}`;
  const response = await fetch(url, { headers: { 'user-agent': 'stock-scoreboard-snapshot/1.0' } });
  if (!response.ok) throw new Error(`FinMind HTTP ${response.status} for ${code}`);
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
  if (month === 3) return `${year}-05-15`;
  if (month === 6) return `${year}-08-14`;
  if (month === 9) return `${year}-11-14`;
  if (month === 12) return `${year + 1}-03-31`;
  return null;
}

function statementValues(rows, type) {
  return rows.filter(row => row.type === type && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && num(row.value) != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// This is intentionally the same EPS/AK definition as index.html computeJS:
// latest 4 EPS versus prior 4 EPS; AK is null where prior-period EPS <= 0.
export function buildFundamentalsCandidate(stocks, rowsByCode, asOf) {
  const missing = [];
  const latestPeriods = [];
  const updated = stocks.map(stock => {
    if (stock.type === 'etf') return stock; // Existing system has no EPS/AK for ETF.
    const code = String(stock.code || '').padStart(4, '0');
    const rows = rowsByCode.get(code);
    const eps = statementValues(rows || [], 'EPS');
    if (eps.length < 8) { missing.push(`${stock.name || code}(${code || '無代號'}): EPS不足8季`); return stock; }
    const last8 = eps.slice(-8), latest4 = last8.slice(-4), prior4 = last8.slice(0, 4);
    const periodEnd = latest4[latest4.length - 1].date;
    const prior = prior4.reduce((sum, row) => sum + num(row.value), 0);
    const current = latest4.reduce((sum, row) => sum + num(row.value), 0);
    const ak = prior > 0 ? +(current / prior - 1).toFixed(4) : null;
    const next = { ...stock, q1: +num(latest4[0].value).toFixed(2), q2: +num(latest4[1].value).toFixed(2), q3: +num(latest4[2].value).toFixed(2), q4: +num(latest4[3].value).toFixed(2), AK: ak };
    const income = statementValues(rows, 'IncomeAfterTaxes');
    const revenue = statementValues(rows, 'Revenue');
    if (income.length >= 4 && revenue.length >= 4) {
      const ni = income.slice(-4).reduce((sum, row) => sum + num(row.value), 0);
      const rev = revenue.slice(-4).reduce((sum, row) => sum + num(row.value), 0);
      // Keep index.html computeJS() semantics: a zero TTM net income does not
      // overwrite AA with a misleading 0; it remains unavailable/unchanged.
      if (ni && rev > 0) next.AA = +(ni / rev * 100).toFixed(2);
    }
    latestPeriods.push(periodEnd);
    return next;
  });
  if (missing.length) throw new Error(`fundamental coverage failed (${missing.length}/${stocks.length}): ${missing.join(', ')}`);
  const uniquePeriods = [...new Set(latestPeriods)];
  if (uniquePeriods.length !== 1) throw new Error(`fundamental period mismatch: ${uniquePeriods.join(', ')}`);
  const periodEnd = uniquePeriods[0], validUntil = validUntilFor(periodEnd);
  if (!validUntil || asOf > validUntil) throw new Error(`latest financial period ${periodEnd} is no longer valid after ${validUntil}`);
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
