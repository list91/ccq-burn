#!/usr/bin/env node
// cc-widget collector: parses Claude Code JSONL logs -> data.json / data.txt
// Usage: node collect.mjs [--once]  (default: loop every intervalSec)
//
// The metric is cost-weighted tokens, not message count: Anthropic meters a
// weighted compute budget, and the weights below track it far better than
// counting assistant replies. There is deliberately NO cap by default:
// calibrate.mjs read the real 429 events out of the logs and they do not fit any
// static ceiling (windows of 22M passed clean, 8.8M ones got blocked), so the
// reference is the distribution of this account's own completed windows.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UsageProbe, setCredPath } from './usage.mjs';

const CFG_PATH = path.join(import.meta.dirname, 'config.json');
const DEF_CFG = {
  plan: 'max5x',
  claudeDir: path.join(os.homedir(), '.claude', 'projects'),
  outDir: import.meta.dirname,
  blockHours: 5,
  intervalSec: 60,
  weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  capsBlockCost: null,
  capsWeekCost: null,
  weekAnchorIso: '2026-08-29T10:00:00.000Z',
  modelWeights: { opus: 1, sonnet: 0.2, haiku: 0.067, fable: 0.2, default: 1 }
};
let cfg, cfgError = null;
try { cfg = { ...DEF_CFG, ...JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) }; }
catch (e) {
  // Silence here was expensive: the fallback puts cacheRead back to 0.1, where
  // the correlation with the real quota INVERTS (-0.093 against +0.685 at 0),
  // drops credPath so the service under LocalSystem looks for credentials in
  // systemprofile and goes blind for good, and slows the tick from 5 s to 60 s.
  // None of that was visible anywhere. Now it is, in the log and in data.json.
  cfg = DEF_CFG;
  cfgError = 'config.json не прочитан (' + (e.code || e.message) + '), взяты ВСТРОЕННЫЕ значения: cacheRead=0.1, credPath отсутствует';
  console.error('[cc-widget] ' + cfgError);
}
cfg.outDir = cfg.outDir || import.meta.dirname;
cfg.weights = { ...DEF_CFG.weights, ...(cfg.weights || {}) };
cfg.modelWeights = { ...DEF_CFG.modelWeights, ...(cfg.modelWeights || {}) };

// kappa is measured in units of `cost`, and `cost` is defined by these weights.
// Moving cacheRead from 0.1 to 0 changed the weekly cost by 2.76x; a ratio taught
// under the old scale would have shown 89 % where the server said 50 %, marked
// only with a `~`. The scale gets an id, and a stored kappa from a different one
// is thrown away instead of silently rescaled.
function scaleIdOf(c) {
  const w = c.weights, m = c.modelWeights || {};
  const src = JSON.stringify([w.input, w.cacheWrite, w.cacheRead, w.output,
    Object.keys(m).sort().map(k => [k, m[k]])]);
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h * 33) ^ src.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const SCALE_ID = scaleIdOf(cfg);

const BLOCK_MS = cfg.blockHours * 3600e3;
const WEEK_MS = 7 * 24 * 3600e3;
const TEN_MIN = 10 * 60e3;
const WEEK_ANCHOR = Date.parse(cfg.weekAnchorIso);

function* jsonlFiles(dir, minMtime) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      try { if (fs.statSync(p).mtimeMs < minMtime) continue; } catch { continue; }
      yield p;
    }
  }
}

// Relative quota cost of one token, Opus = 1. Subagents routinely run cheaper
// models, and without this a burst of Sonnet workers looks like a burst of Opus
// ones: the pace and the forecast jump while the real quota barely moves.
// The numbers are the public API price ratios, not measured against the quota,
// so they are configurable; anything unknown counts as full price.
function modelMul(key) {
  const t = cfg.modelWeights || {};
  return t[key] ?? t.default ?? 1;
}

function rawCostOf(u) {
  const w = cfg.weights;
  return w.input * (u.input_tokens || 0) +
         w.cacheWrite * (u.cache_creation_input_tokens || 0) +
         w.cacheRead * (u.cache_read_input_tokens || 0) +
         w.output * (u.output_tokens || 0);
}

// Short family name, used both for the weight lookup and for the calibration
// samples that check those weights against the real quota.
function modelKey(model) {
  const m = String(model || '').toLowerCase();
  for (const k of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(k)) return k;
  return 'other';
}

// Anthropic reports resets on a 10-minute mark - 133 recorded reset instants all
// land within half a second of one - and it takes the FLOOR of the window's first
// message, not the ceiling: a window whose first row is 22:43:06 resets at 03:40.
// Rounding up turned a seven-second question into a ten-minute error, which is
// twice WIN_TOL_MS and therefore threw the sample series away on the first real
// answer of every window.
const floor10 = (t) => Math.floor(t / TEN_MIN) * TEN_MIN;
const winEndOf = (start) => floor10(start) + BLOCK_MS;

setCredPath(cfg.credPath);
const probe = new UsageProbe(path.join(import.meta.dirname, 'usage_cache.json'));

// Incremental scan state: every JSONL is read once in full, then only its tail.
// Claude Code appends ~27 MB/hour under heavy use, so a 5-second tick reads a few
// tens of KB instead of re-parsing 2 GB.
const store = {
  files: new Map(),   // path -> { offset }  (bytes already parsed)
  rows: [],           // usage rows, kept sorted by timestamp
  future: [],         // rows dated ahead of our clock, re-admitted when it catches up
  seen: new Map(),    // dedup key -> timestamp, pruned together with rows
  quota: null
};
// One line stamped a day ahead poisoned every number at once: lastRowT is the
// maximum over ALL retained rows, so idleSec stuck at 0 and idle/frozen became
// unreachable; the block scan moved the window start into the future, giving
// pctTime -479, remainingMin 1741 for a five-hour window and costPerHour 194x
// the truth. Such rows are held aside rather than dropped - a clock that is
// merely behind will catch up, and the spend is real.
const FUTURE_TOL_MS = 2 * 60e3;
const RETAIN_MS = WEEK_MS + 2 * 24 * 3600e3;
let lastSampleAt = null;

// Dedup for the calibration file was in-process only, so every service restart
// re-appended the sample it already had (three identical 12:31:32.029Z lines on
// disk). The timestamps already written are read back once at startup.
const SAMPLES_PATH = path.join(cfg.outDir, 'wfit_samples.jsonl');
const seenSamples = new Set();
let lastKappaAt = null;      // server instant the ratio was last taught from
// { win, srvAt, pct } - the extrapolation never walks backwards between two
// server answers; kept on disk so a service restart does not drop the ratchet
const SHOWN_PATH = path.join(cfg.outDir, 'shown_pct.json');
let shownPct = null;
try {
  const s = JSON.parse(fs.readFileSync(SHOWN_PATH, 'utf8'));
  if (Number.isFinite(s?.pct) && Number.isFinite(s?.win)) shownPct = s;
} catch { }
try {
  for (const l of fs.readFileSync(SAMPLES_PATH, 'utf8').split('\n')) {
    if (!l) continue;
    try { const o = JSON.parse(l); if (o.at) seenSamples.add(o.at); } catch { }
  }
} catch { }

