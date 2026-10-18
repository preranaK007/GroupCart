import { BASE_CSS, TOKENS_CSS, escapeHtml, icon } from "./shell.js";

/**
 * /signin: a standalone, Google-style sign-in card (no app bar or navigation, since nothing else is reachable
 * remotely before signing in). Step 1 asks for the phone number or Apple ID the member uses in the group;
 * step 2 takes the 6-digit code GroupCart texted by iMessage (shown on screen in demo mode).
 */

const styles = `
body { background:var(--gc-surface-2); }
.si { min-height:100dvh; display:grid; place-items:center; align-content:center; gap:var(--gc-space-4); padding:var(--gc-space-5) var(--gc-space-4); }
.si-card { width:min(420px, 100%); background:var(--gc-surface); border:1px solid var(--gc-border); border-radius:28px; padding:var(--gc-space-6) var(--gc-space-6) var(--gc-space-5); }
.si-logo { width:44px; height:44px; display:grid; place-items:center; border-radius:12px; background:var(--gc-accent); color:var(--gc-on-accent); margin-bottom:var(--gc-space-4); }
.si-title { font-size:var(--gc-fs-2xl); font-weight:400; letter-spacing:-.01em; }
.si-sub { color:var(--gc-text-2); margin:4px 0 var(--gc-space-5); }
.si-field { display:grid; gap:6px; }
.si-field span { color:var(--gc-text-2); font-size:var(--gc-fs-xs); font-weight:500; }
.si-field .gc-input { height:48px; font-size:var(--gc-fs-lg); }
.si-code { letter-spacing:.4em; font-variant-numeric:tabular-nums; text-align:center; }
.si-hint { color:var(--gc-muted); font-size:var(--gc-fs-sm); margin-top:var(--gc-space-2); }
.si-error { margin-top:var(--gc-space-3); padding:var(--gc-space-2) var(--gc-space-3); border-radius:var(--gc-radius-sm); background:var(--gc-danger-soft); color:var(--gc-danger); font-size:var(--gc-fs-sm); }
.si-note { display:flex; gap:var(--gc-space-2); padding:var(--gc-space-3); border-radius:var(--gc-radius-md); background:var(--gc-surface-2); border:1px solid var(--gc-border); color:var(--gc-text-2); font-size:var(--gc-fs-sm); }
.si-demo { display:flex; align-items:center; justify-content:space-between; gap:var(--gc-space-2); margin-bottom:var(--gc-space-4); padding:var(--gc-space-2) var(--gc-space-3); border-radius:var(--gc-radius-md); background:var(--gc-accent-soft); color:var(--gc-on-accent-soft); font-size:var(--gc-fs-sm); }
.si-demo strong { font-size:var(--gc-fs-lg); letter-spacing:.2em; font-variant-numeric:tabular-nums; }
.si-sent { color:var(--gc-text-2); margin-bottom:var(--gc-space-4); }
.si-actions { display:flex; align-items:center; justify-content:space-between; gap:var(--gc-space-2); margin-top:var(--gc-space-5); }
.si-actions .gc-btn:last-child { margin-left:auto; min-width:96px; }
.si-foot { color:var(--gc-muted); font-size:var(--gc-fs-xs); text-align:center; max-width:420px; }
@media (max-width: 480px) { .si-card { border:0; background:transparent; padding:var(--gc-space-4) var(--gc-space-2); } body { background:var(--gc-surface); } }
`;

