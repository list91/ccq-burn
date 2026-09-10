// Regression suite for usage.mjs. NO network: the credentials path is pointed at
// a file that does not exist, so readToken() fails before any fetch is reached.
// Usage: node usage_regress.mjs <old|new>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const which = process.argv[2] || 'new';
const mod = await import('../src/usage.mjs');
const { UsageProbe, setCredPath } = mod;
setCredPath(path.join(os.tmpdir(), 'cc_widget_no_such_cred_' + process.pid + '.json'));

let pass = 0, fail = 0;
const check = (n, got, want, ok) => {
  const good = ok !== undefined ? ok : JSON.stringify(got) === JSON.stringify(want);
  if (good) { pass++; console.log('  PASS ' + n + '  -> ' + JSON.stringify(got)); }
  else { fail++; console.log('  FAIL ' + n + '  got ' + JSON.stringify(got) + '  want ' + JSON.stringify(want)); }
};
const POLL_MS = 5 * 60e3, MAX_BACKOFF = 30 * 60e3;
const cache = path.resolve('uc_' + which + '.json');
const fresh = () => { try { fs.unlinkSync(cache); } catch { } return new UsageProbe(cache); };

console.log('=== usage regress ' + which + ' ===');

// ---- FIX 6: Retry-After is a floor, never a replacement --------------------
{
  const now = 1788900000000;
  const p = fresh();
  p.fail('сервер троттлит (429)', now, 1000);          // "Retry-After: 1"
  check('FIX6 Retry-After:1 -> пауза >= 5 мин', p.state.nextTry - now, POLL_MS, p.state.nextTry - now >= POLL_MS);
  const perHour = 3600e3 / Math.max(1, p.state.nextTry - now);
  check('FIX6 запросов в час <= 12', Math.round(perHour), 12, perHour <= 12);
}
{
  const now = 1788900000000;
  const p = fresh();
  p.fail('x', now, 25 * 60e3);                          // server asks for 25 min
  check('FIX6 длинный Retry-After уважается', p.state.nextTry - now, 25 * 60e3);
}
{
  const now = 1788900000000;
  const p = fresh();
  for (let i = 0; i < 4; i++) p.fail('x', now, 1000);   // 4 failures, tiny Retry-After
  // 4 failures -> 5*2^3 = 40 min, capped at the 30-minute maximum
  check('FIX6 экспонента не сбрасывается', p.state.nextTry - now, MAX_BACKOFF);
}
{
  const now = 1788900000000;
  const p = fresh();
  p.fail('x', now, 10 * 3600e3);                        // absurd Retry-After
  check('FIX6 потолок 30 мин', p.state.nextTry - now, MAX_BACKOFF);
}

// ---- FIX 7: a clock moved backwards is not freshness ------------------------
{
  const now = 1788900000000;
  const p = fresh();
  p.state = { at: now + 3 * 3600e3, five: { pct: 42, resetsAt: now + 4 * 3600e3 },
              week: null, fails: 0, nextTry: now + 3 * 3600e3, error: null, forcedAt: 0, credMtime: 0 };
  const s = p.snapshot(now);
  check('FIX7 ageMin не 0 при часах назад', s.ageMin, 1440, s.ageMin > 20);
  check('FIX7 помечен stale', s.stale, true);
}
// ...and a normal fresh answer still reads as fresh
{
  const now = 1788900000000;
  const p = fresh();
  p.state = { at: now - 30e3, five: { pct: 42, resetsAt: now + 4 * 3600e3 },
              week: null, fails: 0, nextTry: now + POLL_MS, error: null, forcedAt: 0, credMtime: 0 };
  const s = p.snapshot(now);
  check('FIX7 нормальный ответ остался свежим', [s.ageMin, s.stale], [1, false], s.ageMin <= 1 && s.stale === false);
}
// ...and a runaway nextTry does not freeze polling for ever
{
  const now = 1788900000000;
  const p = fresh();
  p.state = { at: now - 60e3, five: { pct: 42, resetsAt: now + 4 * 3600e3 },
              week: null, fails: 1, nextTry: now + 10 * 3600e3, error: 'x', forcedAt: 0, credMtime: 0 };
  await p.refresh(now);            // no network: the credentials file is absent
  check('FIX7 убежавший nextTry подрезан', p.state.nextTry - now <= MAX_BACKOFF, true);
}