// The server's own percent history for the live window: 4+ points give an
// honest %/h that owes nothing to the cost weights. Kept on disk so a restart
// does not blind the strip for 20 minutes.
const SRV_HIST_PATH = path.join(cfg.outDir, 'srv_hist.json');
// The start we synthesized when the server said "no window". It has to survive
// both the next tick and a restart: the server publishes a block late - it
// answered "no window" seven seconds after the window it later dated 08:39:59 -
// and on the SECOND such answer the naive rule moved the start to the first row
// after it, discarding every message in between and reporting an empty window to
// a user who was visibly working.
const WIN_SEED_PATH = path.join(cfg.outDir, 'win_seed.json');
function readSeed(now) {
  try {
    const s = JSON.parse(fs.readFileSync(WIN_SEED_PATH, 'utf8'));
    if (Number.isFinite(s && s.start) && now - s.start < BLOCK_MS && s.start <= now + 60e3) return s.start;
  } catch (e) { }
  return null;
}
// Losing this file costs one window's worth of monotonicity and heals on the next
// real answer; letting it throw costs data.json, which is the strip's only input.
function writeSeed(v) {
  try {
    if (v === null) fs.rmSync(WIN_SEED_PATH, { force: true });
    else atomicWrite(WIN_SEED_PATH, JSON.stringify({ start: v }));
  } catch (e) { console.error('[cc-widget] win_seed ne zapisan:', e.message); }
}
let srvHist = [];
try {
  const h = JSON.parse(fs.readFileSync(SRV_HIST_PATH, 'utf8'));
  if (Array.isArray(h)) srvHist = h.filter(s => Number.isFinite(s?.at) && Number.isFinite(s?.pct)).slice(-80);
} catch { }

// Ordinary least squares slope of pct over hours. The server quantises to whole
// percent, so the error is sigma/(dt*sqrt(n(n^2-1)/12)) with sigma=0.289 pp: at
// the 5-minute poll cadence that is 1.55 %/h over 4 points, 0.83 over 6, 0.65
// over 7. Below 4 points it is worse than useless.
function olsSlope(hist) {
  if (hist.length < 4) return null;
  const n = hist.length;
  const mx = hist.reduce((s, p) => s + p.at, 0) / n;
  const my = hist.reduce((s, p) => s + p.pct, 0) / n;
  let sxy = 0, sxx = 0;
  for (const p of hist) { const dx = p.at - mx; sxy += dx * (p.pct - my); sxx += dx * dx; }
  if (sxx <= 0) return null;
  return (sxy / sxx) * 3600e3;
}

// The pace is NOT stationary inside a window, so one regression over the whole
// window is the wrong object. Measured on 2026-09-09: 71 minutes flat at 47 %,
// then a burst; the whole-window fit read 6.9 %/h while the last 20 minutes ran
// at 59.9. This slope is used as a CEILING (srvSlope * 2.5) on the cost-derived
// pace, and that average would have capped the forecast at 17 %/h for four polls
// running while the server itself was doing 36-60 - a warning suppressed by the
// safety net that exists to keep the forecast honest.
// So: regress over several trailing spans and keep the LARGEST. The ceiling then
// never sits below a pace the server has actually shown, and the long spans stop
// a single quantised step from inflating it. On that window the ceiling goes
// 12 -> 18 -> 69 -> 120 -> 144 %/h across the four polls of the burst.
// 25 min = 6 points at the 5-minute cadence (+-0.83 %/h); 60 and 300 are the
// slower references, 300 covering the whole five-hour window.
const SLOPE_SPANS_MIN = [25, 60, 300];
function srvSlopePctPerHour(hist) {
  if (hist.length < 4) return null;
  const t = hist[hist.length - 1].at;
  let best = null;
  for (const m of SLOPE_SPANS_MIN) {
    const v = olsSlope(hist.filter(p => t - p.at <= m * 60e3));
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}

// cost -> percent INSIDE ONE WINDOW. The ratio cost/pct assumes utilisation
// starts from a clean zero; it does not. Regressing pct = a + b*cost over the
// window's own samples puts that offset into the intercept - measured at +8.5..
// +10.6 pp on 2026-09-09 and +17..+30 pp on 2026-09-08 - and the ratio was
// therefore 15 % low (89 803 per point against a fitted 105 789), which is
// exactly how much every carried increment was over-stated.
// Unlike the time slope this one regresses over ALL in-window samples: r2 was
// 0.99 across the whole window, while a trailing subset is degenerate (cost is
// flat whenever nothing is spent, and a last-8-points fit swung 46 688..175 964
// on that same window).
function kappaFromHist(hist) {
  // cost is denominated in the weights that were live when the sample was taken;
  // fitting across a weight change fits a currency conversion, not a quota
  const h = hist.filter(p => Number.isFinite(p.cost) && p.cost > 0
                          && (!p.sc || p.sc === SCALE_ID));
  if (h.length < 4) return null;
  const n = h.length;
  const mx = h.reduce((s, p) => s + p.cost, 0) / n;
  const my = h.reduce((s, p) => s + p.pct, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of h) { const dx = p.cost - mx, dy = p.pct - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0 || syy <= 0) return null;
  const b = sxy / sxx;
  if (!(b > 0)) return null;                     // cost up, percent down: not a scale
  const r2 = (sxy * sxy) / (sxx * syy);
  if (r2 < 0.5) return null;
  return { perPct: 1 / b, r2, n };
}

// The reset instant identifies the window, but the server jitters it by up to a
// second between answers, so an exact-equality key threw the series away on every
// single poll (28 wipes in 29 recorded polls; srvHist never held more than one
// point and srvSlope was null 100 % of the time). Real windows are five hours
// apart, so five minutes of tolerance separates them with room to spare - and the
// FIRST value seen stays canonical, so the key cannot drift.
const WIN_TOL_MS = 5 * 60e3;
const sameWin = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= WIN_TOL_MS;

// Start of the live 5h window: the first row after a gap of at least 5h.
function blockStartOf(rows) {
  let start = rows[0].t;
  for (const r of rows) if (r.t - start >= BLOCK_MS) start = r.t;
  return start;
}

// One line of a transcript -> at most one usage row. Split out of scan() so the
// chunked reader below can hand it lines without caring where they came from.
function ingestLine(line) {
  if (!line.includes('"timestamp"')) return 0;
  let j;
  try { j = JSON.parse(line); } catch { return 0; }
  const t = Date.parse(j?.timestamp || '');
  if (!Number.isFinite(t)) return 0;

  const q = j?.quotaLimits ?? j?.message?.quotaLimits;
  if (q?.rateLimitType && q?.resetsAt && (!store.quota || t > store.quota.t)) {
    // resetsAt arrives straight out of a transcript and was written into the
    // output as new Date(x).toISOString(). One line where it is not a plain epoch
    // second threw RangeError: Invalid time value out of collect(), BEFORE the
    // write - so data.json stopped being produced at all, and because the line is
    // re-read on every start the widget stayed bricked for the whole nine-day
    // retention. Anything unusable is simply not a quota record.
    const rs = Number(q.resetsAt) * 1000;
    if (Number.isFinite(rs) && rs > 0 && Math.abs(rs - t) < 30 * 24 * 3600e3) {
      store.quota = { t, type: q.rateLimitType, resetsAt: rs, status: q.status };
    }
  }

  const u = j?.message?.usage;
  if (!u) return 0;
  const id = j?.message?.id || '';
  const rq = j?.requestId || '';
  // no identity at all -> cannot dedup safely, and one such row must not
  // swallow every later one under a shared empty key
  if (!id && !rq) return 0;
  const key = id + ':' + rq;
  if (store.seen.has(key)) return 0;
  store.seen.set(key, t);
  const raw = rawCostOf(u);
  const mk = modelKey(j?.message?.model);
  store.rows.push({ t, raw, m: mk, cost: raw * modelMul(mk),
    tok: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
         (u.cache_read_input_tokens || 0) + (u.output_tokens || 0),
    out: u.output_tokens || 0, msg: 1 });
  return 1;
}

const CHUNK = 4 << 20;   // 4 MB: bounded no matter how far behind we are

function scan(now) {
  const minMtime = now - RETAIN_MS;
  let added = 0;
  let dirOk = true;
  try { fs.accessSync(cfg.claudeDir, fs.constants.R_OK); } catch { dirOk = false; }
  if (!dirOk) return { added: 0, dirOk };

  for (const f of jsonlFiles(cfg.claudeDir, minMtime)) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const prev = store.files.get(f);
    let from = prev ? prev.offset : 0;
    if (from === st.size) continue;              // nothing appended
    if (st.size < from) from = 0;                // truncated or rotated -> reread

    // The first pass over a 150 MB transcript used to allocate the whole tail at
    // once: RSS 509 MB, and past 512 MB Buffer.allocUnsafe throws outright. Read
    // it in fixed chunks instead, and only advance the stored offset over lines
    // that were actually ingested - a crash mid-parse must not silently skip a
    // block of history.
    let fd;
    try { fd = fs.openSync(f, 'r'); } catch { continue; }
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      let carry = '';          // bytes after the last newline of the previous chunk
      let carryBytes = 0;
      let pos = from;
      while (pos < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
        if (n <= 0) break;
        const nl = buf.lastIndexOf(0x0a, n - 1);
        if (nl === -1) {
          // no line break in this whole chunk: keep the bytes and read on
          carry += buf.subarray(0, n).toString('utf8');
          carryBytes += n;
          pos += n;
          continue;
        }
        const text = carry + buf.subarray(0, nl).toString('utf8');
        for (const line of text.split('\n')) added += ingestLine(line);
        // committed only now, and only up to the newline we actually parsed;
        // the bytes after it are re-read next round (one partial line at most)
        pos = pos + nl + 1;
        store.files.set(f, { offset: pos });
        carry = '';
        carryBytes = 0;
      }
    } catch { /* leave the offset where the last committed line ended */ }
    finally { try { fs.closeSync(fd); } catch { } }
  }

  if (added) store.rows.sort((a, b) => a.t - b.t);

  // rows the clock has caught up with come back into play
  const horizon = now + FUTURE_TOL_MS;
  if (store.future.length) {
    const back = store.future.filter(r => r.t <= horizon);
    if (back.length) {
      store.future = store.future.filter(r => r.t > horizon);
      store.rows = store.rows.concat(back).sort((a, b) => a.t - b.t);
    }
  }
  // ...and rows still ahead of it go aside. Their dedup keys stay in store.seen,
  // so they are not re-ingested; they come back from store.future, not from disk.
  if (store.rows.length && store.rows[store.rows.length - 1].t > horizon) {
    const ahead = store.rows.filter(r => r.t > horizon);
    store.rows = store.rows.filter(r => r.t <= horizon);
    store.future = store.future.concat(ahead);
    if (store.future.length > 5000) store.future = store.future.slice(-5000);
  }

  // drop what has aged out of every window we report on
  const cutoff = now - RETAIN_MS;
  if (store.rows.length && store.rows[0].t < cutoff) {
    store.rows = store.rows.filter(r => r.t >= cutoff);
    for (const [k, t] of store.seen) if (t < cutoff) store.seen.delete(k);
  }
  return { added, dirOk: true, futureRows: store.future.length };
}

