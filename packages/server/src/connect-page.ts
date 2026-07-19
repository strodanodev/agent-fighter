/**
 * GET /connect — the self-serve key-mint page (Minds MVP piece 2).
 *
 * Served by the MATCH SERVER so it needs nothing from the game client
 * deploy: it script-loads the public AIR Kit UMD from the game site, signs
 * the OWNER in (AIR's own dialog), then POSTs /agent/key (coach) or
 * /agent/signup (agent-class fighter) with the fresh JWT and shows the
 * afk_… key ONCE with copy + hand-off guidance.
 * The JWT lives in page memory only; the key is never stored client-side.
 *
 * ?sdk= overrides the AIR Kit UMD URL (dev servers), ?partner= / ?airenv=
 * mirror the game client's overrides.
 */

/** Public client identifier — same one the game ships (see client auth.ts). */
const AIR_PARTNER_ID = 'cdbfc9c4-62db-4947-b0de-c28932887132';
const AIRKIT_UMD_DEFAULT = 'https://agent-fighter.vercel.app/vendor/airkit.umd.js';

export const connectPageHtml = (): string => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Fighter — Connect a Coach</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #101018; color: #eee; font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 560px; padding: 32px 24px; }
  h1 { font-size: 22px; letter-spacing: .04em; }
  h1 span { color: #f5c542; }
  button { font: inherit; padding: 12px 22px; border-radius: 8px; border: 1px solid #f5c542;
           background: #f5c542; color: #101018; font-weight: 700; cursor: pointer; }
  button.ghost { background: transparent; color: #f5c542; }
  button:disabled { opacity: .5; cursor: wait; }
  code.key { display: block; margin: 14px 0; padding: 14px; border-radius: 8px;
             background: #1c1c28; border: 1px dashed #f5c542; word-break: break-all;
             font-size: 15px; user-select: all; }
  .muted { color: #9a9aa8; font-size: 14px; }
  .warn { color: #ff9d9d; font-size: 14px; }
  ol { padding-left: 20px; } li { margin: 6px 0; }
  #err { color: #ff9d9d; white-space: pre-wrap; }
  .hide { display: none; }
</style></head><body><main>
  <h1>AGENT FIGHTER · <span>CONNECT A COACH</span></h1>

  <section id="step-signin">
    <p>Sign in with your Agent Fighter (AIR) account, then pick what to mint:</p>
    <p><button id="go">Sign in &amp; mint coach key</button></p>
    <p><button id="go-fighter" class="ghost">Sign in &amp; create agent fighter (fleet / headless)</button></p>
    <p class="muted"><b>Coach key</b> — trains <i>your</i> fighter via Minds (style only).
    Rotating replaces the old key.</p>
    <p class="muted"><b>Agent fighter</b> — creates a free agent-class account
    you own (arcade / AGENTS rank, no credits). Use the key with
    <code>npm run agent</code> / <code>npm run fleet</code>.</p>
    <p id="err"></p>
  </section>

  <section id="step-key" class="hide">
    <p><b id="key-title">Your key</b> — shown ONCE, copy it now:</p>
    <code class="key" id="key"></code>
    <p><button id="copy">Copy key</button>
       <span id="copied" class="muted hide">copied ✓</span></p>
    <p class="warn">This page never sees it again. If you lose a coach key,
    mint a new one (the old one is revoked). Agent-fighter keys are
    permanent until you discard the account credentials.</p>
    <div id="next-coach">
      <p><b>Next — hand it to your coach:</b></p>
      <ol>
        <li>On <a href="https://build.hellominds.ai" target="_blank" rel="noreferrer">Minds</a>:
            create a Mind and <b>link Telegram</b> so you can text it.</li>
        <li><b>My Connections</b> → Agent Fighter → paste the key.</li>
        <li>Enable the <b>Agent Fighter Coach</b> skill from the Bazaar.</li>
        <li>Message your Mind: <i>"set up my agent — aggressive rushdown"</i>.</li>
      </ol>
      <p class="muted">Once your coach saves a style, the AUTO toggle unlocks
      in-game — your trained agent can take the controls.</p>
    </div>
    <div id="next-fighter" class="hide">
      <p><b>Next — run headless:</b></p>
      <ol>
        <li><code>AF_AGENT_KEY=afk_… AF_MODE=arcade npm run agent</code></li>
        <li>Or add the key to <code>fleet-agents.json</code> and
            <code>npm run fleet</code>.</li>
      </ol>
      <p class="muted">Same mint is available in-game under
      <b>MY AGENT → CREATE AGENT FIGHTER</b>.</p>
    </div>
  </section>

<script>
  const q = new URLSearchParams(location.search);
  const sdkUrl = q.get('sdk') || ${JSON.stringify(AIRKIT_UMD_DEFAULT)};
  const err = (m) => { document.getElementById('err').textContent = m; };
  const show = (id) => {
    document.getElementById('step-signin').classList.add('hide');
    document.getElementById(id).classList.remove('hide');
  };
  const loadSdk = () => new Promise((res, rej) => {
    if (window.Airkit) return res();
    const s = document.createElement('script');
    s.src = sdkUrl;
    s.onload = res;
    s.onerror = () => rej(new Error('could not load the AIR Kit SDK'));
    document.head.appendChild(s);
  });
  const mint = async (kind) => {
    const btn = document.getElementById(kind === 'fighter' ? 'go-fighter' : 'go');
    const other = document.getElementById(kind === 'fighter' ? 'go' : 'go-fighter');
    btn.disabled = true; other.disabled = true; err('');
    try {
      await loadSdk();
      const svc = new Airkit.AirService({ partnerId: q.get('partner') || ${JSON.stringify(AIR_PARTNER_ID)} });
      const re = await svc.init({ buildEnv: q.get('airenv') || 'sandbox' });
      if (!(re && re.isLoggedIn)) await svc.login();
      const { token } = await svc.getAccessToken();
      const path = kind === 'fighter' ? '/agent/signup' : '/agent/key';
      const r = await fetch(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          ...(kind === 'fighter' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: kind === 'fighter' ? '{}' : undefined,
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
      document.getElementById('key').textContent = body.key;
      document.getElementById('key-title').textContent =
        kind === 'fighter' ? 'Your agent fighter key' : 'Your coach key';
      document.getElementById('next-coach').classList.toggle('hide', kind === 'fighter');
      document.getElementById('next-fighter').classList.toggle('hide', kind !== 'fighter');
      show('step-key');
    } catch (e) {
      err(e && e.message ? e.message : String(e));
      btn.disabled = false; other.disabled = false;
    }
  };
  document.getElementById('go').onclick = () => mint('coach');
  document.getElementById('go-fighter').onclick = () => mint('fighter');
  document.getElementById('copy').onclick = async () => {
    await navigator.clipboard.writeText(document.getElementById('key').textContent);
    document.getElementById('copied').classList.remove('hide');
  };
</script>
</main></body></html>`;
