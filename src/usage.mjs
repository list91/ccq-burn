// Authoritative quota state from Anthropic's own OAuth usage endpoint.
//
// This is the same undocumented endpoint the /usage panel inside Claude Code
// uses: it returns the real utilisation percentages, so the widget no longer has
// to guess a cap from the logs. It is NOT a public API and can disappear without
// notice — every caller must survive a null result and fall back to the
// log-derived numbers.
//
// Two hard-won rules, both enforced below:
//   * send a claude-code User-Agent, otherwise the request lands in an
//     aggressively rate-limited bucket and gets a permanent 429;
//   * poll slowly (5 min) and back off exponentially on failure.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_USAGE = 'https://api.anthropic.com/api/oauth/usage';
// The collector runs as a service under LocalSystem, whose homedir is
// systemprofile - there are no credentials there. So the path is configurable
// and only falls back to the current user's home for foreground runs.
let CRED = path.join(os.homedir(), '.claude', '.credentials.json');
export function setCredPath(p) { if (p) CRED = p; }
const POLL_MS = 5 * 60e3;
const MAX_BACKOFF_MS = 30 * 60e3;
// A request that got no answer at all (timeout, no route, no DNS) is not the
// server asking us to go away, so it never earns more than the ordinary poll
// rhythm: 1, 2, 4, then 5 min when it never left the machine, 2, 4, 5 after a
// timeout, which may well have reached a slow server. The 30-minute ceiling
// above is for 429/5xx/401.
// 10.09: a timeout during standby left a 30-min penalty, the machine woke at
// 06:16Z, and the strip sat on СЛЕП over a working network until 06:36Z.
const NET_RETRY_MS = 60e3;
// Early retries on evidence from the log, and polls asked for by the button, are
// both rate-limit budget: counted over a sliding hour, never refilled by a
// success - a flapping network succeeds often, and a per-episode allowance
// refilled on every success came to 39 requests an hour against a 12/h rhythm.
const NET_CURE_GAP_MS = 60e3;
const NET_CURES_PER_HOUR = 3;
const MANUAL_PER_HOUR = 6;
const HOUR_MS = 3600e3;
const recent = (list, now) => (Array.isArray(list) ? list : [])
  .filter((t) => typeof t === 'number' && Number.isFinite(t) && t <= now + 60e3 && now - t < HOUR_MS)
  .slice(-10);

// What kind of failure an exception is: 'timeout' (the request may have reached
// the server), 'unreach' (it never left: DNS, route, refused), or false - an
// answer came back. `redirect: 'error'` surfaces a 3xx as «fetch failed» too, but
// that is the server answering, and it gets the server's backoff.
function netKind(e) {
  if (!e || e.status) return false;
  if (/redirect/i.test(String(e.cause?.message || ''))) return false;
  if (e.name === 'TimeoutError' || /abort/i.test(e.message || '')) return 'timeout';
  if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(e.message || '')) return 'unreach';
  return false;
}

// The failures a rewrite of the credentials by the CLI actually cures. A 429 or
// a 5xx is not among them: the CLI refreshes its token about once an hour, and
// clearing a throttle penalty on that is one more request into the throttle.
const TOKEN_FAIL = /^(нет файла токена|токен нечитаем|нет OAuth-токена|нет refresh-токена|refresh-токен |токен протух|токен отвергнут|обновление токена: (файл|таймаут|сеть|ответ))/;
const STALE_MS = 20 * 60e3;   // older than this and the numbers stop being trusted
const MAX_SKEW_MS = 24 * 3600e3;

// The access token lives one hour. Nothing but the CLI used to renew it, so the
// widget spent most of its life blind for want of a request it could make itself.
// These three constants are read out of the CLI bundle, not invented: the same
// endpoint, client and grant it uses for its own refresh.
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// renew before the token actually dies, so the poll after it is still a fact
const REFRESH_SKEW_MS = 10 * 60e3;
// a failing refresh must not turn into a request loop
const REFRESH_MIN_GAP_MS = 60e3;

function readCred() {
  try { return { j: JSON.parse(fs.readFileSync(CRED, 'utf8')) }; }
  catch (e) { return { err: e }; }
}