// ---- FIX 8: state writes are atomic ---------------------------------------
{
  const now = 1788900000000;
  const p = fresh();
  p.fail('x', now);
  const before = fs.readFileSync(cache, 'utf8');
  check('FIX8 кэш — валидный JSON', (() => { try { JSON.parse(before); return true; } catch { return false; } })(), true);
  // a write that dies at the rename must leave the previous file whole
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('boom'); e.code = 'ENOSPC'; throw e; };
  try { p.fail('y', now + 1); } catch { }
  fs.renameSync = realRename;
  const after = fs.readFileSync(cache, 'utf8');
  check('FIX8 сорванная запись не тронула файл', after, before);
  check('FIX8 tmp-мусор убран',
    fs.readdirSync(path.dirname(cache)).filter(f => f.startsWith(path.basename(cache) + '.')).length, 0);
}
try { fs.unlinkSync(cache); } catch { }

// ---- FIX21: the bounded force-poll after a "no window" answer ---------------
// The endpoint answers "no window" (no resets_at) until it publishes the block
// that has already opened. resetJustPassed() cannot fire on that answer - it
// needs a resets_at - so the strip used to wait out the full five minutes with a
// window it could already see in the log.
{
  const now = 1788900000000;
  const p = fresh();
  p.state = { ...p.state, at: now - 60e3, five: { pct: 0, resetsAt: null }, nextTry: now + POLL_MS };
  check('FIX21 нет окна + свежая строка -> опросить', p.noWindowNeedsPoll(now, now - 10e3), true);
  check('FIX21 троттл 45 с держит', p.noWindowNeedsPoll(now + 10e3, now), false);
  check('FIX21 второй форс через 45 с', p.noWindowNeedsPoll(now + 46e3, now), true);
  check('FIX21 третий форс', p.noWindowNeedsPoll(now + 92e3, now), true);
  check('FIX21 бюджет исчерпан на четвёртом', p.noWindowNeedsPoll(now + 138e3, now), false);
  check('FIX21 бюджет не восстанавливается временем', p.noWindowNeedsPoll(now + 3600e3, now), false);
}
// no rows since the answer: nothing to ask about
{
  const now = 1788900000000;
  const p = fresh();
  p.state = { ...p.state, at: now - 60e3, five: { pct: 0, resetsAt: null } };
  check('FIX21 без новых строк не опрашиваем', p.noWindowNeedsPoll(now, now - 120e3), false);
}
// a window the server has named is not a "no window" answer
{
  const now = 1788900000000;
  const p = fresh();
  p.state = { ...p.state, at: now - 60e3, five: { pct: 3, resetsAt: now + 3600e3 } };
  check('FIX21 окно названо - форса нет', p.noWindowNeedsPoll(now, now - 10e3), false);
}
// the budget and the throttle must survive a restart: the watchdog restarts this
// service, and a zeroed forcedAt is a throttle that does not exist
{
  const now = 1788900000000;
  const p = fresh();
  p.state = { ...p.state, at: now - 60e3, five: { pct: 0, resetsAt: null }, forcedAt: now - 5e3, noWinForces: 3 };
  fs.writeFileSync(cache, JSON.stringify(p.state));
  const p2 = new UsageProbe(cache);
  check('FIX21 бюджет пережил рестарт', p2.state.noWinForces, 3);
  check('FIX21 троттл пережил рестарт', p2.state.forcedAt, now - 5e3);
  check('FIX21 после рестарта форса нет', p2.noWindowNeedsPoll(now, now - 1e3), false);
}


