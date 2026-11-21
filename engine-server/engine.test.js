const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const start = source.indexOf('
const server=http.createServer');
if (start < 0) throw new Error('Could not locate server startup boundary');
const boot = source.slice(0, start);

function fixture(t, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdesk-engine-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (seed) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(seed));
  const sandbox = {
    require, console, Date, Math, JSON, Number, String, Array, Set, Map, Object,
    AbortController, setTimeout, clearTimeout,
    process: { env: { DATA_DIR: dir, ENGINE_API_TOKEN: 'test-token', HOST: '127.0.0.1', PORT: '0' } },
    fetch: async () => { throw new Error('fetch must be stubbed for this test'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(boot + '\n;globalThis.__engine={state,defaults,choosePair,quoteFresh,replacement,decayCheck,riskChecks,engine,refresh,getRefreshLock:()=>refreshInFlight,pnl,load,save,openPosition,closePosition};', sandbox);
  return { e: sandbox.__engine, sandbox, dir };
}
const exp = '2027-01-29';
function ticker(symbol, strike, bid, ask, type, received = Date.now()) {
  return { symbol, strike_price: strike, contract_type: type, expiry_date: exp,
    quotes: { best_bid: bid, best_ask: ask }, _receivedAt: received };
}
function base(t) {
  const { e } = fixture(t);
  e.state.spot = 100000;
  e.state.tickers = [
    ticker('P-BTC-93000-20270129', 93000, 100, 105, 'put'),
    ticker('P-BTC-95000-20270129', 95000, 80, 85, 'put'),
    ticker('C-BTC-107000-20270129', 107000, 101, 106, 'call'),
    ticker('C-BTC-105000-20270129', 105000, 90, 95, 'call')
  ];
  return e;
}

test('pair selector chooses closest premium pair, then 7% OTM tie-break', (t) => {
  const e = base(t);
  const pair = e.choosePair(exp);
  assert.ok(pair);
  assert.equal(pair.p.symbol, 'P-BTC-93000-20270129');
  assert.equal(pair.c.symbol, 'C-BTC-107000-20270129');
});

test('fresh quote guard rejects stale, zero, and crossed quotes', (t) => {
  const e = base(t);
  const stale = ticker('P-BTC-93000-old', 93000, 100, 105, 'put', Date.now() - 13000);
  const zero = ticker('P-BTC-zero', 93000, 0, 105, 'put');
  const crossed = ticker('P-BTC-cross', 93000, 110, 105, 'put');
  assert.equal(e.quoteFresh(stale), false);
  assert.equal(e.quoteFresh(zero), false);
  assert.equal(e.quoteFresh(crossed), false);
});

test('replacement matches target live opposite-leg bid and respects expiry/side/OTM', (t) => {
  const e = base(t);
  e.state.position = { expiryKey: exp };
  const replacement = e.replacement('SELL PE', 'P-BTC-93000-20270129', 101);
  assert.ok(replacement);
  assert.equal(replacement.o.symbol, 'P-BTC-95000-20270129');
});

test('decay booking requires 20% decay AND opposite leg 7% rise; replacement is opened', (t) => {
  const e = base(t);
  e.state.config.enabled = true;
  e.state.config.decayPct = 20;
  e.state.config.risePct = 7;
  e.state.position = { qty: 1, expiryKey: exp, credit: 201, adjusting: false, legs: [
    { side: 'SELL PE', symbol: 'P-BTC-93000-20270129', entry: 100, entryAt: Date.now() },
    { side: 'SELL CE', symbol: 'C-BTC-107000-20270129', entry: 100, entryAt: Date.now() }
  ] };
  e.state.tickers[0].quotes.best_ask = 80; // exactly 20% decay
  e.state.tickers[2].quotes.best_ask = 107; // exactly 7% rise
  e.state.tickers[2].quotes.best_bid = 101;
  e.decayCheck();
  assert.equal(e.state.position.legs.length, 2);
  assert.equal(e.state.position.legs.some(l => l.symbol === 'P-BTC-95000-20270129'), true);
  assert.equal(e.state.journal.some(j => j.action === 'DECAY PROFIT BOOK'), true);
  assert.equal(e.state.journal.some(j => j.action === 'REPLACEMENT ENTRY'), true);
});

test('decay does not trigger when opposite leg has risen less than 7%', (t) => {
  const e = base(t);
  e.state.config.enabled = true;
  e.state.position = { qty: 1, expiryKey: exp, credit: 201, adjusting: false, legs: [
    { side: 'SELL PE', symbol: 'P-BTC-93000-20270129', entry: 100, entryAt: Date.now() },
    { side: 'SELL CE', symbol: 'C-BTC-107000-20270129', entry: 100, entryAt: Date.now() }
  ] };
  e.state.tickers[0].quotes.best_ask = 80;
  e.state.tickers[2].quotes.best_ask = 106.99;
  e.decayCheck();
  assert.equal(e.state.journal.some(j => j.action === 'DECAY PROFIT BOOK'), false);
});

test('engine will not trade on stale feed timestamp', (t) => {
  const e = base(t);
  e.state.config.enabled = true;
  e.state.lastFeedAt = Date.now() - 13000;
  e.engine();
  assert.equal(e.state.position, null);
});

test('take-profit and stop-loss close positions only with fresh marks', (t) => {
  const e = base(t);
  e.state.position = { qty: 1, credit: 200, legs: [
    { side: 'SELL PE', symbol: 'P-BTC-93000-20270129', entry: 100 },
    { side: 'SELL CE', symbol: 'C-BTC-107000-20270129', entry: 100 }
  ] };
  e.state.config.takeProfitPct = 50;
  e.state.config.stopLossMultiple = 1;
  e.state.tickers[0].quotes.best_ask = 40;
  e.state.tickers[2].quotes.best_ask = 40;
  e.riskChecks();
  assert.equal(e.state.position, null);
  assert.ok(e.state.realized > 0);

  e.state.position = { qty: 1, credit: 200, legs: [
    { side: 'SELL PE', symbol: 'P-BTC-93000-20270129', entry: 100 },
    { side: 'SELL CE', symbol: 'C-BTC-107000-20270129', entry: 100 }
  ] };
  e.state.realized = 0;
  e.state.config.takeProfitPct = 0;
  e.state.tickers[0].quotes.best_ask = 220;
  e.state.tickers[2].quotes.best_ask = 220;
  e.riskChecks();
  assert.equal(e.state.position, null);
  assert.ok(e.state.realized < 0);
});

test('restart restores position/history but forces auto-trading disabled', (t) => {
  const seeded = { config: { enabled: true, quantity: 3 }, position: { qty: 3, legs: [] }, realized: 12, journal: [{ action: 'saved' }], locked: false };
  const { e, dir } = fixture(t, seeded);
  assert.equal(e.state.config.enabled, false);
  assert.equal(e.state.position.qty, 3);
  assert.equal(e.state.journal[0].action, 'saved');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(saved.config.enabled, false);
  assert.equal(saved.position.qty, 3);
});


test('refresh-in-flight lock prevents overlapping feed fetches', async (t) => {
  const { e, sandbox } = fixture(t);
  let calls = 0, resolveFetch;
  sandbox.fetch = () => { calls++; return new Promise(resolve => { resolveFetch = resolve; }); };
  const first = e.refresh();
  const second = e.refresh();
  assert.equal(calls, 1);
  resolveFetch({ ok: true, json: async () => ({ success: true, result: [ticker('P-BTC-93000-20270129',93000,100,105,'put')] }) });
  await Promise.all([first, second]);
  assert.equal(e.getRefreshLock(), false);
});