// writeFileSync truncates first: a kill in that window leaves a zero-length
// cache, and with it goes the backoff that keeps this process off a throttling
// endpoint. Unique tmp + rename, same shape as the collector's data.json write.
let cacheSeq = 0;
function atomicWrite(p, s) {
  const tmp = p + '.' + process.pid + '.' + (cacheSeq++) + '.tmp';
  try {
    fs.writeFileSync(tmp, s);
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, p); return; }
      catch (e) {
        if (i >= 4 || (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) throw e;
        const until = Date.now() + 25;
        while (Date.now() < until) { /* reader holds it for microseconds */ }
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch { } }
}

// A tmp file plus rename, never a truncate. The old version opened the live
// credentials with 'r+', called ftruncateSync(fd, 0) and only then wrote 79 KB
// back: anything that stopped the process inside that window - power, sleep,
// ENOSPC, a service restart - left a zero-length file, and with it went
// claudeAiOauth AND all 128 mcpOAuth entries, recoverable only by /login plus a
// re-auth of every MCP server. The justification for writing in place was that a
// rename would hand the file a fresh ACL: measured false. Every ACE on
// .credentials.json is inherited (icacls shows (I) on all five,
// AreAccessRulesProtected=False), and a file freshly created in that same
// directory comes out with a byte-identical DACL, so the replacement inherits
// exactly what the original had. See writecred_test.mjs, which asserts it.
let credSeq = 0;
function writeCred(obj) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  const parsed = JSON.parse(buf.toString('utf8'));  // never write what we cannot read back
  // A refresh only ever touches claudeAiOauth. Losing any other top-level key -
  // mcpOAuth above all - means a bug upstream built a smaller object, and that
  // must not reach the disk however well the write itself works.
  let before = null;
  try { before = JSON.parse(fs.readFileSync(CRED, 'utf8')); } catch { }
  if (before && typeof before === 'object') {
    for (const k of Object.keys(before)) {
      if (!(k in parsed)) throw new Error('отказ записи: пропало поле ' + k);
    }
    const nb = before.mcpOAuth && typeof before.mcpOAuth === 'object'
      ? Object.keys(before.mcpOAuth).length : 0;
    const na = parsed.mcpOAuth && typeof parsed.mcpOAuth === 'object'
      ? Object.keys(parsed.mcpOAuth).length : 0;
    if (na < nb) throw new Error('отказ записи: mcpOAuth ' + nb + ' -> ' + na);
  }
  const tmp = CRED + '.' + process.pid + '.' + (credSeq++) + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      let off = 0;
      while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, off);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, CRED); break; }
      catch (e) {
        if (i >= 4 || (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) throw e;
        const until = Date.now() + 25;
        while (Date.now() < until) { /* the CLI holds it for microseconds */ }
      }
    }
    // read back: a rename that "succeeded" onto an unreadable file is the one
    // failure this whole scheme exists to prevent, and it costs one 79 KB read
    const rb = JSON.parse(fs.readFileSync(CRED, 'utf8'));
    if (!rb?.claudeAiOauth?.accessToken) throw new Error('после записи файл без токена');
  } finally { try { fs.unlinkSync(tmp); } catch { } }
}