export function renderSignInPage(options: { demoMode: boolean; canSendCodes: boolean; next: string }): string {
  const label = options.demoMode ? "Name, phone, or Apple ID" : "Phone number or Apple ID";
  const placeholder = options.demoMode ? "Maya" : "+1 555 555 0100";
  const form = options.canSendCodes
    ? `<form id="step1" novalidate>
    <label class="si-field"><span>${escapeHtml(label)}</span><input class="gc-input" id="handle" name="handle" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="${escapeHtml(placeholder)}" required /></label>
    <p class="si-hint">${options.demoMode ? "Demo: the code appears on the next screen." : "We’ll text you a 6-digit code in iMessage."}</p>
    <div class="si-error" id="error1" role="alert" hidden></div>
    <div class="si-actions"><span></span><button class="gc-btn" type="submit" id="next">Next</button></div>
  </form>
  <form id="step2" novalidate hidden>
    <p class="si-sent">Code sent to <strong id="dest"></strong></p>
    <div class="si-demo" id="demo" hidden><span>Demo code</span><strong id="demoCode"></strong></div>
    <label class="si-field"><span>6-digit code</span><input class="gc-input si-code" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" required /></label>
    <div class="si-error" id="error2" role="alert" hidden></div>
    <div class="si-actions"><button class="gc-btn gc-btn-text" type="button" id="back">Start over</button><button class="gc-btn" type="submit" id="verify">Verify</button></div>
  </form>`
    : `<div class="si-note">${icon("info", { size: 18 })}<span>Sign-in codes are sent by iMessage, which isn’t connected right now. Open GroupCart on the computer running it.</span></div>`;

  const script = `
const next = ${JSON.stringify(options.next)};
const $ = (id) => document.getElementById(id);
let challengeId = null;
function showError(id, message) { const el = $(id); el.textContent = message || ""; el.hidden = !message; }
async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}
const step1 = $("step1");
if (step1) {
  $("handle").focus();
  step1.addEventListener("submit", async (event) => {
    event.preventDefault();
    const handle = $("handle").value.trim();
    if (!handle) { showError("error1", "Enter your phone number or Apple ID."); return; }
    $("next").disabled = true; showError("error1", "");
    try {
      const { ok, data } = await post("/api/auth/start", { handle });
      if (!ok) { showError("error1", data.error || "Couldn’t send a code."); return; }
      challengeId = data.challengeId;
      $("dest").textContent = data.destination;
      $("demo").hidden = !data.demoCode;
      $("demoCode").textContent = data.demoCode || "";
      step1.hidden = true; $("step2").hidden = false; $("code").value = ""; $("code").focus();
    } catch { showError("error1", "Couldn’t reach GroupCart."); }
    finally { $("next").disabled = false; }
  });
  $("back").addEventListener("click", () => { $("step2").hidden = true; step1.hidden = false; showError("error2", ""); $("handle").focus(); });
  $("code").addEventListener("input", () => { $("code").value = $("code").value.replace(/\\D/g, "").slice(0, 6); if ($("code").value.length === 6) $("step2").requestSubmit(); });
  $("step2").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = $("code").value;
    if (code.length !== 6) { showError("error2", "Enter the 6-digit code."); return; }
    $("verify").disabled = true; showError("error2", "");
    try {
      const { ok, data } = await post("/api/auth/verify", { challengeId, code });
      if (!ok) { showError("error2", data.error || "That code didn’t work."); $("code").select(); return; }
      location.replace(next);
    } catch { showError("error2", "Couldn’t reach GroupCart."); }
    finally { $("verify").disabled = false; }
  });
}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="light dark" />
<meta name="robots" content="noindex" />
<title>Sign in · GroupCart</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0b57d0"/><g transform="translate(4 4)" color="#ffffff">${icon("cart", { size: 24 })}</g></svg>`)}" />
<style>${TOKENS_CSS}${BASE_CSS}${styles}</style>
</head>
<body>
<main class="si">
  <div class="si-card">
    <div class="si-logo">${icon("cart", { size: 24 })}</div>
    <h1 class="si-title">Sign in</h1>
    <p class="si-sub">to your household on GroupCart</p>
    ${form}
  </div>
  <p class="si-foot">Only members of the household group chat can sign in.${options.demoMode ? " This is the demo, so no texts are sent." : ""}</p>
</main>
<script>${script}</script>
</body>
</html>`;
}
