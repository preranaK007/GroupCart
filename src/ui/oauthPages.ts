// Standalone pages for the connector's OAuth sign-in (/oauth/authorize). They can be reached through a
// tunnel, so they use the shell's tokens and components but no app navigation, scripts, or dashboard links.
import { BASE_CSS, TOKENS_CSS, escapeHtml, icon } from "./shell.js";

/** Validated authorize parameters, carried through the forms as hidden fields. */
export type AuthorizeFields = {
  client_id: string;
  redirect_uri: string;
  response_type: "code";
  code_challenge: string;
  code_challenge_method: "S256";
  state?: string;
  resource?: string;
  scope: string;
};

const styles = `
body { min-height:100vh; background:var(--gc-surface-2); }
.oa-wrap { max-width:480px; margin:0 auto; padding:var(--gc-space-6) var(--gc-space-4); display:grid; gap:var(--gc-space-4); }
.oa-brand { display:flex; align-items:center; gap:10px; color:var(--gc-text); font-size:var(--gc-fs-xl); }
.oa-card { background:var(--gc-surface); border:1px solid var(--gc-border); border-radius:var(--gc-radius-lg); padding:var(--gc-space-5); display:grid; gap:var(--gc-space-4); }
.oa-title { font-size:var(--gc-fs-xl); font-weight:400; line-height:1.3; }
.oa-text { color:var(--gc-text-2); }
.oa-label { font-weight:500; display:block; margin-bottom:6px; }
.oa-code { font:500 22px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.12em; text-transform:uppercase; height:52px; text-align:center; }
.oa-error { padding:10px 12px; border-radius:var(--gc-radius-sm); background:var(--gc-danger-soft); color:var(--gc-danger); font-size:var(--gc-fs-sm); }
.oa-actions { display:flex; gap:var(--gc-space-2); justify-content:flex-end; flex-wrap:wrap; }
.oa-meta { display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px var(--gc-space-3); font-size:var(--gc-fs-sm); padding:var(--gc-space-3); border-radius:var(--gc-radius-md); background:var(--gc-surface-2); border:1px solid var(--gc-border); }
.oa-meta dt { color:var(--gc-muted); }
.oa-meta dd { margin:0; overflow-wrap:anywhere; }
.oa-tools { list-style:none; margin:0; padding:0; display:grid; gap:6px; max-height:280px; overflow:auto; }
.oa-tools li { display:grid; gap:2px; padding:8px 10px; border:1px solid var(--gc-border); border-radius:var(--gc-radius-sm); }
.oa-tools code { font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
.oa-tools span { color:var(--gc-text-2); font-size:var(--gc-fs-sm); }
.oa-tag { color:var(--gc-warning); font-size:var(--gc-fs-xs); font-weight:500; }
.oa-foot { color:var(--gc-muted); font-size:var(--gc-fs-sm); }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} · GroupCart</title>
<style>${TOKENS_CSS}${BASE_CSS}${styles}</style>
</head>
<body>
<main class="oa-wrap">
  <div class="oa-brand"><span class="gc-logo">${icon("cart", { size: 22 })}</span>GroupCart</div>
  ${body}
</main>
</body>
</html>`;
}

function hiddenFields(fields: AuthorizeFields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join("");
}

export function renderPairingPage(options: { fields: AuthorizeFields; clientName: string; error?: string }): string {
  const body = `<section class="oa-card" aria-labelledby="oa-title">
  <h1 class="oa-title" id="oa-title">Connect ${escapeHtml(options.clientName)} to GroupCart</h1>
  <p class="oa-text">On the computer running GroupCart, open <strong>Settings &gt; AI assistants</strong> and press <strong>Pairing code</strong> next to your name. Enter the code here. It works once and expires after 10 minutes.</p>
  ${options.error ? `<p class="oa-error" role="alert">${escapeHtml(options.error)}</p>` : ""}
  <form method="post" action="/oauth/authorize">
    ${hiddenFields(options.fields)}
    <label class="oa-label" for="pairing_code">Pairing code</label>
    <input class="gc-input oa-code" id="pairing_code" name="pairing_code" placeholder="ABCD-EFGH" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="12" required autofocus />
    <div class="oa-actions" style="margin-top:var(--gc-space-4)"><button class="gc-btn" type="submit">Continue</button></div>
  </form>
  <p class="oa-foot">Not part of this household? Close this page; nothing is shared until a roommate approves.</p>
</section>`;
  return page(`Connect ${options.clientName}`, body);
}

export function renderConsentPage(options: {
  fields: AuthorizeFields;
  ticket: string;
  clientName: string;
  via: string;
  memberName: string;
  redirectHost: string;
  tools: Array<{ name: string; description: string; mutates: boolean }>;
  /** True when the member came from a web session; offers switching to a pairing code. */
  fromSession?: boolean;
}): string {
  const tools = options.tools.map((tool) => `<li><code>${escapeHtml(tool.name)}</code>${tool.mutates ? '<em class="oa-tag">Can change household data</em>' : ""}<span>${escapeHtml(tool.description)}</span></li>`).join("");
  const body = `<section class="oa-card" aria-labelledby="oa-title">
  <h1 class="oa-title" id="oa-title">${escapeHtml(options.clientName)} wants to act as ${escapeHtml(options.memberName)} in GroupCart</h1>
  <p class="oa-text">It can use these tools as ${escapeHtml(options.memberName)}. Posts and approvals show in the group as “${escapeHtml(options.memberName)} via ${escapeHtml(options.via)}”. GroupCart never lets it check out or pay.</p>
  <dl class="oa-meta"><dt>App</dt><dd>${escapeHtml(options.clientName)}</dd><dt>Returns to</dt><dd>${escapeHtml(options.redirectHost)}</dd><dt>Acting as</dt><dd>${escapeHtml(options.memberName)}</dd></dl>
  <ul class="oa-tools" aria-label="Tools">${tools}</ul>
  <form method="post" action="/oauth/authorize">
    ${hiddenFields(options.fields)}
    <input type="hidden" name="ticket" value="${escapeHtml(options.ticket)}" />
    <div class="oa-actions"><button class="gc-btn gc-btn-outline" type="submit" name="decision" value="deny">Deny</button><button class="gc-btn" type="submit" name="decision" value="allow">Allow</button></div>
  </form>
  ${options.fromSession ? `<form method="post" action="/oauth/authorize" class="oa-switch">${hiddenFields(options.fields)}<input type="hidden" name="use_pairing" value="1" /><button class="gc-btn gc-btn-text gc-btn-sm" type="submit">Not ${escapeHtml(options.memberName)}? Use a pairing code</button></form>` : ""}
  <p class="oa-foot">Disconnect it any time in GroupCart Settings &gt; AI assistants.</p>
</section>`;
  return page(`Allow ${options.clientName}`, body);
}

export function renderOAuthErrorPage(options: { title: string; message: string }): string {
  return page(options.title, `<section class="oa-card" aria-labelledby="oa-title">
  <h1 class="oa-title" id="oa-title">${escapeHtml(options.title)}</h1>
  <p class="oa-text">${escapeHtml(options.message)}</p>
</section>`);
}