// Returns { token } or { why }. Never returns or logs the token itself.
async function refreshAccessToken(now) {
  const { j, err } = readCred();
  if (err) return { why: 'обновление токена: файл недоступен' };
  const o = j && j.claudeAiOauth;
  if (!o || !o.refreshToken) return { why: 'нет refresh-токена (claude /login)' };
  if (o.refreshTokenExpiresAt && o.refreshTokenExpiresAt < now) {
    return { why: 'refresh-токен истёк (claude /login)' };
  }
  let r;
  try {
    r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'claude-code/2.0.0 (external, cli)',
        accept: 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: o.refreshToken,
        client_id: CLIENT_ID,
        scope: Array.isArray(o.scopes) ? o.scopes.join(' ') : ''
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15e3)
    });
  } catch (e) {
    const net = netKind(e);
    if (!net) return { why: 'обновление токена: ' + (e.message || 'ошибка запроса') };
    return { why: 'обновление токена: ' + (net === 'timeout' ? 'таймаут' : 'сеть недоступна'), net };
  }
  if (!r.ok) {
    // 400/401 here means the refresh token itself is dead; only a login fixes it
    const dead = r.status === 400 || r.status === 401 || r.status === 403;
    return { why: dead ? 'refresh-токен отвергнут ' + r.status + ' (claude /login)'
                       : 'обновление токена: HTTP ' + r.status };
  }
  let d;
  try { d = await r.json(); } catch { return { why: 'обновление токена: ответ не JSON' }; }
  if (!d || typeof d.access_token !== 'string' || !Number.isFinite(d.expires_in)) {
    return { why: 'обновление токена: ответ без токена' };
  }
  // Re-read: the CLI may have rewritten the file while the request was in flight,
  // and clobbering its newer refresh token would log the user out.
  const cur = readCred();
  const base = cur.j && typeof cur.j === 'object' ? cur.j : j;
  base.claudeAiOauth = Object.assign({}, base.claudeAiOauth || o, {
    accessToken: d.access_token,
    // the server may rotate it; keeping the old one after a rotation is a logout
    refreshToken: typeof d.refresh_token === 'string' ? d.refresh_token : o.refreshToken,
    expiresAt: now + d.expires_in * 1000,
    scopes: typeof d.scope === 'string' && d.scope ? d.scope.split(' ') : (o.scopes || [])
  });
  // The server may have ROTATED the refresh token, which kills the old one on its
  // side. Failing to persist the new one here is a permanent logout, so the write
  // is retried, and if it still fails the token is returned anyway (the poll
  // works this hour) together with a loud error the strip can show.
  const rotated = typeof d.refresh_token === 'string' && d.refresh_token !== o.refreshToken;
  let werr = null;
  for (let i = 0; i < 3; i++) {
    try { writeCred(base); werr = null; break; }
    catch (e) { werr = e; }
  }
  if (werr) {
    const why = 'токен обновлён, НЕ СОХРАНЁН (' + (werr.code || werr.message) + ')' +
                (rotated ? ' — refresh-токен ротирован, при перезапуске потребуется claude /login' : '');
    return { token: d.access_token, why };
  }
  return { token: d.access_token };
}

// Four different failures used to arrive as one sentence telling the user to
// run /login: a missing file, an unreadable one, a missing field, and — the
// common case by far — a perfectly good file whose hour-long access token had
// simply aged out. Only the last one is routine, and it needs a different cure.
function readToken() {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(CRED, 'utf8'));
  } catch (e) {
    return { token: null, why: e.code === 'ENOENT'
      ? 'нет файла токена: ' + CRED
      : 'токен нечитаем: ' + (e.code || e.message) };
  }
  const o = j?.claudeAiOauth;
  if (!o?.accessToken) return { token: null, why: 'нет OAuth-токена (claude /login)' };
  // expiresAt is ms since epoch; a stale token only earns a 401, but skipping
  // the call keeps us out of the failure backoff for no reason.
  // A clock pushed forward would otherwise declare a perfectly good token dead
  // forever, so only an expiry that is past by a sane margin counts.
  if (o.expiresAt && o.expiresAt < Date.now() - 60e3) {
    if (!o.refreshToken) return { token: null, why: 'нет refresh-токена (claude /login)' };
    if (o.refreshTokenExpiresAt && o.refreshTokenExpiresAt < Date.now()) {
      return { token: null, why: 'refresh-токен истёк (claude /login)' };
    }
    const h = Math.floor((Date.now() - o.expiresAt) / 3600e3);
    const age = h >= 1 ? h + ' ч' : Math.floor((Date.now() - o.expiresAt) / 60e3) + ' мин';
    return { token: null, why: 'токен протух ' + age + ' назад' };
  }
  return { token: o.accessToken, why: null };
}

// A refresh is only worth attempting when there is something to refresh WITH.
// Without this the «file missing» and «no oauth field» cases were both reported
// as a failed refresh, burying the one sentence that says what to do.
function credHasRefresh() {
  const { j } = readCred();
  return !!(j && j.claudeAiOauth && j.claudeAiOauth.refreshToken);
}

// true when the stored token dies within ms - the trigger to renew early
function tokenExpiresWithin(ms, now) {
  const { j } = readCred();
  const e = j && j.claudeAiOauth && j.claudeAiOauth.expiresAt;
  return typeof e === 'number' && Number.isFinite(e) && e - now < ms;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ts = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : null; };