// ---- FIX23: a request with no answer is not the server asking us to wait ----
// 10.09: a timeout during standby earned the full 30-minute penalty, the machine
// woke, and the strip sat on СЛЕП over a working network for 20 minutes.
{
  const now = 1788900000000;
  const p = fresh();
  const steps = [];
  for (let i = 0; i < 6; i++) { p.fail('таймаут запроса', now, undefined, true); steps.push((p.state.nextTry - now) / 60e3); }
  check('FIX23 сетевой бэкофф 1/2/4/5/5/5 мин', steps, [1, 2, 4, 5, 5, 5]);
  check('FIX23 помечен как сетевой', p.state.netFail, true);
  check('FIX23 triedAt записан', p.state.triedAt, now);
}
// a timeout may have reached a slow server: one step slower than «never left»
{
  const now = 1788900000000;
  const p = fresh();
  const steps = [];
  for (let i = 0; i < 4; i++) { p.fail('таймаут запроса', now, undefined, 'timeout'); steps.push((p.state.nextTry - now) / 60e3); }
  check('FIX26 таймаут: 2/4/5/5 мин', steps, [2, 4, 5, 5]);
  const q = fresh();
  const s2 = [];
  for (let i = 0; i < 4; i++) { q.fail('нет сети', now, undefined, 'unreach'); s2.push((q.state.nextTry - now) / 60e3); }
  check('FIX26 не ушёл с машины: 1/2/4/5 мин', s2, [1, 2, 4, 5]);
}
{
  const now = 1788900000000;
  const p = fresh();
  for (let i = 0; i < 3; i++) p.fail('таймаут запроса', now, undefined, true);
  p.fail('сервер троттлит (429)', now, 1000);
  check('FIX23 429 после сетевых — снова длинный', p.state.nextTry - now, MAX_BACKOFF);
  check('FIX23 429 снимает сетевой флаг', p.state.netFail, false);
}
// the log is the evidence: a row newer than our failed attempt
{
  const now = 1788900000000;
  const p = fresh();
  p.fail('таймаут запроса', now, undefined, true);
  check('FIX23 строка старше попытки — не повод', p.netRecovered(now + 70e3, now - 1), false);
  check('FIX23 свежая строка, но < 60 с', p.netRecovered(now + 50e3, now + 10e3), false);
  check('FIX23 свежая строка через 60 с — опросить', p.netRecovered(now + 61e3, now + 10e3), true);
  p.fail('таймаут запроса', now + 61e3, undefined, true);
  check('FIX23 второе излечение', p.netRecovered(now + 122e3, now + 70e3), true);
  p.fail('таймаут запроса', now + 122e3, undefined, true);
  check('FIX23 третье излечение', p.netRecovered(now + 183e3, now + 130e3), true);
  p.fail('таймаут запроса', now + 183e3, undefined, true);
  check('FIX23 бюджет 3 в час исчерпан', p.netRecovered(now + 300e3, now + 250e3), false);
  // ⚠️ a success does not refill it: a flapping network succeeds often
  p.state = { ...p.state, fails: 0, netFail: false, error: null };
  p.fail('таймаут запроса', now + 400e3, undefined, true);
  check('FIX26 успех бюджет не пополняет', p.netRecovered(now + 470e3, now + 420e3), false);
  // the window slides: an hour after the first two cures, room for two again
  p.fail('таймаут запроса', now + 3700e3, undefined, true);
  check('FIX26 через час окно сдвинулось', p.netRecovered(now + 3770e3, now + 3720e3), true);
}
{
  const now = 1788900000000;
  const p = fresh();
  p.fail('сервер троттлит (429)', now, 1000);
  check('FIX23 штраф сервера лог не снимает', p.netRecovered(now + 60e3, now + 30e3), false);
}
// through refresh(): the credentials file is absent, so an attempt shows up as
// the error turning into «нет файла токена» and nothing reaches the network
{
  const now = 1788900000000;
  const p = fresh();
  p.state = { ...p.state, at: now - 3600e3, five: { pct: 6, resetsAt: now + 3600e3 } };
  p.fail('таймаут запроса', now, undefined, 'timeout');   // 2 min: room for an early retry
  await p.refresh(now + 50e3, now + 10e3);
  check('FIX23 refresh: без 60 с не лезет', p.state.error, 'таймаут запроса');
  await p.refresh(now + 65e3, now - 5e3);
  check('FIX23 refresh: без свежей строки не лезет', p.state.error, 'таймаут запроса');
  await p.refresh(now + 65e3, now + 30e3);
  check('FIX23 refresh: свежая строка -> попытка', /нет файла токена/.test(p.state.error || ''), true);
}
// the budget, the evidence clock and the manual throttle survive a restart
{
  const now = Date.now();
  const p = fresh();
  p.state = { ...p.state, at: now - 3600e3, five: { pct: 6, resetsAt: now + 3600e3 } };
  p.fail('таймаут запроса', now - 5e3, undefined, true);
  p.state.cures = [now - 2 * 3600e3, now - 20e3, now - 15e3, 'x']; p.state.manuals = [now - 10e3];
  fs.writeFileSync(cache, JSON.stringify(p.state));
  const p2 = new UsageProbe(cache);
  check('FIX23 рестарт: netFail', p2.state.netFail, true);
  check('FIX23 рестарт: cures (старше часа и мусор отброшены)', p2.state.cures, [now - 20e3, now - 15e3]);
  check('FIX23 рестарт: triedAt', p2.state.triedAt, now - 5e3);
  check('FIX23 рестарт: manuals', p2.state.manuals, [now - 10e3]);
}
// a cache written before the flag existed: the kind of failure is in the words
{
  const now = Date.now();
  const base = { at: now - 3600e3, five: { pct: 6, resetsAt: now + 3600e3 }, week: null, fails: 6, nextTry: now + 20 * 60e3 };
  fs.writeFileSync(cache, JSON.stringify({ ...base, error: 'таймаут запроса' }));
  check('FIX23 старый кэш: таймаут = сетевой', new UsageProbe(cache).state.netFail, true);
  fs.writeFileSync(cache, JSON.stringify({ ...base, error: 'обновление токена: сеть недоступна' }));
  check('FIX23 старый кэш: сеть при обновлении = сетевой', new UsageProbe(cache).state.netFail, true);
  fs.writeFileSync(cache, JSON.stringify({ ...base, error: 'сервер троттлит (429)' }));
  check('FIX23 старый кэш: 429 не сетевой', new UsageProbe(cache).state.netFail, false);
  fs.writeFileSync(cache, JSON.stringify({ ...base, fails: 0, error: 'таймаут запроса' }));
  check('FIX23 старый кэш: без штрафа не сетевой', new UsageProbe(cache).state.netFail, false);
}
// the tooltip needs to know when the next attempt is
{
  const now = 1788900000000;
  const p = fresh();
  p.state = { ...p.state, at: now - 60e3, five: { pct: 6, resetsAt: now + 3600e3 }, nextTry: now + POLL_MS };
  check('FIX23 retryAt нет без штрафа', p.snapshot(now).retryAt, null);
  p.fail('таймаут запроса', now, undefined, true);
  check('FIX23 retryAt = nextTry', p.snapshot(now).retryAt, new Date(now + 60e3).toISOString());
  const q = fresh();
  q.fail('таймаут запроса', now, undefined, true);
  check('FIX23 retryAt и без замера', q.snapshot(now).retryAt, new Date(now + 60e3).toISOString());
}

