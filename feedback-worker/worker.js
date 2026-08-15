/**
 * CALM Feedback Proxy — Cloudflare Worker
 *
 * The GitHub token lives ONLY here (as a Worker secret), never in the app.
 * The app POSTs { title, body, label } and this Worker creates the GitHub
 * issue and (optionally) sends an ntfy.sh push notification.
 *
 * Required secret / vars (set in Cloudflare dashboard or wrangler):
 *   GH_TOKEN   (secret) fine-grained PAT with Issues: Read & Write on the repo
 *   GH_OWNER   e.g. "katohmanabu-png"
 *   GH_REPO    e.g. "CALM-app"
 *   NTFY_TOPIC (optional) e.g. "calm-katohmanabu"  — omit to disable push
 */

const ALLOWED_ORIGINS = [
  'https://katohmanabu-png.github.io',
  'http://localhost:8766',
  'capacitor://localhost',   // native (Capacitor) iOS build
  'https://localhost',
  'ionic://localhost'
];

const ALLOWED_LABELS = ['bug', 'enhancement', 'photometric', 'csv', 'database', 'feedback'];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
  });
}

// CSV/テキストの添付は、GitHubのCSVビューアがモバイルで読めないことがあるため
// 中身をMarkdownの表にしてIssue本文へ直接埋め込む（先頭のみ・長すぎる場合は省略）。
function csvToMarkdown(text, maxRows, maxCols) {
  const rows = [];
  let cell = '', row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i+1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) break;
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some(v => v.trim() !== '')) rows.push(row); }
  if (!rows.length) return '';
  const esc = v => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim() || ' ';
  const width = Math.min(maxCols, Math.max.apply(null, rows.map(r => r.length)));
  const pad = r => { const a = r.slice(0, width); while (a.length < width) a.push(''); return a; };
  const head = pad(rows[0]).map(esc);
  const bodyRows = rows.slice(1, maxRows + 1).map(r => pad(r).map(esc));
  let md = '| ' + head.join(' | ') + ' |\n|' + head.map(() => '---').join('|') + '|\n';
  md += bodyRows.map(r => '| ' + r.join(' | ') + ' |').join('\n') + '\n';
  const total = rows.length - 1;
  if (total > maxRows) md += '\n_… ' + (total - maxRows) + ' more rows (see the file link above)_\n';
  return md;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    let payload;
    try { payload = await request.json(); }
    catch (e) { return json({ error: 'Invalid JSON' }, 400, origin); }

    // Validate + clamp (basic anti-abuse)
    const title = String(payload.title || '').trim().slice(0, 200);
    const body  = String(payload.body  || '').trim().slice(0, 8000);
    let   label = String(payload.label || 'feedback').trim();
    if (!title) return json({ error: 'Title required' }, 400, origin);
    if (ALLOWED_LABELS.indexOf(label) < 0) label = 'feedback';

    if (!env.GH_TOKEN || !env.GH_OWNER || !env.GH_REPO) {
      return json({ error: 'Server not configured' }, 500, origin);
    }

    const apiUrl = 'https://api.github.com/repos/' + env.GH_OWNER + '/' + env.GH_REPO + '/issues';
    const ghHeaders = {
      'Authorization': 'Bearer ' + env.GH_TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'CALM-Feedback-Worker'
    };

    const notifyUser = env.GH_NOTIFY_USER || env.GH_OWNER;

    // Attachments: GitHub has no public API for uploading to an issue, so commit
    // each file into the repo and embed its raw URL in the issue body.
    // Requires the token to also have Contents: Read and write.
    // 非公開リポジトリ運用（GH_PRIVATE=1）: 画像は埋め込まずリンクにし、
    // テスターに開けない Issue URL は返さない。
    const isPrivate = /^(1|true|yes)$/i.test(String(env.GH_PRIVATE || ''));

    let attachMd = '';
    let attached = 0;
    let attachErr = null;
    const atts = Array.isArray(payload.attachments) ? payload.attachments.slice(0, 4) : [];
    for (const a of atts) {
      const b64 = String((a && a.b64) || '');
      if (!b64 || b64.length > 8 * 1024 * 1024) continue;   // ~6MB binary cap
      const safe = String((a && a.name) || 'file')
        .replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);
      const path = 'feedback-attachments/' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '-' + safe;
      try {
        const up = await fetch('https://api.github.com/repos/' + env.GH_OWNER + '/' + env.GH_REPO + '/contents/' + path, {
          method: 'PUT',
          headers: ghHeaders,
          body: JSON.stringify({ message: 'feedback attachment: ' + safe, content: b64 })
        });
        const ud = await up.json().catch(() => ({}));
        const url  = ud && ud.content && ud.content.download_url;   // raw (embeds images)
        const blob = ud && ud.content && ud.content.html_url;       // github.com blob (renders CSV as a table)
        if (up.ok && url) {
          if (/\.(png|jpe?g|gif|webp)$/i.test(safe)) {
            // 非公開リポジトリでは raw URL の画像埋め込みは認証が通らず壊れるためリンクにする
            attachMd += (isPrivate
              ? '🖼 [' + safe + '](' + (blob || url) + ')'
              : '![' + safe + '](' + url + ')') + '\n\n';
          } else {
            attachMd += '**' + safe + '** — [' + (blob ? 'view' : 'file') + '](' + (blob || url) + ')' + (blob ? ' · [raw](' + url + ')' : '') + '\n\n';
            // CSV/TSV/txt は中身を表にして本文へ展開（モバイルでも読めるように）
            if (/\.(csv|tsv|txt)$/i.test(safe) && b64.length < 400 * 1024) {
              try {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
                let txt = new TextDecoder('utf-8').decode(bytes);
                if (/\.tsv$/i.test(safe)) txt = txt.replace(/\t/g, ',');
                const tbl = csvToMarkdown(txt, 40, 12);
                if (tbl) attachMd += '<details open><summary>' + safe + '</summary>\n\n' + tbl + '\n</details>\n\n';
              } catch (e) { /* fall back to link only */ }
            }
          }
          attached++;
        } else {
          attachErr = up.status + ': ' + String((ud && ud.message) || '').slice(0, 120);
        }
      } catch (e) { attachErr = 'exception: ' + String(e).slice(0, 120); }
    }
    const fullBody = body + (attachMd ? '\n\n## Attachments\n' + attachMd : '');

    // level 2 = labels + assignee, 1 = assignee only, 0 = plain.
    // A brand-new repo has none of the labels, which would otherwise 422.
    async function createIssue(level) {
      const p = { title: title, body: fullBody };
      if (level >= 2) p.labels = [label];
      if (level >= 1 && notifyUser) p.assignees = [notifyUser];
      return fetch(apiUrl, { method: 'POST', headers: ghHeaders, body: JSON.stringify(p) });
    }

    let res = await createIssue(2);
    if (res.status === 422) res = await createIssue(1);
    if (res.status === 422) res = await createIssue(0);

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.html_url) {
      return json({ error: (data && data.message) || 'GitHub error', status: res.status }, 502, origin);
    }

    // Push notification via Discord webhook. Unlike ntfy's free tier (per-IP
    // quota → 429 from Cloudflare's shared egress) this works reliably from a
    // Worker, and unlike GitHub's own notifications it isn't suppressed as a
    // "your own action" event.
    if (env.DISCORD_WEBHOOK) {
      try {
        await fetch(env.DISCORD_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'CALM Feedback',
            content: '**' + title + '**\n' + data.html_url
          })
        });
      } catch (e) { /* non-fatal */ }
    }

    return json({
      ok: true,
      url: isPrivate ? undefined : data.html_url,
      number: data.number,
      attached: attached,
      attachErr: attachErr
    }, 200, origin);
  }
};