// The cache file is written by this process but read back after a restart, and
// it sits in a directory the audit found writable by every local account. A
// forged pct/resetsAt would anchor the whole 5h window and drive forced polls,
// so nothing is trusted without a shape check.
function sanitize(raw, now) {
  const s = { at: 0, five: null, week: null, fails: 0, nextTry: 0, error: null, warn: null, forcedAt: 0, noWinForces: 0, credMtime: 0,
              triedAt: 0, netFail: false, cures: [], manuals: [] };
  if (!raw || typeof raw !== 'object') return s;
  const half = (o) => {
    if (!o || typeof o !== 'object') return null;
    const pct = num(o.pct), rs = num(o.resetsAt);
    if (pct === null || pct < 0 || pct > 1000) return null;
    return { pct, resetsAt: rs !== null && Math.abs(rs - now) < 30 * 24 * 3600e3 ? rs : null };
  };
  const at = num(raw.at);
  // a cached instant in the future, or older than a month, means the clock moved
  if (at !== null && at > 0 && at <= now + 60e3 && now - at < 30 * 24 * 3600e3) s.at = at;
  s.five = half(raw.five);
  s.week = half(raw.week);
  if (!s.five) s.at = 0;
  const f = num(raw.fails); s.fails = f !== null && f >= 0 && f < 1e4 ? Math.floor(f) : 0;
  // a restart used to zero the backoff, so a dead token was retried every 5 s of
  // service churn; carry it over, but never further than the maximum backoff
  const nt = num(raw.nextTry);
  s.nextTry = nt !== null && nt > now && nt - now <= MAX_BACKOFF_MS ? nt : 0;
  s.error = typeof raw.error === 'string' ? raw.error.slice(0, 200) : null;
  // survives a restart: a refresh token rotated but not written to disk stays a
  // problem until someone runs `claude /login`, whatever this process does next
  s.warn = typeof raw.warn === 'string' ? raw.warn.slice(0, 200) : null;
  const cm = num(raw.credMtime);
  if (cm !== null && cm > 0 && cm <= now + 60e3) s.credMtime = cm;
  // Both of these are rate-limit budget. Dropping them on load meant a service
  // restart handed out a fresh allowance of forced polls, and the watchdog
  // restarts this service.
  const fa = num(raw.forcedAt);
  if (fa !== null && fa > 0 && fa <= now + 60e3) s.forcedAt = fa;
  const nf = num(raw.noWinForces);
  if (nf !== null && nf >= 0 && nf < 100) s.noWinForces = Math.floor(nf);
  // The network-failure fast path is budget too, same reasoning. A cache from
  // before the flag existed says what kind of failure it holds only in words.
  const ta = num(raw.triedAt);
  if (ta !== null && ta > 0 && ta <= now + 60e3) s.triedAt = ta;
  s.netFail = typeof raw.netFail === 'boolean' ? raw.netFail
            : (s.fails > 0 && /^(таймаут запроса|нет сети|обновление токена: (таймаут|сеть недоступна))$/.test(s.error || ''));
  s.cures = recent(raw.cures, now);
  s.manuals = recent(raw.manuals, now);
  return s;
}

export class UsageProbe {
  constructor(cachePath) {
    this.cachePath = cachePath;
    const now = Date.now();
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { }
    this.state = sanitize(raw, now);
  }

