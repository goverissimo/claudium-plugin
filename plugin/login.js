#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// plugin/login.js — `/tokenomica:login`, the device-code client (RFC 8628).
//
// WHAT THIS REPLACES: four commands copy-pasted out of the dashboard, one of
// which wrote a bearer token into shell history via a heredoc, and one of
// which globbed ~/.claude/plugins/cache/tokenomica/tokenomica/*/ — an internal
// Claude Code path that is not a stable interface and will eventually move.
// Plus a separate trip to /connect to claim a name and pick a team. All of
// that is now: run this, click Approve.
//
// THE FLOW: ask the dashboard for a pair of codes -> open the browser at a URL
// with the human code prefilled -> poll until a signed-in human approves ->
// write ~/.tokenomica/plugin.json ourselves -> flush anything the outbox has
// been holding.
//
// WHY DEVICE CODE AND NOT A LOOPBACK CALLBACK: a loopback listener only works
// when the browser is on the same machine as the terminal. Plenty of people
// run Claude Code over SSH to a dev box, in a devcontainer, or in a cloud
// session — for all of them a 127.0.0.1 redirect is unreachable. The code is
// one extra click and works everywhere.
//
// Self-contained: only ./lib (vendored) and Node builtins. No npm install.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { configDir } = require('./lib/config-dir');
const { saveOrgSalt, saveOrgPolicy } = require('./lib/anonymize');

const CONFIG_PATH = path.join(configDir(), 'plugin.json');

const PLUGIN_VERSION = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof m.version === 'string' ? m.version : '';
  } catch { return ''; }
})();

