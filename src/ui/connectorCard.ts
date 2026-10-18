// Settings "Claude" card for the Claude connector (src/connector.ts). Server-rendered from non-secret
// status only. Tokens are created by the browser (POST /api/connector/tokens) and shown once in a
// dialog; they are never part of the page HTML.
import { connectorView, type ConnectorView } from "../connector.js";
import type { IntegrationCard } from "./settingsPage.js";
import { button, chip, dialog, escapeHtml, infoTip } from "./shell.js";

function lastUsedLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "Not used yet";
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "Used just now";
  if (minutes < 60) return `Used ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Used ${hours} h ago`;
  return `Used ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function copyableUrl(url: string): string {
  return `<code class="cc-url">${escapeHtml(url)}</code><button type="button" class="gc-btn gc-btn-text gc-btn-sm cc-copy" data-copy="${escapeHtml(url)}">Copy</button>`;
}

function toolsHtml(view: ConnectorView): string {
  const count = view.toolGroups.reduce((sum, group) => sum + group.tools.length, 0);
  if (!count) return '<span class="gc-muted">None registered</span>';
  const groups = view.toolGroups.map((group) => `<div class="cc-group"><div class="cc-group-name">${escapeHtml(group.group)}</div><ul class="cc-tool-list">${group.tools.map((tool) => `<li title="${escapeHtml(tool.description)}"><code>${escapeHtml(tool.name)}</code>${tool.mutates ? '<span class="cc-tag">changes data</span>' : ""}</li>`).join("")}</ul></div>`).join("");
  return `<details class="cc-tools"><summary>${count} tool${count === 1 ? "" : "s"}</summary><div class="cc-groups">${groups}</div></details>`;
}

function helpDialog(view: ConnectorView): string {
  const tunnel = `cloudflared tunnel --url http://127.0.0.1:${view.port}`;
  const body = `<ol class="cc-steps">
  <li>Press <strong>Connect Claude</strong> next to your name and copy your personal token. It is shown once; GroupCart stores only a fingerprint.</li>
  <li><strong>Claude Code:</strong> run the <code>claude mcp add</code> command from the token dialog.</li>
  <li><strong>claude.ai or Claude Desktop:</strong> Settings &gt; Connectors &gt; Add custom connector, then paste your personal URL (<code>…/mcp/t/&lt;token&gt;</code>). This needs a public HTTPS address.</li>
  <li><strong>Public HTTPS:</strong> on this computer run <code>${escapeHtml(tunnel)}</code>, set <code>GROUP_CART_PUBLIC_URL</code> to the https address it prints, restart GroupCart, and make a new token. Through the tunnel only <code>/mcp</code> answers; the rest of GroupCart stays on this computer.</li>
  <li>Claude acts as you: it can read household info, add groceries, approve the cart, and post to the group as “you via Claude”. It cannot check out or pay. Revoke the token any time.</li>
</ol>`;
  return dialog({ id: "cc-help-dialog", title: "Connect your Claude", body, actions: button({ label: "Close", variant: "text", attrs: "data-gc-close" }) });
}

const styles = `
.cc-url { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; text-align:right; }
.cc-meta { color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.cc-tools { width:100%; text-align:left; }
.cc-tools > summary { cursor:pointer; color:var(--gc-accent); font-size:var(--gc-fs-sm); text-align:right; }
.cc-groups { display:grid; gap:var(--gc-space-3); margin-top:var(--gc-space-3); }
.cc-group-name { font-size:var(--gc-fs-xs); color:var(--gc-muted); text-transform:uppercase; letter-spacing:.04em; margin-bottom:4px; }
.cc-tool-list { list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:6px; }
.cc-tool-list li { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border:1px solid var(--gc-border); border-radius:var(--gc-radius-sm); background:var(--gc-surface-2); }
.cc-tool-list code, .cc-pre code, .cc-steps code, .cc-note code { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
.cc-tag { font-size:11px; color:var(--gc-warning); }
.cc-lead { margin:0 0 var(--gc-space-3); color:var(--gc-text-2); font-size:var(--gc-fs-sm); }
.cc-h { margin:var(--gc-space-4) 0 2px; font-size:var(--gc-fs-md); font-weight:500; }
.cc-note { margin:0 0 6px; color:var(--gc-text-2); font-size:var(--gc-fs-sm); }
.cc-block { position:relative; }
.cc-pre { margin:0; padding:10px 64px 10px 12px; background:var(--gc-surface-2); border:1px solid var(--gc-border); border-radius:var(--gc-radius-sm); white-space:pre-wrap; overflow-wrap:anywhere; max-height:220px; overflow:auto; }
.cc-block .cc-copy { position:absolute; top:6px; right:6px; }
.cc-steps { margin:0; padding-left:20px; display:grid; gap:var(--gc-space-2); color:var(--gc-text-2); font-size:var(--gc-fs-sm); }
.cc-error { color:var(--gc-danger); font-size:var(--gc-fs-sm); }
`;

