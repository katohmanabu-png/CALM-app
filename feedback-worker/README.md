# CALM Feedback Proxy (Cloudflare Worker)

This removes the GitHub token from the app. The app POSTs feedback to this
Worker; the Worker holds the token as a **secret** and creates the GitHub issue.

## 0. FIRST: revoke the leaked token

The old token was embedded in the public app. Revoke it now:
GitHub → Settings → Developer settings → **Personal access tokens** →
find the CALM token → **Revoke**. Then create a NEW fine-grained PAT:
- Repository access: only `katohmanabu-png/CALM-app`
- Permissions → **Issues: Read and write**
- Copy the new token (starts with `github_pat_…`) — you'll paste it in step 3.

## 1. Install wrangler (once)

```bash
npm install -g wrangler
wrangler login
```

## 2. Create the Worker

```bash
cd feedback-worker
wrangler init calm-feedback --no-git   # or create in the Cloudflare dashboard
# replace the generated src/index.js with worker.js from this folder
```

Or in the **Cloudflare dashboard**: Workers & Pages → Create → Worker →
paste the contents of `worker.js`.

## 3. Set variables & secret

Dashboard → your Worker → **Settings → Variables**:

| Name         | Type      | Value                          |
|--------------|-----------|--------------------------------|
| `GH_TOKEN`   | Secret    | your NEW fine-grained PAT      |
| `GH_OWNER`   | Text      | `katohmanabu-png`              |
| `GH_REPO`    | Text      | `CALM-app`                     |
| `NTFY_TOPIC` | Text      | `calm-katohmanabu` (optional)  |

(CLI equivalent: `wrangler secret put GH_TOKEN`, and `[vars]` in `wrangler.toml` for the rest.)

## 4. Deploy & get the URL

```bash
wrangler deploy
```

Copy the Worker URL, e.g. `https://calm-feedback.<you>.workers.dev`.

## 5. Point the app at it

In `index.html`, set:

```js
var FB_PROXY_URL = 'https://calm-feedback.<you>.workers.dev';
```

Then commit & push. Send a test feedback from the app — it should create an issue
without any token in the client.

## Notes

- CORS: edit `ALLOWED_ORIGINS` in `worker.js` if your app is served from another
  origin (the native Capacitor build usually sends `capacitor://localhost`).
- Anti-abuse: the Worker clamps title/body length and only accepts known labels.
  If you get spam, add a shared-secret header check or Cloudflare Turnstile.