// Opens the approval page. Best-effort by DESIGN, not by laziness: over SSH or
// in a container there is no browser to open, and that must be an ordinary,
// well-signposted path rather than a failure — which is exactly why the URL
// and the code are always printed too, before this is even attempted.
function openBrowser(url, { spawnImpl = spawn } = {}) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawnImpl(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch { return false; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function postJson(url, body, fetchImpl) {
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON error page */ }
  return { ok: !!(r && r.ok), status: r && r.status, json };
}

// Merges into any existing config rather than overwriting it: someone may have
// set `tier`, `classify`, or `project_labels` by hand, and re-authenticating
// must not silently reset their sharing preferences.
function writeConfig(url, token, { configPath = CONFIG_PATH } = {}) {
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {}; } catch { /* first run */ }
  const merged = { ...existing, url, token };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

// runLogin({ dashboardUrl, ... }) — the whole command. Never throws: it prints
// what went wrong and returns, because a failed login must not look like a
// crashed Claude Code session.
async function runLogin({
  dashboardUrl,
  fetchImpl = globalThis.fetch,
  configPath = CONFIG_PATH,
  tokenomicaDir = path.dirname(CONFIG_PATH),
  spawnImpl = spawn,
  openImpl = openBrowser,
  sleepImpl = sleep,
  maxWaitMs = 10 * 60 * 1000,
  flushImpl = null,
} = {}) {
  // No URL given: reuse the one already configured, so re-authenticating after
  // a revoked token is just `/tokenomica:login`.
  let base = String(dashboardUrl || '').trim();
  if (!base) {
    try { base = String(JSON.parse(fs.readFileSync(configPath, 'utf8')).url || ''); } catch { /* none */ }
  }
  if (!base) {
    console.log('Usage: /tokenomica:login <your-dashboard-url>');
    console.log('  e.g. /tokenomica:login https://tokenomica.your-company.com');
    return { ok: false, reason: 'no-url' };
  }
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, '');

  let start;
  try {
    start = await postJson(`${base}/api/device/start`, {
      hostname: os.hostname(),
      os: `${process.platform} ${os.release()}`,
      plugin_version: PLUGIN_VERSION,
    }, fetchImpl);
  } catch (e) {
    console.log(`Couldn’t reach ${base} — ${e.message}`);
    return { ok: false, reason: 'unreachable' };
  }
  if (!start.ok || !start.json || !start.json.device_code) {
    // A dashboard that predates this flow has no such route. Say so precisely
    // rather than leaving someone staring at a 404.
    const hint = start.status === 404
      ? 'that dashboard doesn’t support /tokenomica:login yet — ask whoever runs it to update, or set up manually at /connect'
      : `the server said ${start.status || 'nothing'}`;
    console.log(`Couldn’t start sign-in — ${hint}`);
    return { ok: false, reason: 'start-failed' };
  }

  const { device_code: deviceCode, user_code: userCode,
    verification_uri: uri, verification_uri_complete: uriComplete } = start.json;
  let interval = Number(start.json.interval) || 5;

  // Printed BEFORE the browser is opened, always. If the open fails, or opens
  // on the wrong machine, or the user closes the tab, everything they need is
  // already on screen.
  console.log('');
  console.log(`  Approve this machine at:  ${uri}`);
  console.log(`  Your code:                ${userCode}`);
  console.log('');
  // Only claim to have opened a browser if we actually did. Over SSH or in a
  // container this fails, and telling someone their browser is opening when it
  // isn't sends them looking for a tab that will never appear — the code above
  // is the whole answer for them, so point at it instead.
  const opened = openImpl(uriComplete || uri, { spawnImpl });
  console.log(opened
    ? '  Opening your browser… waiting for approval (Ctrl-C to cancel)'
    : '  No browser here — open the link above on any device. Waiting for approval (Ctrl-C to cancel)');

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleepImpl(interval * 1000);
    let poll;
    try {
      poll = await postJson(`${base}/api/device/poll`, { device_code: deviceCode }, fetchImpl);
    } catch {
      continue;                       // a blip mid-approval shouldn't abort it
    }
    const status = poll.json && poll.json.status;

    if (status === 'authorization_pending') continue;
    // The server widened the interval because we polled too fast. Respect it —
    // this endpoint is unauthenticated and we are the well-behaved client.
    if (status === 'slow_down') { interval = Number(poll.json.interval) || interval + 5; continue; }
    if (status === 'access_denied') { console.log('  Denied — nothing was connected.'); return { ok: false, reason: 'denied' }; }
    if (status === 'expired_token') { console.log('  That code expired. Run /tokenomica:login again.'); return { ok: false, reason: 'expired' }; }

    if (status === 'granted' && poll.json.token) {
      writeConfig(poll.json.url || base, poll.json.token, { configPath });
      // The salt rides along with the grant, so a fresh install never spends
      // its first session on the per-machine project-label fallback.
      if (poll.json.project_salt) saveOrgSalt(poll.json.project_salt, tokenomicaDir);
      // A new login can be a different org: forget the old org's sharing
      // policy (stamped as never fetched, so the next upload asks this org).
      saveOrgPolicy({ share_git_refs: false }, tokenomicaDir, 0);

      console.log('');
      console.log(`  ✓ Connected as ${poll.json.display_name || 'you'}`);
      console.log(`  ✓ Wrote ${configPath}`);

      // Anything captured while this machine had no token — or a revoked one —
      // has been waiting in the outbox rather than being lost. Connecting is
      // exactly the moment to send it.
      const flush = flushImpl || defaultFlush;
      try {
        const sent = await flush({ url: poll.json.url || base, token: poll.json.token, tokenomicaDir }, fetchImpl);
        if (sent > 0) console.log(`  ✓ ${sent} queued session${sent === 1 ? '' : 's'} uploaded`);
      } catch { /* the next session end drains it */ }
      console.log('');
      return { ok: true, displayName: poll.json.display_name || '' };
    }
  }
  console.log('  Timed out waiting for approval. Run /tokenomica:login again when you’re ready.');
  return { ok: false, reason: 'timeout' };
}

// Lazily required so this file stays loadable (and unit-testable) without
// pulling in the whole upload path.
async function defaultFlush(cfg, fetchImpl) {
  const { flushOutbox } = require('./upload-session');
  const r = await flushOutbox(cfg, { fetchImpl, max: 500 });
  return r.sent || 0;
}

module.exports = { runLogin, writeConfig, openBrowser, PLUGIN_VERSION };

if (require.main === module) {
  // Everything after the flag is the dashboard URL (the slash command passes
  // $ARGUMENTS straight through).
  const i = process.argv.indexOf('--login');
  const arg = i > -1 ? process.argv.slice(i + 1).find(a => a && !a.startsWith('--')) : process.argv[2];
  runLogin({ dashboardUrl: arg })
    .then(() => process.exit(0))
    .catch(e => { console.log(`Sign-in failed: ${e.message}`); process.exit(0); });
}