  // Refreshes at most once per POLL_MS; never throws.
  async refresh(now = Date.now(), lastRowT = 0) {
    // A dead token is the one failure that gets cured from outside: the CLI runs,
    // rewrites the credentials, and the penalty we are serving is for a problem
    // that no longer exists. Waiting out a 16-minute backoff after the cure is
    // blindness we chose. A changed mtime is the cheapest possible evidence.
    let credMtime = 0;
    try { credMtime = Math.floor(fs.statSync(CRED).mtimeMs); } catch { }
    if (credMtime && credMtime !== this.state.credMtime) {
      this.state.credMtime = credMtime;
      if (this.state.fails > 0 && TOKEN_FAIL.test(this.state.error || '')) {
        this.state.fails = 0;
        this.state.nextTry = 0;
      }
    }
    // Two different gates wear the same field. After a success nextTry is just
    // the 5-minute poll rhythm and a reset may jump the queue; after a failure it
    // is a penalty, and jumping THAT is what produced 121 attempts/hour against a
    // 5-minute budget - the straight road to a permanent 429.
    // sanitize() clamps this at load; the clock can also move after load, and a
    // nextTry further out than the maximum backoff would freeze polling for good
    if (this.state.nextTry - now > MAX_BACKOFF_MS) this.state.nextTry = now;
    this.takeManualPoll(now);
    if (now < this.state.nextTry) {
      // under a penalty only a network failure with evidence of a cure may jump
      // the queue; without one, a reset or a fresh window may
      const penalised = (this.state.fails || 0) > 0;
      const early = penalised ? this.netRecovered(now, lastRowT)
                              : (this.resetJustPassed(now) || this.noWindowNeedsPoll(now, lastRowT));
      if (!early) return this.snapshot(now);
    }
    let { token, why } = readToken();
    let net = false;
    // Renew before the poll rather than after a 401: an expired token used to
    // cost a failed request, a backoff, and a blind strip until the CLI ran.
    if ((!token || tokenExpiresWithin(REFRESH_SKEW_MS, now)) && credHasRefresh()) {
      if (!token && now - (this.lastRefreshAt || 0) < REFRESH_MIN_GAP_MS) {
        // Too soon to ask the token endpoint again - an early retry or a press
        // came within a minute of a refresh that got no answer. Nothing failed in
        // this tick: booking «токен протух» here turned a network failure into a
        // server-class penalty, which then refused the button and the early
        // retries both. Come back when the gap is over.
        this.state.nextTry = Math.max(this.state.nextTry || 0, this.lastRefreshAt + REFRESH_MIN_GAP_MS);
        return this.snapshot(now);
      }
      if (now - (this.lastRefreshAt || 0) >= REFRESH_MIN_GAP_MS) {
        this.lastRefreshAt = now;
        const rt = await refreshAccessToken(now);
        if (rt.token) {
          token = rt.token;
          // A rotated refresh token that could not be written to disk is the one
          // failure the user MUST act on (`claude /login` after the next
          // restart), and it used to be read only on the !token path, which a
          // successful refresh never reaches. Carry it out of band instead.
          why = rt.why || null;
          this.warn = rt.why || null;
          // our own write must not read back as «the CLI fixed it» next tick
          try { this.state.credMtime = Math.floor(fs.statSync(CRED).mtimeMs); } catch { }
          console.log('[cc-widget] токен обновлён');
        } else if (!token) {
          why = rt.why;
          net = rt.net || false;
        }
      }
    }
    if (!token) {
      this.fail(why, now, undefined, net);
      return this.snapshot(now);
    }
    try {
      const ctl = AbortSignal.timeout(15e3);
      const r = await fetch(URL_USAGE, {
        headers: {
          authorization: 'Bearer ' + token,
          'anthropic-beta': 'oauth-2025-04-20',
          'user-agent': 'claude-code/2.0.0 (external, cli)',
          accept: 'application/json'
        },
        redirect: 'error',
        signal: ctl
      });
      if (!r.ok) {
        const e = new Error('HTTP ' + r.status);
        e.status = r.status;
        // 429 and 503 carry the server's own opinion about when to come back;
        // ignoring it is what turns one throttle into a permanent one
        // Retry-After is a FLOOR the server asks for, not a replacement for our
        // own backoff: honouring a bare "Retry-After: 1" literally turned one
        // throttle into 720 requests an hour against a 12/h budget. Seconds or
        // an HTTP-date, both accepted; anything else falls through to the
        // exponential backoff.
        const rh = r.headers.get('retry-after');
        const ras = Number(rh);
        const rad = Number.isFinite(ras) ? ras * 1000 : (Date.parse(rh || '') - Date.now());
        if (Number.isFinite(rad) && rad > 0) e.retryAfterMs = Math.min(MAX_BACKOFF_MS, rad);
        throw e;
      }
      const j = await r.json();
      const five = j?.five_hour, week = j?.seven_day;
      if (num(five?.utilization) === null) throw new Error('нет five_hour.utilization');
      this.state = {
        at: now,
        five: { pct: num(five.utilization), resetsAt: ts(five.resets_at) },
        week: { pct: num(week?.utilization), resetsAt: ts(week?.resets_at) },
        fails: 0,
        nextTry: now + POLL_MS,
        error: null,
        warn: this.warn || null,
        forcedAt: this.state.forcedAt || 0,
        // Refilled only by an answer that actually names a window. Refilling on
        // any newer answer would refill it 288 times a day, which is the same as
        // having no budget at all.
        noWinForces: ts(five.resets_at) === null ? (this.state.noWinForces || 0) : 0,
        triedAt: now,
        netFail: false,
        cures: this.state.cures || [],
        manuals: this.state.manuals || [],
        // dropped on every success, so after a restart the "the CLI fixed the
        // token" detector started cold and re-cleared the backoff for nothing
        credMtime: this.state.credMtime || 0
      };
      try { atomicWrite(this.cachePath, JSON.stringify(this.state)); } catch { }
    } catch (e) {
      // no status = no answer: the request never came back, so the server has
      // not asked for anything and there is nothing to honour
      this.fail(this.describe(e), now, e?.retryAfterMs, netKind(e));
    }
    return this.snapshot(now);
  }