const script = `
(function () {
  function code(text) { return GC.esc(text).replace(/\`([^\`]+)\`/g, "<code>$1</code>"); }
  function block(text) {
    return '<div class="cc-block"><pre class="cc-pre"><code>' + GC.esc(text) + '</code></pre><button type="button" class="gc-btn gc-btn-outline gc-btn-sm cc-copy">Copy</button></div>';
  }
  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw new Error(data.error || "Request failed.");
          return data;
        });
      });
  }
  function render(data) {
    var html = '<p class="cc-lead">Personal token for <strong>' + GC.esc(data.memberName) + '</strong>. Copy it now: it is shown only once, and anyone with it can act as ' + GC.esc(data.memberName) + ' in GroupCart. Making a new token turns this one off.</p>' + block(data.token);
    data.snippets.forEach(function (snippet) {
      html += '<h3 class="cc-h">' + GC.esc(snippet.title) + '</h3><p class="cc-note">' + code(snippet.note) + '</p>' + (snippet.code ? block(snippet.code) : "");
    });
    document.getElementById("cc-token-body").innerHTML = html;
  }
  function copy(button) {
    var text = button.getAttribute("data-copy");
    if (text === null) { var el = button.parentElement && button.parentElement.querySelector("code"); text = el ? el.textContent : ""; }
    var done = function () { var label = button.textContent; button.textContent = "Copied"; setTimeout(function () { button.textContent = label; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); }); }
    else { fallback(text); done(); }
  }
  function fallback(text) {
    var area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    try { document.execCommand("copy"); } catch (e) {}
    area.remove();
  }
  var tokenDialog = document.getElementById("cc-token-dialog");
  if (tokenDialog) tokenDialog.addEventListener("close", function () { if (tokenDialog.getAttribute("data-dirty")) location.reload(); });
  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var copyButton = target.closest(".cc-copy");
    if (copyButton) { copy(copyButton); return; }
    var connect = target.closest("[data-cc-connect]");
    if (connect) {
      connect.disabled = true;
      post("/api/connector/tokens", { memberId: connect.getAttribute("data-cc-connect") })
        .then(function (data) { render(data); tokenDialog.setAttribute("data-dirty", "1"); GC.openDialog("cc-token-dialog"); })
        .catch(function (error) { alert(error.message); })
        .then(function () { connect.disabled = false; });
      return;
    }
    var revoke = target.closest("[data-cc-revoke]");
    if (revoke) {
      var name = revoke.getAttribute("data-cc-name") || "this member";
      if (!confirm("Revoke " + name + "'s Claude token? Their Claude loses access to GroupCart right away.")) return;
      post("/api/connector/tokens/revoke", { memberId: revoke.getAttribute("data-cc-revoke") })
        .then(function () { location.reload(); })
        .catch(function (error) { alert(error.message); });
    }
  });
})();
`;

/** The Settings "Claude" integration card (rendered by renderIntegrationCard in settingsPage.ts). */
export function claudeConnectorCard(): IntegrationCard {
  const view = connectorView();
  if (!view) {
    return {
      id: "claude",
      name: "Claude",
      icon: "spark",
      summary: "Connect your own Claude to GroupCart",
      status: { label: "Not configured", tone: "neutral" },
      tip: "The Claude connector starts with GroupCart (setupConnector in src/index.ts).",
    };
  }
  const connected = view.members.filter((member) => member.connected).length;
  const memberFacts = view.members.map((member) => ({
    label: member.name,
    html: member.connected
      ? `${chip("Connected", "success", "check")}<span class="cc-meta">${escapeHtml(lastUsedLabel(member.lastUsedAt))}</span>`
        + button({ label: "New token", variant: "outline", size: "sm", attrs: `data-cc-connect="${escapeHtml(member.id)}"` })
        + button({ label: "Revoke", variant: "text", size: "sm", attrs: `data-cc-revoke="${escapeHtml(member.id)}" data-cc-name="${escapeHtml(member.name)}"` })
      : `${chip("Not connected", "neutral")}${button({ label: "Connect Claude", variant: "tonal", size: "sm", icon: "plug", attrs: `data-cc-connect="${escapeHtml(member.id)}"` })}`,
  }));
  const publicFact = view.publicUrl
    ? copyableUrl(view.publicUrl) + (view.publicHttps ? chip("HTTPS", "success", "lock") : chip("Needs HTTPS for claude.ai", "warning", "alert"))
    : chip("Local only", "neutral") + infoTip(`For claude.ai or other computers, run "cloudflared tunnel --url http://127.0.0.1:${view.port}" and set GROUP_CART_PUBLIC_URL to its https address. Only /mcp is reachable through the tunnel.`, "Public access");
  return {
    id: "claude",
    name: "Claude",
    icon: "spark",
    summary: "Each roommate's Claude acts as them",
    status: connected
      ? { label: `${connected} of ${view.members.length} connected`, tone: "success" }
      : { label: "Not connected", tone: "neutral" },
    facts: [
      { label: "This computer", html: copyableUrl(view.localUrl) },
      { label: "Public", html: publicFact },
      ...memberFacts,
      { label: "Tools", html: toolsHtml(view) },
    ],
    actions: button({ label: "Setup guide", variant: "text", size: "sm", icon: "help", attrs: 'data-gc-open="cc-help-dialog"' })
      + helpDialog(view)
      + dialog({ id: "cc-token-dialog", title: "Connect Claude", body: '<div id="cc-token-body"></div>', actions: button({ label: "Done", attrs: "data-gc-close" }) })
      + `<style>${styles}</style><script>${script}</script>`,
    tip: "Claude Code, Claude Desktop, and claude.ai connect to GroupCart's /mcp endpoint with a personal token. GroupCart keeps only a fingerprint of each token.",
  };
}
