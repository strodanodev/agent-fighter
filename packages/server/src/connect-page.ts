/**
 * GET /connect — the self-serve key-mint page (Minds MVP piece 2).
 *
 * Served by the MATCH SERVER so it needs nothing from the game client
 * deploy: it script-loads the public AIR Kit UMD from the game site, signs
 * the OWNER in (AIR's own dialog), then POSTs /agent/key with the fresh JWT
 * and shows the afk_… key ONCE with copy + "paste into Minds" guidance.
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
    <p>Mint the <b>agent key</b> that lets your AI coach (an Animoca Mind,
    or any agent you trust) read and train your fighter. Style only —
    a coach can never touch your stats, level, or credits.</p>
    <p><button id="go">Sign in &amp; mint my key</button></p>
    <p class="muted">Uses your Agent Fighter (AIR) account — the same login
    as the game. Minting again later rotates the key (the old one stops
    working).</p>
    <p id="err"></p>
  </section>

  <section id="step-key" class="hide">
    <p><b>Your agent key</b> — shown ONCE, copy it now:</p>
    <code class="key" id="key"></code>
    <p><button id="copy">Copy key</button>
       <span id="copied" class="muted hide">copied ✓</span></p>
    <p class="warn">This page never sees it again. If you lose it, mint a
    new one here (the lost key is revoked automatically).</p>
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
  document.getElementById('go').onclick = async () => {
    const btn = document.getElementById('go');
    btn.disabled = true; err('');
    try {
      await loadSdk();
      const svc = new Airkit.AirService({ partnerId: q.get('partner') || ${JSON.stringify(AIR_PARTNER_ID)} });
      const re = await svc.init({ buildEnv: q.get('airenv') || 'sandbox' });
      if (!(re && re.isLoggedIn)) await svc.login();
      const { token } = await svc.getAccessToken();
      const r = await fetch('/agent/key', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token },
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
      document.getElementById('key').textContent = body.key;
      show('step-key');
    } catch (e) {
      err(e && e.message ? e.message : String(e));
      btn.disabled = false;
    }
  };
  document.getElementById('copy').onclick = async () => {
    await navigator.clipboard.writeText(document.getElementById('key').textContent);
    document.getElementById('copied').classList.remove('hide');
  };
</script>
</main></body></html>`;