// ---- FIX24: the manual poll behind «Перезапустить» ---------------------------
{
  const marker = path.join(path.dirname(cache), 'manual_poll.json');
  const drop = (at) => fs.writeFileSync(marker, JSON.stringify({ at }));
  const gone = () => !fs.existsSync(marker);
  const withState = (now, extra) => {
    const p = fresh();
    p.state = { ...p.state, at: now - 600e3, five: { pct: 6, resetsAt: now + 3600e3 }, ...extra };
    return p;
  };
  // a network penalty: the press cuts it short
  {
    const now = Date.now();
    const p = withState(now, {});
    p.fail('таймаут запроса', now - 10e3, undefined, true);
    drop(now - 2e3);
    await p.refresh(now, 0);
    check('FIX24 сеть: ручной опрос выполнен', /нет файла токена/.test(p.state.error || ''), true);
    check('FIX24 маркер снят', gone(), true);
    check('FIX24 нажатие записано', p.state.manuals, [now]);
  }
  // the ordinary 5-min rhythm: the press asks now
  {
    const now = Date.now();
    const p = withState(now, { fails: 0, nextTry: now + 200e3, error: null });
    drop(now - 2e3);
    await p.refresh(now, 0);
    check('FIX24 без штрафа: опрос сразу', /нет файла токена/.test(p.state.error || ''), true);
  }
  // ⚠️ a server penalty stands: more requests into a 429 throttle the account
  {
    const now = Date.now();
    const p = withState(now, {});
    p.fail('сервер троттлит (429)', now - 10e3, 20 * 60e3);
    const due = p.state.nextTry;
    drop(now - 2e3);
    await p.refresh(now, 0);
    check('FIX24 429: опроса нет', p.state.error, 'сервер троттлит (429)');
    check('FIX24 429: штраф не сдвинут', p.state.nextTry, due);
    check('FIX24 429: маркер всё равно снят', gone(), true);
  }
  // once a minute, however often it is pressed
  {
    const now = Date.now();
    const p = withState(now, { manuals: [now - 20e3] });
    p.fail('таймаут запроса', now - 10e3, undefined, true);
    drop(now - 1e3);
    await p.refresh(now, 0);
    check('FIX24 чаще раза в минуту — нет', p.state.error, 'таймаут запроса');
  }
  // six an hour, however they are spaced - a held key, a script
  {
    const now = Date.now();
    const six = [50, 40, 30, 20, 10, 5].map((m) => now - m * 60e3);
    const p = withState(now, { manuals: six });
    p.fail('таймаут запроса', now - 10e3, undefined, true);
    drop(now - 1e3);
    await p.refresh(now, 0);
    check('FIX26 седьмое нажатие за час — нет', [p.state.error, gone()], ['таймаут запроса', true]);
    const q = withState(now, { manuals: six.slice(1) });
    q.fail('таймаут запроса', now - 10e3, undefined, true);
    drop(now - 1e3);
    await q.refresh(now, 0);
    check('FIX26 шестое — да', /нет файла токена/.test(q.state.error || ''), true);
  }
  // a marker left over from long ago is not a press
  {
    const now = Date.now();
    const p = withState(now, {});
    p.fail('таймаут запроса', now - 10e3, undefined, true);
    drop(now - 300e3);
    await p.refresh(now, 0);
    check('FIX24 старый маркер игнорируется', p.state.error, 'таймаут запроса');
    check('FIX24 старый маркер снят', gone(), true);
  }
  // garbage in the marker
  {
    const now = Date.now();
    const p = withState(now, {});
    p.fail('таймаут запроса', now - 10e3, undefined, true);
    fs.writeFileSync(marker, 'not json');
    await p.refresh(now, 0);
    check('FIX24 мусор в маркере — не нажатие', p.state.error, 'таймаут запроса');
    check('FIX24 мусорный маркер снят', gone(), true);
  }
}