async function collect() {
  const now = Date.now();
  // From the PREVIOUS tick, because the probe runs before the scan: five seconds
  // of lag, and all it decides is whether to ask the server again sooner.
  // Only a row that spent tokens: when the CLI cannot reach the API it writes its
  // own «API Error» row (model <synthetic>, zero usage), and that row is evidence
  // of the outage, not of the network being back.
  let lastRowT = 0;
  for (let i = store.rows.length - 1; i >= 0; i--) {
    if (store.rows[i].tok > 0) { lastRowT = store.rows[i].t; break; }
  }
  const usage = await probe.refresh(now, lastRowT);
  const sc = scan(now);
  const rows = store.rows;
  const quota = store.quota;

  // A freshly fresh answer is the only thing that may move the anchor, teach the
  // ratio or extend the server slope. Everything downstream asks these two.
  const STALE_MIN = cfg.staleMin || 10;
  const srvFreshEnough = usage.ok && !usage.stale && usage.ageMin <= STALE_MIN;

  // --- calibration samples ------------------------------------------------
  // modelWeights are price ratios, not measured against the quota. The endpoint
  // exposes neither dollars nor a per-model split of the 5h window, and the logs
  // never carry a percentage, so the only way to check them is a time series:
  // one row per server answer, holding the unweighted cost of each model family
  // alongside the utilisation it produced. wfit_solve.mjs regresses the two.
  if (usage.ok && usage.at && usage.at !== lastSampleAt && !seenSamples.has(usage.at)) {
    lastSampleAt = usage.at;
    seenSamples.add(usage.at);
    const srvAt = Date.parse(usage.at);
    // blockStartOf() is the LOG-derived block, which is not the window the
    // percentage describes: two samples went on disk with a windowStart 294
    // minutes into the previous window, and wfit_solve.mjs read them as 27.9M of
    // cost against 6 % - the pair that alone produced a negative fit.
    const rsS = usage.five?.resetsAt;
    const srvWinS = !Number.isFinite(rsS) ? null
                  : rsS > srvAt && rsS - srvAt <= BLOCK_MS + TEN_MIN ? rsS - BLOCK_MS
                  : rsS <= srvAt && srvAt - rsS <= BLOCK_MS ? rsS : null;
    const winStart = srvWinS !== null ? srvWinS
                   : (rows.length ? blockStartOf(rows) : null);
    const acc = (from) => {
      const o = {};
      for (const r of rows) if (r.t >= from && r.t <= srvAt) o[r.m] = (o[r.m] || 0) + r.raw;
      return o;
    };
    try {
      fs.appendFileSync(path.join(cfg.outDir, 'wfit_samples.jsonl'), JSON.stringify({
        at: usage.at,
        fivePct: usage.five?.pct ?? null,
        fiveResetsAt: usage.five?.resetsAt ?? null,
        weekPct: usage.week?.pct ?? null,
        windowStart: winStart,
        // the file mixes two incompatible cost scales (the weekly raw cost fell
        // 301.4M -> 109.6M, x2.76, when cacheRead went 0.1 -> 0) and carried no
        // field saying which; wfit_solve.mjs must be able to reject the others
        scale: SCALE_ID,
        five: winStart !== null ? acc(winStart) : null,
        week: acc(srvAt - WEEK_MS)
      }) + String.fromCharCode(10));
    } catch { }
  }

  // Belt and braces for FIX-4: the ingest filter keeps a bad resetsAt out of
  // store.quota, but nothing downstream of collect() may ever throw on a date.
  const iso = (t) => Number.isFinite(t) && Math.abs(t) < 8.64e15 ? new Date(t).toISOString() : null;
  const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
  const pct = (v, cap) => Math.min(999, Math.round((v / cap) * 100));

  // --- weekly window, anchored on the observed seven_day reset --------------
  // The hand-written anchor was 6 h 59 min off the server's own seven_day reset,
  // so the weekly cost covered a different week than the weekly percentage next
  // to it. Any answer the endpoint ever gave re-anchors it; the config value is
  // only the cold start.
  let weekAnchor = WEEK_ANCHOR;
  const srvWeekReset = usage.ok ? usage.week?.resetsAt : null;
  if (Number.isFinite(srvWeekReset)) weekAnchor = srvWeekReset;
  let weekStart, weekEnd;
  if (Number.isFinite(weekAnchor)) {
    // anchor is an END instant: walk whole weeks back to the one containing now
    const n = Math.ceil((now - weekAnchor) / WEEK_MS);
    weekEnd = weekAnchor + n * WEEK_MS;
    if (weekEnd <= now) weekEnd += WEEK_MS;
    weekStart = weekEnd - WEEK_MS;
  } else {
    weekStart = now - WEEK_MS;
    weekEnd = now;
  }
  const weekRows = rows.filter(r => r.t >= weekStart && r.t < weekEnd);
  const week = {
    cost: Math.round(weekRows.reduce((s, r) => s + r.cost, 0)),
    tokens: weekRows.reduce((s, r) => s + r.tok, 0),
    msgs: weekRows.reduce((s, r) => s + r.msg, 0),
    startedAt: new Date(weekStart).toISOString(),
    endsAt: new Date(weekEnd).toISOString(),
    remainingMin: Math.max(0, Math.round((weekEnd - now) / 60e3)),
    pctCap: 0
  };
  week.pctCap = cfg.capsWeekCost ? pct(week.cost, cfg.capsWeekCost) : null;

  const todayStr = new Date(now).toLocaleDateString('sv');
  const today = { cost: 0, tokens: 0, outTokens: 0, msgs: 0 };
  for (const r of rows) {
    if (new Date(r.t).toLocaleDateString('sv') === todayStr) {
      today.cost += r.cost; today.tokens += r.tok; today.outTokens += r.out; today.msgs += r.msg;
    }
  }
  today.cost = Math.round(today.cost);

  // --- 5h window: starts at the first message after a >=5h gap, no rounding -
  const blocks = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || r.t - cur.start >= BLOCK_MS) {
      cur = { start: r.t, cost: 0, tok: 0, out: 0, msgs: 0 };
      blocks.push(cur);
    }
    cur.cost += r.cost; cur.tok += r.tok; cur.out += r.out; cur.msgs += r.msg;
  }
  let last = blocks.length ? blocks[blocks.length - 1] : null;

  // --- whose clock owns the window --------------------------------------
  // The log-derived block starts at the first message after a >=5h gap; the
  // server's window starts wherever Anthropic says it does. The two drift by
  // minutes, and mixing them is what broke the reset: cost kept accumulating in
  // a window the server had already closed, so a 90 % reading survived into an
  // empty window. The server's instant wins whenever we have a fresh one.
  // ...but only while it IS fresh. A resets_at from eight hours ago kept the
  // window pinned to an instant that had long passed: "5 часов" ran for 3.7 h and
  // never moved. An expired answer anchors nothing.
  let srvWinStart = null, srvWinEnd = null, windowNotStarted = false;
  // The server says "no window is open" by answering with a null resets_at at
  // zero utilisation - Anthropic opens the next block on the next message, not
  // on a clock grid. Only the PRESENCE of resets_at was ever read, so that answer
  // fell through to the log block below, which still had minutes left on its own
  // five-hour clock: the strip drew a live countdown (98 %, 6 min) over a window
  // the server had already closed. An explicit "no window" outranks local
  // arithmetic - the whole point of asking the server.
  // Freshness decides whether the answer may MOVE the window; it does not change
  // what the answer says. A stale "no window" is still not a measurement of the
  // window that is running, and pairing its zero percent with the cost already
  // spent would push (2.1M, 0 %) into the regression - a point stating that cost
  // buys no quota at all.
  const noWinAnswer = usage.five && !Number.isFinite(usage.five.resetsAt) &&
                      (usage.five.pct === 0 || usage.five.pct === null);
  const srvNoWindow = srvFreshEnough && noWinAnswer;
  if (srvFreshEnough && usage.five && usage.five.resetsAt) {
    const rs = usage.five.resetsAt;
    // a reset instant more than one window away in either direction is a bad
    // answer, not a new window: taking it produced a 6-minute denominator and a
    // 1032 %/h pace
    if (rs > now && rs - now <= BLOCK_MS + TEN_MIN) { srvWinStart = rs - BLOCK_MS; srvWinEnd = rs; }
    else if (rs <= now && now - rs <= BLOCK_MS) { srvWinStart = rs; srvWinEnd = null; }
  }
  if (srvNoWindow) {
    // ...but the log can know about a message the server's last answer predates.
    // The window opened at that message; saying "no window" while the user is
    // visibly working is the same lie in the other direction, and it would last
    // until the next poll five minutes later.
    const srvAt = Date.parse(usage.at);
    // A start already synthesized may only be kept, never moved forward: a second
    // "no window" answer is the endpoint lagging behind a window that is already
    // running, and re-deriving the start from it erases the spend in between.
    const seeded = readSeed(now);
    const keep = seeded !== null && seeded <= srvAt && rows.some(r => r.t >= seeded);
    const firstAfter = keep ? null : rows.find(r => r.t > srvAt);
    const start = keep ? seeded : (firstAfter ? firstAfter.t : null);
    if (start !== null) {
      const w = { start: start, cost: 0, tok: 0, out: 0, msgs: 0 };
      for (const r of rows) if (r.t >= w.start) { w.cost += r.cost; w.tok += r.tok; w.out += r.out; w.msgs += r.msg; }
      last = w;
      if (!keep) writeSeed(start);
    } else {
      last = { start: now, cost: 0, tok: 0, out: 0, msgs: 0 };
      windowNotStarted = true;
    }
  } else if (srvWinStart !== null) {
    const w = { start: srvWinStart, cost: 0, tok: 0, out: 0, msgs: 0 };
    for (const r of rows) if (r.t >= srvWinStart) { w.cost += r.cost; w.tok += r.tok; w.out += r.out; w.msgs += r.msg; }
    last = w;
    // the server named the window itself: the guess has served its purpose
    writeSeed(null);
  } else if (last && now - last.start >= BLOCK_MS) {
    // The log block has run its five hours and not one message has arrived since
    // (a message would have opened a new block), so no window is live at all:
    // Anthropic opens the next one on the next message, not on a clock grid.
    // Guessing a start one block ahead put endsAt in the past after any pause of
    // 10 h or more, and the fallback below then pinned it to now+60s: the strip
    // showed a green "ост 0:01" with five full hours in fact available.
    last = { start: now, cost: 0, tok: 0, out: 0, msgs: 0 };
    windowNotStarted = true;
  }

  let block = null;
  if (last) {
    let endsAt = winEndOf(last.start);
    // a live quota record is authoritative about where the window really ends
    if (quota && quota.type === 'five_hour' && quota.resetsAt > now &&
        quota.resetsAt - BLOCK_MS <= last.start) {
      endsAt = quota.resetsAt;
    }
    // the usage endpoint knows the true reset instant; it wins over both
    if (srvWinEnd) endsAt = srvWinEnd;
    // whatever the source, a 5h window may not be longer than 5h + rounding, and
    // may not already be over: both used to yield nonsense denominators
    if (endsAt <= now || endsAt - last.start > BLOCK_MS + TEN_MIN) {
      endsAt = winEndOf(last.start);
      // a window that has already ended is not a window one minute from its
      // reset; the honest reading is a fresh one opening now
      if (endsAt <= now) { last = { ...last, start: now }; endsAt = winEndOf(now); windowNotStarted = true; }
    }

    // Historical distribution of completed windows. Calibration against the real
    // 429 events failed (windows of 22M passed clean while 8.8M ones got blocked),
    // so there is no static cap to measure against - the honest reference is the
    // user's own history.
    // Position said "the last block is the live one", which stops being true the
    // moment `last` is synthesized rather than taken from `blocks`: at every
    // window birth the window that had just CLOSED was thrown away with it, and
    // that history is the only bound the young-window forecast has. Ask whether a
    // block is over instead, and ask it after `last` is final.
    const doneCosts = blocks
      .filter(b => b.cost > 0 && b.start + BLOCK_MS <= now && b.start < last.start)
      .map(b => b.cost).sort((a, b) => a - b);
    const percentileOf = (v) => doneCosts.length
      ? Math.round((doneCosts.filter(c => c <= v).length / doneCosts.length) * 100) : null;
    const quantile = (q) => doneCosts.length
      ? doneCosts[Math.min(doneCosts.length - 1, Math.floor(doneCosts.length * q))] : null;
    {
      const elapsedH = Math.max((now - last.start) / 3600e3, 0);
      block = {
        cost: Math.round(last.cost),
        tokens: last.tok,
        outTokens: last.out,
        msgs: last.msgs,
        startedAt: new Date(last.start).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        remainingMin: Math.max(0, Math.round((endsAt - now) / 60e3)),
        pctTime: Math.min(100, Math.max(0, Math.round(((now - last.start) / (endsAt - last.start)) * 100))),
        // true = nothing has been spent in this window yet and its start is our
        // assumption, not a measurement; the strip should not paint it as fact
        windowNotStarted,
      };

      // --- activity ---------------------------------------------------------
      const IDLE_SOFT_SEC = cfg.idleSoftSec || 40;   // p90 pause is 32 s
      const IDLE_HARD_SEC = cfg.idleHardSec || 100;  // ~p97 pause
      const COLD_ROWS = 3, COLD_SEC = 45;
      // the maximum over ALL retained rows spans nine days, so one row from a
      // previous window (or from an unsynced clock) held idleSec at 0 for ever
      const inWin = rows.length && rows[rows.length - 1].t >= last.start;
      // A window that has not opened yet carries start = now, so measuring the
      // pause from it reports zero idle seconds after an idle day: the strip lost
      // «ПАУЗ», the dimming and the tooltip exactly when they were true.
      const lastRowT = (inWin || windowNotStarted) && rows.length
        ? Math.min(rows[rows.length - 1].t, now)
        : last.start;
      const idleSec = Math.max(0, Math.round((now - lastRowT) / 1000));
      block.idleSec = idleSec;
      block.active = idleSec < IDLE_SOFT_SEC;

      // --- pace: unbiased leaky integrator ----------------------------------
      // The previous version divided the decayed sum by tau. That is only right
      // once the window is much older than tau: for the first minutes after a
      // start it reports a rate several times too low, which is exactly the
      // "не разгоняется" complaint. Dividing by the observed mass of the kernel
      //   W = tau * (1 - exp(-elapsed/tau))
      // removes the bias, and a small gamma prior (B0 seconds of the window's
      // own average) keeps the estimate finite when one row is all we have.
      // Rows are winsorised at p99: a single 278k reply must not flip a state.
      const CLIP = cfg.costClip || 71449;
      const B0_SEC = 20;
      const TAU_FAST = cfg.tauFastSec || 43;    // half-life 30 s
      const TAU_SLOW = cfg.tauSlowSec || 173;   // half-life 2 min
      const winSec = Math.max(1, (now - last.start) / 1000);
      const prior = last.cost / winSec;         // cost per second, whole window

      // A pure function of (rows, t): nothing survives between ticks, so a
      // restart, a back-dated row or a laptop sleep cannot corrupt the estimate.
      // Winsorising belongs to the DETECTOR, not to the estimate. Clipping the
      // magnitude too under-reported a sparse window with big replies by up to
      // 1.43x - the burst it was meant to ignore was real spending.
      const rateAt = (tauSec, t, clip = false) => {
        const tauMs = tauSec * 1000;
        let s = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          // rows are sorted, so the first row before the window start ends the
          // walk. Without this the kernel reached back across the reset: with
          // TAU_SLOW=173 s the tail of the previous window still carried weight
          // five kernels back, and one minute after a reset that turned a true
          // 56 % forecast into 723 % - a red "-> 99+%" on an all-but-empty window.
          if (rows[i].t < last.start) break;
          const age = t - rows[i].t;
          if (age < 0) continue;
          if (age > 5 * tauMs) break;
          s += (clip ? Math.min(rows[i].cost, CLIP) : rows[i].cost) * Math.exp(-age / tauMs);
        }
        const elapsed = Math.max(0, Math.min(t - last.start, 5 * tauMs));
        const w = tauSec * (1 - Math.exp(-elapsed / tauMs));
        return (s + prior * B0_SEC) / (w + B0_SEC);   // cost per second
      };

      const TAU_BASE = cfg.tauBaseSec || 600;   // the window's own baseline
      const DWELL_MS = (cfg.dwellSec || 30) * 1000;
      const fastNow = rateAt(TAU_FAST, now);
      const slowNow = rateAt(TAU_SLOW, now);

      // Change is measured against the BASELINE, not against the smooth kernel.
      // Measured on this account's own statistics: fast/slow tops out at 1.44
      // during steady work and only reaches 1.40 on a real 5x burst, so that
      // ratio cannot separate them at all. Against a 10-min baseline the same
      // burst reaches 2.1 while steady work stays under 1.2.
      // Both ratios are gated by a dwell: the value must hold 30 s back too,
      // which is what keeps one 278k reply from repainting the widget.
      const dwelled = (tau) => {
        const at = (t) => { const b = rateAt(TAU_BASE, t, true); return b > 0 ? rateAt(tau, t, true) / b : 1; };
        return Math.min(at(now), at(now - DWELL_MS));
      };
      const rhoFast = dwelled(TAU_FAST);   // burst detector
      const rho = dwelled(TAU_SLOW);       // trend
      // thresholds from 40 simulated sessions: at 1.7 / 1.25 not one tick of
      // steady work fires, a 5x burst is admitted in ~50-65 s
      block.spike = rhoFast >= (cfg.spikeRatio || 1.7);
      block.trend = rho >= (cfg.upRatio || 1.25) ? 'up'
                  : rho <= (cfg.downRatio || 0.8) ? 'down' : 'flat';
      block.rho = Math.round(rho * 100) / 100;
      block.rhoFast = Math.round(rhoFast * 100) / 100;
      block.rateBase = Math.round(rateAt(TAU_BASE, now, true) * 3600);
      block.trendPct = Math.round((rho - 1) * 100);

      // --- state ------------------------------------------------------------
      //   cold   - too little of this window to say anything honest
      //   run    - burning; spike switches the estimate to the fast kernel
      //   frozen - 40 s of silence: hold the last value, do not decay it
      //   idle   - 100 s of silence: the rate is zero, the forecast is the fact
      const windowRows = rows.reduce((n, r) => n + (r.t >= last.start ? 1 : 0), 0);
      // A session of rare huge replies reported idle with costPerHour 0 while it
      // was burning 12M/h - and said spike:true in the same object. Silence that
      // the burst detector disagrees with is not silence.
      block.state = (idleSec >= IDLE_HARD_SEC && !block.spike) ? 'idle'
                  : (idleSec >= IDLE_SOFT_SEC && !block.spike) ? 'frozen'
                  : (windowRows < COLD_ROWS || winSec < COLD_SEC) ? 'cold'
                  : 'run';

      // freezing is expressed as "evaluate at the instant of the last row",
      // which keeps the number still without any stored state
      const ratePerSec = block.state === 'idle' ? 0
                       : block.state === 'frozen' ? rateAt(TAU_SLOW, lastRowT)
                       : block.spike ? fastNow
                       : slowNow;

      const remainH = block.remainingMin / 60;
      block.rateFast = Math.round(fastNow * 3600);
      block.rateSlow = Math.round(slowNow * 3600);
      block.costPerHour = Math.round(ratePerSec * 3600);
      block.rateForecast = block.costPerHour;
      block.msgsPerHour = Math.round(block.msgs / (winSec / 3600));
      const projCost = last.cost + ratePerSec * remainH * 3600;
      block.projCost = Math.round(projCost);
      block.projPctHist = percentileOf(projCost);
      block.pctHist = percentileOf(last.cost);
      block.refP90 = quantile(0.9);
      block.refMedian = quantile(0.5);

      // --- the real quota ---------------------------------------------------
      // The endpoint answers at most every 5 min, so between polls the fact is
      // carried forward locally: perPct tokens buy one percent of the quota.
      // Early in a window (util < 3 %) that ratio explodes, so the last known
      // good one is kept on disk and used instead of a wild number.
      const KAPPA_PATH = path.join(cfg.outDir, 'kappa.json');
      if (usage.ok && usage.five && typeof usage.five.pct === 'number') {
        const srvAt = Date.parse(usage.at);
        // A sample taken before this window opened describes the previous one:
        // counting its PERCENT would report the old window's utilisation as this
        // one's. But the birth of a window is a measurement in its own right - at
        // last.start exactly zero percent of it is spent, by definition - and
        // falling back to that zero is what keeps the strip alive across a reset.
        // Declaring blindness instead cost five minutes of "SLEP" at every
        // boundary, five times a day, while the number was perfectly computable:
        // the server's own "no window" answer arrives seconds BEFORE the first
        // message of the window it opens, so `srvAt >= last.start` was false by
        // construction at every single boundary.
        // A "no window" answer is never an in-window sample either, however
        // recent it is: its zero percent belongs to the gap before the window,
        // and pairing that zero with the cost already spent would feed the
        // regression a point saying "this much cost buys nothing".
        const srvInWin = srvAt >= last.start && !noWinAnswer;
        // Only while the endpoint itself is healthy. Past that the endpoint is
        // the problem, and inventing an anchor would hide it behind a number.
        const birthAnchor = !srvInWin && srvFreshEnough;
        const srvFresh = srvInWin || birthAnchor;
        const srvPct = srvInWin ? usage.five.pct : 0;
        let costAtSrv = 0;
        if (srvInWin) for (const r of rows) if (r.t >= last.start && r.t <= srvAt) costAtSrv += r.cost;
        // The strip must be able to say which of the two it is showing, and no
        // consumer may read realPctSrv 0 as "the server measured zero".
        block.srvAnchor = birthAnchor ? 'birth' : srvInWin ? 'server' : null;

        // --- server percent history, the one pace that owes nothing to cost ---
        // Matched with a tolerance, not by equality: see sameWin above. The first
        // reset instant of a window stays canonical for the whole of it, so the
        // key cannot drift with the server's jitter.
        const rsNow = Number.isFinite(usage.five.resetsAt) ? usage.five.resetsAt
                    : Date.parse(block.endsAt);
        const rsProv = !Number.isFinite(usage.five.resetsAt);
        // A window keyed by our own guess is not a different window once the
        // server names it - it is the same window, now known exactly. Wiping
        // there discarded the series at the first real answer of every window and
        // left srvSlope null for the twenty minutes it takes to rebuild, which is
        // exactly the stretch where the forecast has no other bound. Switch the
        // key; wipe only when the windows really differ.
        if (srvHist.length && srvHist[0].prov && !rsProv &&
            Math.abs(rsNow - srvHist[0].win) <= BLOCK_MS) {
          for (const s of srvHist) { s.win = rsNow; s.prov = false; }
        }
        if (srvHist.length && !sameWin(srvHist[0].win, rsNow)) srvHist = [];
        // Samples carry the scale they were measured on, but a scale change does
        // not make cost fall (weights went UP by 2.76x), so the «cost dropped»
        // wipe below never fires for it and the regression silently mixes two
        // currencies. The stamp is only worth writing if it is also acted on.
        if (srvHist.length && srvHist[0].sc && srvHist[0].sc !== SCALE_ID) srvHist = [];
        const winKey = srvHist.length ? srvHist[0].win : rsNow;
        // The birth anchor is deliberately NOT recorded: (cost 0, pct 0) drags the
        // regression towards the origin - measured leverage 0.81, perPct 63k ->
        // 77k - and that origin is precisely the bias the regression exists to
        // remove. It anchors the display; it does not teach the model.
        if (srvInWin && !srvHist.some(s => s.at === srvAt)) {
          // a percentage OR a cost that fell is a window turning over unnoticed
          const prev = srvHist[srvHist.length - 1];
          if (prev && (srvPct < prev.pct || costAtSrv < prev.cost)) srvHist = [];
          // cost travels with the sample: it is what turns this series into the
          // cost->percent regression below, and it costs eight bytes
          srvHist.push({ at: srvAt, pct: srvPct, cost: costAtSrv, win: winKey, sc: SCALE_ID, prov: srvHist.length ? !!srvHist[0].prov : rsProv });
          // 80 slots = 6.6 h at the 5-minute cadence, i.e. a whole window; the old
          // 40 covered only 3.3 h of it
          if (srvHist.length > 80) srvHist = srvHist.slice(-80);
          // Losing this file costs a few minutes of extrapolation and heals itself on
          // the next sample. Letting it throw costs data.json, which is the strip's
          // only input - the same shape of bug that once bricked the file for days.
          try { atomicWrite(SRV_HIST_PATH, JSON.stringify(srvHist)); } catch (e) { console.error('[cc-widget] srv_hist не записан:', e.message); }
        }
        const srvSlope = srvSlopePctPerHour(srvHist);
        block.srvSamples = srvHist.length;
        block.srvPctPerHour = srvSlope !== null ? Math.round(srvSlope * 10) / 10 : null;

        // --- cost -> percent -------------------------------------------------
        // Three separate things used to be wrong here:
        //  * the stored ratio carried no window, so the EWMA mixed the end of one
        //    window (perPct ~302k) with the start of the next (~30k, a 10x gap)
        //    and under-reported the strip roughly sevenfold for the first 40 min;
        //  * it carried no scale id, so a change of weights (cacheRead 0.1 -> 0,
        //    cost x2.76) left it silently mis-scaled;
        //  * it was a ratio, not a slope, so the non-zero intercept made it 15-33 %
        //    low and every carried increment correspondingly high.
        // The regression fixes the third; the window key and the scale id fix the
        // first two. The regression needs four in-window samples, so a cold-start
        // fallback is still wanted - and THAT is the trade-off: a value carried
        // across windows is what the first bullet says is wrong. It is kept, but
        // demoted: `cold` is a slow (0.9/0.1) average of completed windows, used ONLY
        // while this window has fewer than four samples of its own, and never
        // mixed into the in-window value.
        let cold = null, storedScale = null;
        try {
          const k = JSON.parse(fs.readFileSync(KAPPA_PATH, 'utf8'));
          storedScale = k.scale || null;
          if (storedScale === SCALE_ID) cold = Number.isFinite(k.cold) ? k.cold : null;
          // which sample was already learned from, so a restart does not re-apply
          if (k.srvAt && lastKappaAt === null) lastKappaAt = k.srvAt;
        } catch { }
        const scaleChanged = storedScale !== null && storedScale !== SCALE_ID;
        const KAPPA_MIN_PCT = cfg.kappaMinPct || 15;
        const fit = kappaFromHist(srvHist);
        // the ratio survives only as the pre-regression stand-in, and only where
        // it was already gated: a well-developed window, a fresh in-window sample
        const ratio = (srvFreshEnough && srvInWin && srvPct >= KAPPA_MIN_PCT &&
                       srvPct < 100 && costAtSrv > 0) ? costAtSrv / srvPct : null;
        const perPct = fit ? fit.perPct : (ratio ?? cold);
        const perPctSrc = fit ? 'fit' : ratio ? 'ratio' : cold ? 'cold' : null;
        // the cross-window average learns once per genuinely new sample, from the
        // fitted value only - never from the ratio, which is the biased one
        if (fit && usage.at !== lastKappaAt) {
          lastKappaAt = usage.at;
          cold = cold ? 0.9 * cold + 0.1 * fit.perPct : fit.perPct;
          try {
            atomicWrite(KAPPA_PATH, JSON.stringify({
              cold, scale: SCALE_ID, win: winKey, perPct: fit.perPct,
              r2: Math.round(fit.r2 * 1000) / 1000, n: fit.n, at: now, srvAt: usage.at
            }));
          } catch (e) { console.error('[cc-widget] kappa не записана:', e.message); }
        }
        block.perPct = perPct ? Math.round(perPct) : null;
        block.perPctSrc = perPctSrc;
        block.perPctR2 = fit ? Math.round(fit.r2 * 1000) / 1000 : null;
        block.perPctRatio = ratio ? Math.round(ratio) : null;
        block.scaleChanged = scaleChanged;

        // --- how much of the displayed number is actually known ---------------
        //   fact   - the server answered within the last poll interval
        //   extrap - fresh anchor, local cost carried forward on top
        //   stale  - the anchor is older than staleMin: no carrying, no forecast
        //   blind  - no server answer for blindMin: the last measurement only
        const BLIND_MIN = cfg.blindMin || 60;
        const ageMin = usage.ageMin ?? 999;
        block.srvAgeMin = ageMin;
        const sinceSrv = Math.max(0, last.cost - costAtSrv);
        const trust = !srvFresh ? 'blind'
                    : ageMin > BLIND_MIN ? 'blind'
                    : ageMin > STALE_MIN ? 'stale'
                    : sinceSrv > 0 && perPct ? 'extrap' : 'fact';
        block.trust = trust;
        block.realPctSrv = Math.round(srvPct);

        // Carrying local cost on top of the anchor is only honest while the
        // anchor is fresh. Past that the strip shows what was measured, not what
        // was imagined - and it never walks backwards inside one window.
        let pctNow = srvPct;
        if ((trust === 'extrap' || trust === 'fact') && perPct) pctNow = Math.min(999, srvPct + sinceSrv / perPct);
        // The extrapolation must not jitter downwards - a number that walks back
        // reads as a bug and it did so 11 times in 1.7 h. A NEW server answer is
        // a measurement, though, and it is allowed to correct the guess in both
        // directions, so the ratchet resets whenever the anchor moves.
        if (shownPct && sameWin(shownPct.win, winKey) && shownPct.srvAt === usage.at) {
          pctNow = Math.max(pctNow, shownPct.pct);
        }
        shownPct = { win: winKey, srvAt: usage.at, pct: pctNow };
        try { atomicWrite(SHOWN_PATH, JSON.stringify(shownPct)); } catch (e) { console.error('[cc-widget] shown_pct не записан:', e.message); }
        block.realPct = Math.round(pctNow);
        block.extrapolated = trust === 'extrap';

        // Pace: cost is the only source that reacts in a minute, and with
        // cacheRead weighted out it tracks the quota (corr 0.685 vs -0.093).
        // The server slope, when there are enough samples, bounds it: a cost
        // estimate more than 2.5x off the measured slope is the estimate lying.
        if (perPct && trust !== 'blind' && trust !== 'stale') {
          let pph = ratePerSec * 3600 / perPct;
          if (srvSlope !== null && srvSlope > 0.5) pph = Math.min(pph, srvSlope * 2.5);
          // The bound above is the only thing standing between a burst and a
          // four-hour horizon, and it needs four server samples - twenty minutes -
          // to exist. For the first minutes of every window there is nothing to
          // hold it: three minutes of heavy work projected to the reset published
          // 545 %, which is not a forecast, it is the leaky kernel amplified by the
          // runway. Hiding the number instead was worse - the forecast is the one
          // thing the strip is read for. Bound it by the user's own history: a
          // window that would finish above the p90 of every window they have ever
          // completed is extrapolating a burst, not predicting a day. The cap is
          // never below what is already spent, so a genuinely record window still
          // shows its own number and still goes red.
          const projCap = quantile(0.9);
          if (srvSlope === null && projCap && remainH > 0.01) {
            const capPph = Math.max(0, (Math.max(projCap, last.cost) - last.cost) / perPct) / remainH;
            pph = Math.min(pph, capPph);
            block.projCapped = true;
          }
          block.pctPerHour = Math.round(pph * 10) / 10;
          block.pctPerHourFast = Math.round((fastNow * 3600 / perPct) * 10) / 10;
          const projPct = Math.min(999, pctNow + pph * remainH);
          block.realProjPct = Math.round(projPct);
          block.realProjDelta = Math.round(projPct - 100);
          // A point forecast hides that the two kernels disagree by 3x. The band
          // is the honest object: slow and fast pace, plus the measured server
          // slope when there is one, projected to the reset.
          // ...but only once there IS a disagreement to report. Before the server
          // slope exists both kernels collapse onto the same prior (the weight w
          // goes to zero with winSec), so the "band" is one guess printed twice,
          // multiplied by a horizon/observation ratio of 400x: 999-999 % at 45
          // seconds into a window. The strip takes its colour from the upper end,
          // so that band painted slot B red over an honest 98 %. The cap that
          // holds the point forecast in that stretch cannot hold the band -
          // min(cand, capPph) would print "98-98 %", claiming zero uncertainty at
          // the moment of maximum uncertainty. Publish the band exactly when it is
          // a measurement, i.e. when srvSlope is one; widget.ps1 already falls
          // back to the point forecast for both ends.
          if (srvSlope !== null && srvSlope >= 0) {
            const cands = [slowNow * 3600 / perPct, fastNow * 3600 / perPct, srvSlope];
            const lo = Math.min(...cands), hi = Math.max(...cands);
            block.realProjLo = Math.round(Math.min(999, pctNow + lo * remainH));
            block.realProjHi = Math.round(Math.min(999, pctNow + hi * remainH));
          }
          const leftPct = 100 - pctNow;
          block.realEtaMin = pph > 0 && leftPct > 0
            ? Math.min(block.remainingMin, Math.round(leftPct / pph * 60))
            : (leftPct <= 0 ? 0 : null);
          block.realEtaAt = block.realEtaMin !== null
            ? new Date(now + block.realEtaMin * 60e3).toISOString() : null;
        } else if (srvSlope !== null && trust === 'stale') {
          // no carrying, but a measured slope is still a measured slope
          block.pctPerHour = Math.round(srvSlope * 10) / 10;
          block.realProjPct = Math.round(Math.min(999, pctNow + srvSlope * remainH));
          block.realProjDelta = block.realProjPct - 100;
        }
      }

      if (cfg.capsBlockCost) {
        // only when a real cap is configured by hand (e.g. read off /usage)
        block.pctCapReal = pct(last.cost, cfg.capsBlockCost);
        block.projPct = Math.round((projCost / cfg.capsBlockCost) * 100);
        block.projDelta = block.projPct - 100;
        const left = cfg.capsBlockCost - last.cost;
        block.etaLimitMin = ratePerSec > 0 && left > 0
          ? Math.round(left / (ratePerSec * 60)) : (left <= 0 ? 0 : null);
      }
    }
  }

  const data = {
    updatedAt: new Date(now).toISOString(),
    plan: cfg.plan,
    metric: 'cost-weighted tokens',
    caps: { blockCost: cfg.capsBlockCost ?? null, weekCost: cfg.capsWeekCost ?? null },
    // lastErr/fails travel even on a successful-but-old answer: without them a
    // silent backoff looks identical to a healthy poll that just answered.
    // logsUnavailable is not the same as "nobody is working": an unreadable
    // projects dir looked exactly like an idle window.
    logsUnavailable: !sc.dirOk,
    // the field is named `error` because that is what both the console line and
    // the strip's tooltip read; as `lastErr` the failure never reached either
    usage: usage.ok ? { at: usage.at, ageMin: usage.ageMin, stale: usage.stale,
                        error: usage.error || null, warn: usage.warn || null,
                        fails: usage.fails || 0, retryAt: usage.retryAt || null, netFail: !!usage.netFail,
                        fivePct: usage.five.pct, fiveResetsAt: iso(usage.five.resetsAt),
                        weekPct: usage.week?.pct ?? null, weekResetsAt: iso(usage.week?.resetsAt) }
                    : { error: usage.error || 'нет данных', retryAt: usage.retryAt || null, netFail: !!usage.netFail },
    lastQuotaEvent: quota ? { at: iso(quota.t), type: quota.type,
                              resetsAt: iso(quota.resetsAt) } : null,
    // a config that could not be read changes cacheRead, credPath and the tick
    // interval; it has to be visible somewhere the strip can show it
    configError: cfgError,
    futureRows: sc.futureRows || 0,
    today, week, block
  };

  const parts = block && block.realPct !== undefined
    ? [`5h:${block.realPct}%`,
       usage.week?.pct !== null && usage.week?.pct !== undefined ? `Wk:${Math.round(usage.week.pct)}%` : 'Wk:--',
       block.realProjDelta !== undefined
         ? `P:${block.realProjDelta >= 0 ? '+' : ''}${block.realProjDelta}%` : 'P:--']
    : [block ? `T${block.pctTime}%` : 'idle',
       block ? `B${fmt(block.costPerHour)}/h` : 'B--',
       block && block.projPctHist !== null ? `P${block.projPctHist}` : 'P--'];
  atomicWrite(path.join(cfg.outDir, 'data.json'), JSON.stringify(data));
  atomicWrite(path.join(cfg.outDir, 'data.txt'), parts.join(' | '));
  return data;
}