  // A bare "HTTP 401" and "fetch failed" look the same in the strip's tooltip but
  // mean opposite things: one needs a login, the other needs nothing at all.
  describe(e) {
    const s = e?.status;
    if (s === 401 || s === 403) return 'токен отвергнут ' + s + ' (claude /login)';
    if (s === 429) return 'сервер троттлит (429)';
    if (s >= 500) return 'сервер недоступен (' + s + ')';
    if (/redirect/i.test(String(e?.cause?.message || ''))) return 'сервер ответил редиректом';
    if (e?.name === 'TimeoutError' || /abort/i.test(e?.message || '')) return 'таймаут запроса';
    if (/fetch failed|ENOTFOUND|ECONN/i.test(e?.message || '')) return 'нет сети';
    return e?.message || 'неизвестная ошибка';
  }

  // The known reset instant has come and our newest answer still describes the
  // window that ended. Waiting out the 5-minute poll gate here means carrying a
  // 90 % reading into a window that is actually empty, so ask again at once -
  // rate-limited to one forced call per 30 s in case the server keeps handing
  // back a reset instant that is already in the past.
  resetJustPassed(now) {
    const rs = this.state.five?.resetsAt;
    if (!rs || now < rs + 5e3) return false;
    if ((this.state.at || 0) >= rs) return false;
    if (now - (this.state.forcedAt || 0) < 30e3) return false;
    this.state.forcedAt = now;
    return true;
  }

  // The endpoint publishes a new 5h block a little after it opens, and until it
  // does its answer is «no window» - the one answer carrying no resets_at, so
  // resetJustPassed() cannot fire and the strip waits out the whole five-minute
  // rhythm over a window it can already see in the log. That was five minutes of
  // «no measurement of this window» at every boundary, five times a day.
  // Ask again sooner - but only a few times. The condition renews itself (every
  // fresh row is newer than the last answer), so with no budget an account whose
  // spend never lands in this quota (another login, another subscription) would
  // poll twice a minute for ever. Three attempts at 45 s covers the observed lag
  // and costs 15 extra requests a day against a base of 288.
  noWindowNeedsPoll(now, lastRowT) {
    const f = this.state.five;
    if (!f || Number.isFinite(f.resetsAt) || !(f.pct === 0)) return false;
    if (!lastRowT || lastRowT <= (this.state.at || 0)) return false;
    if ((this.state.noWinForces || 0) >= 3) return false;
    if (now - (this.state.forcedAt || 0) < 45e3) return false;
    this.state.forcedAt = now;
    this.state.noWinForces = (this.state.noWinForces || 0) + 1;
    return true;
  }

  // A failed request with no answer has a cure that shows up in the log first: a
  // Claude Code row newer than our failed attempt means the CLI has just talked
  // to Anthropic over the same network, and the rest of the backoff is blindness
  // we chose. The first attempt after a wake routinely fails before Wi-Fi/VPN is
  // up, so this is the case that matters. Bounded: a minute after the failed
  // attempt (the token refresh may not be asked sooner), three an hour, never
  // refilled by a success - a log that keeps saying «the network is fine» while
  // we keep timing out is not evidence for this process, and the schedule in
  // fail() takes over.
  netRecovered(now, lastRowT) {
    if (!this.state.netFail) return false;
    if (!lastRowT || lastRowT <= (this.state.triedAt || 0)) return false;
    if (now - (this.state.triedAt || 0) < NET_CURE_GAP_MS) return false;
    const cures = recent(this.state.cures, now);
    if (cures.length >= NET_CURES_PER_HOUR) return false;
    this.state.cures = [...cures, now];
    return true;
  }

