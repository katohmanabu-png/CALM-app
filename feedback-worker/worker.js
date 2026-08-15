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

    async function createIssue(withLabel) {
      const p = { title: title, body: body };
      if (withLabel) p.labels = [label];
      return fetch(apiUrl, { method: 'POST', headers: ghHeaders, body: JSON.stringify(p) });
    }

    let res = await createIssue(true);
    if (res.status === 422) res = await createIssue(false); // label missing → retry without

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.html_url) {
      return json({ error: (data && data.message) || 'GitHub error', status: res.status }, 502, origin);
    }

    // Optional push notification
    if (env.NTFY_TOPIC) {
      try {
        await fetch('https://ntfy.sh/' + env.NTFY_TOPIC, {
          method: 'POST',
          headers: { 'Title': 'CALM Feedback', 'Priority': 'high', 'Tags': 'bell' },
          body: title + '\n' + data.html_url
        });
      } catch (e) { /* non-fatal */ }
    }

    return json({ ok: true, url: data.html_url, number: data.number }, 200, origin);
  }
};