// A shared .tmp name plus overlapping ticks produced three EPERM renames in the
// service log. The name is now unique per write, and a rename losing the race
// with the strip's own open handle is retried instead of killing the tick.
function atomicWrite(p, s) {
  const tmp = p + '.' + process.pid + '.' + (writeSeq++) + '.tmp';
  try {
    fs.writeFileSync(tmp, s);
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, p); return; }
      catch (e) {
        if (i >= 4 || (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) throw e;
        const until = Date.now() + 25;
        while (Date.now() < until) { /* the reader holds it for microseconds */ }
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch { } }
}
let writeSeq = 0;

// setInterval fires on schedule whether or not the previous run finished; ticks
// of 480 053 ms are in the log. Overlap is skipped, not queued.
let running = false;

async function run() {
  if (running) return;
  running = true;
  const t0 = Date.now();
  try {
    const d = await collect();
    const b = d.block;
    const wk = d.week.pctCap === null ? d.week.cost : `${d.week.cost}/${d.week.pctCap}%`;
    console.log(`[cc-widget] ${d.updatedAt} today=${d.today.cost} wk=${wk} ` +
      (b ? `blk=${b.cost} t${b.pctTime}% burn=${b.costPerHour}/h ` +
           (b.realPct !== undefined
              ? `real=${b.realPct}%${b.realProjPct !== undefined ? '->' + b.realProjPct + '%' : ''} ${b.trust}/${b.srvAgeMin}м/n${b.srvSamples}`
              : `projHist=p${b.projPctHist}`)
         : 'blk=idle') +
      (d.usage.error ? ` usage!=${d.usage.error}` : '') + ` (${Date.now() - t0}ms)`);
  } catch (e) {
    console.error('[cc-widget] error:', e.message);
  } finally {
    running = false;
  }
}

if (process.argv.includes('--once')) {
  run();
} else {
  run();
  setInterval(run, cfg.intervalSec * 1000);
}
