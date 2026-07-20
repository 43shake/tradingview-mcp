/**
 * Unit tests for getOhlcv range mode (from/to/lookback_bars).
 * Pure unit (mocked CDP eval) — no TradingView Desktop required.
 *
 * Run: node --test tests/ohlcv_range.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getOhlcv } from '../src/core/data.js';

const bar = (t) => ({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
const T = (n) => String(1e8 + n); // parseRangeTs rejects digit strings < 1e8 (never chart-era seconds)

// One merged scan per round: the range-mode page JS returns slice + coverage
// state in a single ascending pass ('direct_bars_range' marker). Each
// requestMoreData(1000) page mutates the shared state via pageEffect.
// NOTE: the merged JS also contains 'requestMoreDataAvailable', so the
// 'direct_bars_range' branch must be matched first.
function mockDeps({ scan = null, pageEffect = null, tail = null } = {}) {
  const calls = [];
  const state = {};
  const evaluate = async (expr) => {
    calls.push(expr);
    if (expr.includes('direct_bars_range')) return typeof scan === 'function' ? scan(state) : scan;
    if (expr.includes('requestMoreData(1000)')) {
      if (pageEffect) pageEffect(state);
      return undefined;
    }
    return tail;
  };
  const pageCount = () => calls.filter((c) => c.includes('requestMoreData(1000)')).length;
  const scanCount = () => calls.filter((c) => c.includes('direct_bars_range')).length;
  return { _deps: { evaluate, pageWaitMs: 0 }, pageCount, scanCount, calls };
}

const coveredScan = (over = {}) => ({
  bars: [bar(900), bar(1000), bar(1500)], in_range: 2, lookback_included: 1,
  before: 5, more: true, total_bars: 10, buf_first: 100, ordered: true,
  source: 'direct_bars_range', ...over,
});

describe('getOhlcv() — parameter validation', () => {
  it('rejects count together with from (mode conflict)', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => getOhlcv({ count: 10, from: T(1000), _deps }), /not both/);
  });

  it('rejects lookback_bars without from', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => getOhlcv({ lookback_bars: 60, _deps }), /requires `from`/);
  });

  it('rejects to without from', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => getOhlcv({ to: T(2000), _deps }), /requires `from`/);
  });

  it('rejects to earlier than from', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => getOhlcv({ from: T(2000), to: T(1000), _deps }), /earlier/);
  });

  it('rejects an unparseable from', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => getOhlcv({ from: 'not-a-date', _deps }), /Could not parse/);
  });

  it('rejects lookback_bars above the bar cap instead of silently clamping', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => getOhlcv({ from: T(1000), lookback_bars: 501, _deps }), /lookback_bars/);
  });

  it('rejects negative or fractional lookback_bars instead of silently normalizing', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => getOhlcv({ from: T(1000), lookback_bars: -5, _deps }), /lookback_bars/);
    await assert.rejects(() => getOhlcv({ from: T(1000), lookback_bars: 60.5, _deps }), /lookback_bars/);
  });

  it('rejects short digit strings ("2026") instead of reading them as unix seconds', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => getOhlcv({ from: '2026', _deps }), /unix seconds/);
  });

  it('rejects digit strings that overflow to Infinity', async () => {
    const { _deps } = mockDeps();
    await assert.rejects(() => getOhlcv({ from: '9'.repeat(400), _deps }), /Could not parse|unix seconds/);
  });
});

describe('getOhlcv() — range mode', () => {
  it('slices bars in [from, to] plus lookback without paging when buffer covers from', async () => {
    const { _deps, pageCount } = mockDeps({ scan: coveredScan() });
    const res = await getOhlcv({ from: T(1000), to: T(2000), lookback_bars: 1, _deps });
    assert.equal(res.success, true);
    assert.equal(res.bar_count, 3);
    assert.equal(res.source, 'direct_bars_range');
    assert.equal(res.window.in_range, 2);
    assert.equal(res.window.lookback_included, 1);
    assert.equal(res.window.range_start_covered, true);
    assert.equal(pageCount(), 0);
  });

  it('pages back until the lookback margin before `from` is loaded', async () => {
    const { _deps, pageCount } = mockDeps({
      // First scan: buffer reaches from but with 0 warmup bars before it.
      scan: (state) => coveredScan({ before: state.paged ? 60 : 0, buf_first: state.paged ? -10 : 1e8 + 990 }),
      pageEffect: (state) => { state.paged = true; },
    });
    const res = await getOhlcv({ from: T(1000), lookback_bars: 60, _deps });
    assert.equal(pageCount(), 1);
    assert.equal(res.window.range_start_covered, true);
  });

  it('returns flagged success when the feed is exhausted before reaching `from`', async () => {
    const { _deps, pageCount } = mockDeps({
      scan: coveredScan({ more: false, buf_first: 1e8 + 2000, before: 0, lookback_included: 0, bars: [bar(2000), bar(2500)] }),
    });
    const res = await getOhlcv({ from: T(1000), to: T(3000), _deps });
    assert.equal(pageCount(), 0);
    assert.equal(res.window.range_start_covered, false);
  });

  it('throws when the round cap is hit while more history is still available', async () => {
    const { _deps, pageCount } = mockDeps({
      // Each page makes real progress (buf_first drops, buffer grows) but never
      // reaches `from` — distinct from the stalled-feed case below.
      scan: (state) => coveredScan({
        more: true, before: 0, in_range: 1, bars: [bar(9000)],
        buf_first: 1e8 + 5000 - (state.pages || 0) * 100,
        total_bars: 10 + (state.pages || 0) * 1000,
      }),
      pageEffect: (state) => { state.pages = (state.pages || 0) + 1; },
    });
    const deps = { ..._deps, maxRounds: 2 };
    await assert.rejects(() => getOhlcv({ from: T(1000), to: T(9999), _deps: deps }), /paging round cap/i);
    assert.equal(pageCount(), 2);
  });

  it('throws when no bars fall inside the range', async () => {
    const { _deps } = mockDeps({
      scan: coveredScan({ in_range: 0, bars: [], lookback_included: 0 }),
    });
    await assert.rejects(() => getOhlcv({ from: T(1000), to: T(2000), _deps }), /No bars/);
  });

  it('throws when the range exceeds the bar cap instead of silently truncating', async () => {
    const { _deps } = mockDeps({
      scan: coveredScan({ in_range: 600, lookback_included: 0, bars: [] }),
    });
    await assert.rejects(() => getOhlcv({ from: T(1000), to: T(999999), _deps }), /narrow/i);
  });

  it('retries the scan when the buffer is transiently unordered, then succeeds', async () => {
    let scans = 0;
    const { _deps, scanCount } = mockDeps({
      scan: () => { scans++; return coveredScan({ ordered: scans > 1 }); },
    });
    const res = await getOhlcv({ from: T(1000), to: T(2000), lookback_bars: 1, _deps });
    assert.equal(scanCount(), 2);
    assert.equal(res.bar_count, 3);
  });

  it('throws when the buffer stays unordered after retries', async () => {
    const { _deps, scanCount } = mockDeps({
      scan: coveredScan({ ordered: false }),
    });
    await assert.rejects(() => getOhlcv({ from: T(1000), to: T(2000), _deps }), /unordered/i);
    assert.equal(scanCount(), 3);
  });

  it('summary composes with range mode', async () => {
    const { _deps } = mockDeps({
      scan: coveredScan({ bars: [bar(1000), bar(1500)], in_range: 2, lookback_included: 0 }),
    });
    const res = await getOhlcv({ from: T(1000), to: T(2000), summary: true, _deps });
    assert.equal(res.bar_count, 2);
    assert.deepEqual(res.period, { from: 1000, to: 1500 });
    assert.equal(res.window.in_range, 2);
    assert.equal(res.window.lookback_requested, 0);
  });

  it('summary stats cover only the in-range window, not the lookback warmup bars', async () => {
    const warmup = { time: 900, open: 50, high: 55, low: 45, close: 52, volume: 1 };
    const { _deps } = mockDeps({
      scan: coveredScan({ bars: [warmup, bar(1000), bar(1500)], in_range: 2, lookback_included: 1 }),
    });
    const res = await getOhlcv({ from: T(1000), to: T(2000), lookback_bars: 1, summary: true, _deps });
    assert.deepEqual(res.period, { from: 1000, to: 1500 });
    assert.equal(res.open, 1); // in-range open, not the warmup bar's 50
    assert.equal(res.low, 0.5); // warmup low 45 must not leak in
    assert.equal(res.window.lookback_included, 1);
  });

  it('throws when paging stops advancing while the feed still claims more data', async () => {
    const { _deps, pageCount } = mockDeps({
      // more: true forever, but paging never changes buf_first/total_bars.
      scan: coveredScan({ more: true, buf_first: 1e8 + 5000, before: 0, in_range: 1, bars: [bar(9000)] }),
    });
    await assert.rejects(() => getOhlcv({ from: T(1000), to: T(9999), _deps }), /not advancing/i);
    // The stalled page must be waited out with settle polls, not answered by
    // firing more page requests.
    assert.equal(pageCount(), 1);
  });

  it('tolerates a slow page that lands during the settle polls', async () => {
    const { _deps, pageCount } = mockDeps({
      scan: (state) => {
        state.scans = (state.scans || 0) + 1;
        // Page issued after scan 1; the merge only lands at the 4th scan
        // (i.e. after two unchanged settle polls), then covers everything.
        const landed = state.pages >= 1 && state.scans >= 4;
        return coveredScan(landed
          ? { before: 60, buf_first: 1e8 - 10, total_bars: 1010 }
          : { before: 0, buf_first: 1e8 + 990, total_bars: 10 });
      },
      pageEffect: (state) => { state.pages = (state.pages || 0) + 1; },
    });
    const res = await getOhlcv({ from: T(1000), lookback_bars: 60, _deps });
    assert.equal(pageCount(), 1);
    assert.equal(res.window.range_start_covered, true);
  });
});

// Real page-JS coverage: intercept the range scan expression and eval it in
// Node against a fake window.TradingViewApi buffer (technique per fresh review
// F3 — the sliding lookback window / matched flag / ordered detection / cap
// sentinel live in page JS and were otherwise only covered by live runs).
describe('getOhlcv() — page JS scan (fake buffer eval)', () => {
  const fakePageDeps = (rows) => {
    const barsObj = {
      firstIndex: () => 0, lastIndex: () => rows.length - 1,
      valueAt: (i) => rows[i], size: () => rows.length,
    };
    const series = { requestMoreDataAvailable: () => false, bars: () => barsObj };
    const evaluate = async (expr) => {
      globalThis.window = {
        TradingViewApi: {
          _activeChartWidgetWV: { value: () => ({ _chartWidget: { model: () => ({ mainSeries: () => series }) } }) },
        },
      };
      try { return (0, eval)(expr); } finally { delete globalThis.window; }
    };
    return { _deps: { evaluate, pageWaitMs: 0 } };
  };
  const row = (t) => [t, 1, 2, 0.5, 1.5, 10];

  it('collects the sliding lookback tail (last N pre-range bars) and in-range slice in one pass', async () => {
    const t0 = 1e8;
    const rows = [10, 20, 30, 40, 50, 60, 70].map((d) => row(t0 + d));
    const { _deps } = fakePageDeps(rows);
    const res = await getOhlcv({ from: String(t0 + 40), to: String(t0 + 60), lookback_bars: 2, _deps });
    assert.equal(res.window.in_range, 3);
    // Sliding tail must keep the LAST two bars before `from` (20, 30), not (10, 20).
    assert.deepEqual(res.bars.map((b) => b.time), [t0 + 20, t0 + 30, t0 + 40, t0 + 50, t0 + 60]);
    assert.equal(res.window.lookback_included, 2);
  });

  it('detects an unordered buffer and fails loud', async () => {
    const { _deps } = fakePageDeps([row(1e8 + 10), row(1e8 + 30), row(1e8 + 20), row(1e8 + 40)]);
    await assert.rejects(
      () => getOhlcv({ from: String(1e8 + 10), to: String(1e8 + 40), _deps }),
      /unordered/i,
    );
  });

  it('caps the materialized page payload and fails loud on oversized ranges', async () => {
    const rows = [];
    for (let i = 0; i < 520; i++) rows.push(row(1e8 + i * 10));
    const { _deps } = fakePageDeps(rows);
    await assert.rejects(
      () => getOhlcv({ from: String(1e8), to: String(1e8 + 520 * 10), _deps }),
      /narrow/i,
    );
  });

  it('skips null slots and still counts before/lookback correctly', async () => {
    const t0 = 1e8;
    const rows = [row(t0 + 10), null, row(t0 + 20), row(t0 + 30), row(t0 + 40), null, row(t0 + 50)];
    const { _deps } = fakePageDeps(rows);
    const res = await getOhlcv({ from: String(t0 + 30), to: String(t0 + 50), lookback_bars: 2, _deps });
    assert.equal(res.window.in_range, 3);
    assert.equal(res.window.lookback_included, 2);
    assert.deepEqual(res.bars.map((b) => b.time), [t0 + 10, t0 + 20, t0 + 30, t0 + 40, t0 + 50]);
    assert.equal(res.window.range_start_covered, true);
  });
});

describe('getOhlcv() — tail mode regression', () => {
  it('keeps the original tail behavior and return shape when from/to absent', async () => {
    const { _deps, pageCount, calls } = mockDeps({
      tail: { bars: [bar(1), bar(2)], total_bars: 300, source: 'direct_bars' },
    });
    const res = await getOhlcv({ count: 2, _deps });
    assert.deepEqual(res, {
      success: true, bar_count: 2, total_available: 300, source: 'direct_bars',
      bars: [bar(1), bar(2)],
    });
    assert.equal(pageCount(), 0);
    assert.equal(calls.some((c) => c.includes('direct_bars_range')), false);
  });
});