  // «Перезапустить» in the strip's menu goes through the elevated watchdog,
  // which leaves this marker next to the cache before it restarts the service.
  // A person pressing it is looking at a blind strip and wants an answer now,
  // and for a network failure or a healthy rhythm that is exactly right. A
  // throttle or a rejected token is different: the server asked for the pause,
  // a button does not change its mind, and ⚠️ a 429 answered with more requests
  // is how the whole account gets throttled - those penalties stand.
  takeManualPoll(now) {
    const p = path.join(path.dirname(this.cachePath), 'manual_poll.json');
    let at = null;
    try { at = num(JSON.parse(fs.readFileSync(p, 'utf8'))?.at); } catch (e) {
      if (e.code === 'ENOENT') return;
    }
    try { fs.rmSync(p, { force: true }); } catch { }
    if (at === null || at > now + 60e3 || now - at > 120e3) return;
    if ((this.state.fails || 0) > 0 && !this.state.netFail) {
      console.log('[cc-widget] ручной опрос отклонён: штраф сервера до ' + new Date(this.state.nextTry).toISOString());
      return;
    }
    // once a minute and six an hour, however the button is pressed - a key
    // held down or a script must not become a poll loop
    const manuals = recent(this.state.manuals, now);
    const last = manuals.length ? manuals[manuals.length - 1] : 0;
    if (now - last < 60e3 || manuals.length >= MANUAL_PER_HOUR) {
      console.log('[cc-widget] ручной опрос отклонён: ' + manuals.length + ' за час');
      return;
    }
    this.state.manuals = [...manuals, now];
    this.state.nextTry = 0;
    console.log('[cc-widget] ручной опрос');
  }

  // net: false | 'unreach' | 'timeout' (see netKind); true counts as 'unreach'
  fail(msg, now, retryAfterMs, net = false) {
    const fails = (this.state.fails || 0) + 1;
    const base = net === 'timeout' ? 2 * NET_RETRY_MS : NET_RETRY_MS;
    const own = net
      ? Math.min(POLL_MS, base * 2 ** Math.min(fails - 1, 10))
      : Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(fails - 1, 10));
    const backoff = Math.min(MAX_BACKOFF_MS, Math.max(own, retryAfterMs || 0));
    // keep the last good numbers, just stop hammering the endpoint
    this.state = { ...this.state, fails, error: msg, netFail: !!net, triedAt: now, nextTry: now + backoff };
    // the backoff has to survive a restart, otherwise service churn resets it
    try { atomicWrite(this.cachePath, JSON.stringify(this.state)); } catch { }
  }

  // What the collector should publish: null when we have nothing trustworthy.
  snapshot(now = Date.now()) {
    const s = this.state;
    // when the next attempt is due, so a blind strip can say «повтор в 13:41»
    // instead of leaving the reader to guess whether anything is still trying
    const retryAt = (s.fails || 0) > 0 && s.nextTry > now ? new Date(s.nextTry).toISOString() : null;
    // whether the button can cut the wait short: only a network failure, never
    // a pause the server asked for
    const netFail = (s.fails || 0) > 0 && !!s.netFail;
    if (!s.at || !s.five) return { ok: false, error: s.error, fails: s.fails || 0, retryAt, netFail };
    // a clock moved backwards would otherwise report a negative age and pass the
    // freshness gate with data that is in fact old
    // A clock moved backwards used to clamp the age to 0 and hand the collector
    // an answer of any age labelled "measured this second", while nextTry sat in
    // the future so no new poll could correct it. A sample stamped in our own
    // future is not fresh, it is unusable: report it as maximally stale so the
    // strip drops to what was actually measured.
    const raw = now - s.at;
    const skewed = raw < -60e3;
    const ageMs = skewed ? MAX_SKEW_MS : Math.max(0, Math.min(raw, MAX_SKEW_MS));
    return {
      ok: true,
      at: new Date(s.at).toISOString(),
      ageMin: Math.round(ageMs / 60e3),
      ageMs,
      clockSkew: skewed,
      stale: ageMs > STALE_MS,
      five: s.five,
      week: s.week,
      error: s.error,
      warn: s.warn || null,
      fails: s.fails || 0,
      retryAt,
      netFail
    };
  }
}