// ---- FIX25: which failures are «no answer» - through a stubbed fetch ---------
// A throwaway credentials file with a fake token; fetch is replaced, so nothing
// leaves the machine.
{
  const fake = path.join(os.tmpdir(), 'cc_widget_fake_cred_' + process.pid + '.json');
  fs.writeFileSync(fake, JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-real-token', refreshToken: 'x',
                                                             expiresAt: Date.now() + 10 * 3600e3 } }));
  setCredPath(fake);
  const realFetch = globalThis.fetch;
  const run = async (stub) => {
    globalThis.fetch = stub;
    const p = fresh();
    const now = Date.now();
    await p.refresh(now, 0);
    return { net: p.state.netFail, wait: Math.round((p.state.nextTry - now) / 60e3), err: p.state.error };
  };
  const timeout = await run(async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; });
  check('FIX25 таймаут -> сетевой, 2 мин', [timeout.net, timeout.wait, timeout.err], [true, 2, 'таймаут запроса']);
  const redirect = await run(async () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); });
  check('FIX26 редирект = ответ сервера, 5 мин', [redirect.net, redirect.wait, redirect.err], [false, 5, 'сервер ответил редиректом']);
  const nonet = await run(async () => { throw new TypeError('fetch failed'); });
  check('FIX25 fetch failed -> сетевой', [nonet.net, nonet.wait, nonet.err], [true, 1, 'нет сети']);
  const throttled = await run(async () => ({ ok: false, status: 429, headers: { get: () => null } }));
  check('FIX25 429 -> не сетевой, 5 мин', [throttled.net, throttled.wait], [false, 5]);
  const down = await run(async () => ({ ok: false, status: 503, headers: { get: () => null } }));
  check('FIX25 503 -> не сетевой', down.net, false);
  const denied = await run(async () => ({ ok: false, status: 401, headers: { get: () => null } }));
  check('FIX25 401 -> не сетевой', denied.net, false);
  const junk = await run(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  check('FIX25 ответ без полей -> не сетевой', junk.net, false);
  const good = await run(async () => ({ ok: true, status: 200,
    json: async () => ({ five_hour: { utilization: 7, resets_at: new Date(Date.now() + 3600e3).toISOString() },
                         seven_day: { utilization: 80, resets_at: new Date(Date.now() + 86400e3).toISOString() } }) }));
  check('FIX25 успех чистит сетевое', [good.net, good.err], [false, null]);
  globalThis.fetch = realFetch;
  setCredPath(path.join(os.tmpdir(), 'cc_widget_no_such_cred_' + process.pid + '.json'));
  try { fs.unlinkSync(fake); } catch { }
}

// ---- FIX26: second vote - refresh gap, cred-rewrite cure, published class ----
{
  const fake = path.join(os.tmpdir(), 'cc_widget_fake_cred26_' + process.pid + '.json');
  const writeFake = (expiresAt) => fs.writeFileSync(fake, JSON.stringify({ claudeAiOauth: {
    accessToken: 'not-a-real-token', refreshToken: 'x', expiresAt } }));
  setCredPath(fake);
  const realFetch = globalThis.fetch;
  const calls = [];
  // an early retry or a press inside the token-refresh gap: nothing failed, so
  // nothing is booked - before, «токен протух» turned a network failure into a
  // server penalty that refused the button and the early retries both
  {
    writeFake(Date.now() - 2 * 3600e3);
    globalThis.fetch = async (u) => { calls.push(String(u)); throw new TypeError('fetch failed'); };
    const now = Date.now();
    const p = fresh();
    await p.refresh(now, 0);
    check('FIX26 обновление без сети -> сетевой', [p.state.error, p.state.netFail, p.state.fails],
          ['обновление токена: сеть недоступна', true, 1]);
    const marker = path.join(path.dirname(cache), 'manual_poll.json');
    fs.writeFileSync(marker, JSON.stringify({ at: now + 9e3 }));
    const n0 = calls.length;
    await p.refresh(now + 10e3, 0);
    check('FIX26 в зазоре обновления: без запроса', calls.length - n0, 0);
    check('FIX26 в зазоре: штраф не переклассифицирован', [p.state.error, p.state.netFail, p.state.fails],
          ['обновление токена: сеть недоступна', true, 1]);
    check('FIX26 в зазоре: ждёт конца зазора', p.state.nextTry, now + 60e3);
    check('FIX26 кнопка в зазоре всё равно показана', p.snapshot(now + 10e3).netFail, true);
  }
  // the CLI rewriting the credentials cures a token failure, not a throttle
  {
    writeFake(Date.now() + 10 * 3600e3);
    globalThis.fetch = async () => ({ ok: true, status: 200,
      json: async () => ({ five_hour: { utilization: 7, resets_at: new Date(Date.now() + 3600e3).toISOString() },
                           seven_day: { utilization: 80, resets_at: new Date(Date.now() + 86400e3).toISOString() } }) });
    const now = Date.now();
    const p = fresh();
    p.fail('сервер троттлит (429)', now - 60e3, 20 * 60e3);
    const due = p.state.nextTry;
    p.state.credMtime = 1;
    await p.refresh(now, 0);
    check('FIX26 ⚠️ перезапись кредов не снимает 429', [p.state.error, p.state.nextTry], ['сервер троттлит (429)', due]);
    const q = fresh();
    q.fail('токен протух 5 мин назад', now - 60e3);
    q.state.credMtime = 1;
    await q.refresh(now, 0);
    check('FIX26 перезапись кредов лечит протухший токен', [q.state.error, q.state.fails], [null, 0]);
  }
  // what the strip is told about the button
  {
    const now = 1788900000000;
    const p = fresh();
    p.fail('нет сети', now, undefined, 'unreach');
    check('FIX26 snapshot: сетевой -> кнопка', p.snapshot(now).netFail, true);
    p.fail('сервер троттлит (429)', now, 1000);
    check('FIX26 snapshot: 429 -> без кнопки', p.snapshot(now).netFail, false);
  }
  globalThis.fetch = realFetch;
  setCredPath(path.join(os.tmpdir(), 'cc_widget_no_such_cred_' + process.pid + '.json'));
  try { fs.unlinkSync(fake); } catch { }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
