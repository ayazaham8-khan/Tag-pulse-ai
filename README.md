# TagPulse AI — Cloudflare Worker Edition

This is TagPulse AI, now running on a secure backend. The app looks and
works exactly the same as before — but your Gemini API key is no longer
sitting inside the HTML where anyone could copy it. Instead, it lives
safely on Cloudflare's servers, and the browser only ever talks to your
own Worker.

This guide assumes **zero coding experience**. Follow it top to bottom
and you'll have the site live.

---

## 1. Project structure

```
tagpulse-ai/
├── worker.js         ← All backend logic (calls Gemini, checks Pro codes)
├── wrangler.jsonc     ← Tells Cloudflare how to run/deploy this project
├── README.md          ← This file
└── public/
    └── index.html      ← Your app's frontend (UI, unchanged)
```

**Important:** `index.html` must go inside a folder named `public`,
sitting next to `worker.js`. This is a small but deliberate change from
a flat layout — if `index.html` sat in the same folder as `worker.js`
and `wrangler.jsonc`, Cloudflare would end up serving those backend
files publicly too, which defeats the whole point of this migration.
Keeping them separate means only what's inside `public/` is ever
visible to visitors.

If you downloaded these files separately, create the `public` folder
yourself and move `index.html` into it before deploying.

---

## 2. Install Wrangler (Cloudflare's command-line tool)

Wrangler is the tool that uploads your project to Cloudflare. You run
these commands on a computer (not your phone) — a laptop or desktop
with [Node.js](https://nodejs.org) installed (any recent version works).

1. Open a terminal (Command Prompt, Terminal app, or similar).
2. Navigate into your project folder:
   ```
   cd path/to/tagpulse-ai
   ```
3. Install Wrangler as a project dependency:
   ```
   npm install --save-dev wrangler
   ```
   This creates a `node_modules` folder and a `package.json` file —
   that's normal and expected.

---

## 3. Log in to Cloudflare

1. If you don't already have one, create a free account at
   [cloudflare.com](https://cloudflare.com).
2. In your terminal, run:
   ```
   npx wrangler login
   ```
3. This opens a browser tab asking you to log in and approve access.
   Click **Allow**. Once approved, you can close that tab and return to
   the terminal — it will say you're logged in.

---

## 4. Add your Gemini API key as a secret

This is the whole point of this migration — your key never touches the
HTML file again. Instead, you store it directly on Cloudflare:

```
npx wrangler secret put GEMINI_API_KEY
```

Wrangler will ask you to paste your key and press Enter. It's stored
encrypted on Cloudflare's side and injected into your Worker at
runtime as `env.GEMINI_API_KEY` — it's never written to any file in
your project.

**Where do I get a Gemini API key?** From
[Google AI Studio](https://aistudio.google.com/apikey) — click "Create
API key" and copy the value that starts with `AIzaSy...`.

---

## 5. Run it locally first (recommended)

Before deploying to the real internet, test everything on your own
computer:

```
npx wrangler dev
```

This starts a local server (usually at `http://localhost:8787`).
Wrangler will also ask for your `GEMINI_API_KEY` locally the first
time, or you can create a `.dev.vars` file in your project root with:

```
GEMINI_API_KEY=your-key-here
```

(Add `.dev.vars` to a `.gitignore` file so you never accidentally
commit it if you use Git.)

Open the local URL in your browser. Try generating a listing and
unlocking Pro with the code `TEST` — both should work exactly like
before.

---

## 6. Deploy to production

Once local testing looks good:

```
npx wrangler deploy
```

Wrangler will print a live URL when it finishes, something like:

```
https://tagpulse-ai.your-subdomain.workers.dev
```

That's it — your site is live, and your API key is safely stored
server-side. Nobody visiting your site can see it, no matter how hard
they inspect the page.

---

## 7. How the new architecture works (short version)

- **Before:** the browser called Google's Gemini API directly, with
  your API key sitting in plain text inside `index.html`.
- **Now:** the browser calls **your own** `/api/generate` and
  `/api/verify-license` endpoints. Your Worker (`worker.js`) receives
  those requests, adds your secret API key server-side, calls Gemini
  itself, and sends back just the result. The key never leaves
  Cloudflare's servers.

Nothing about how the app looks, feels, or behaves has changed — only
where the sensitive logic runs.

---

## 8. About the "TEST" Pro-unlock code

Per your current project scope, real Gumroad license verification
isn't wired up yet. `/api/verify-license` in `worker.js` currently only
accepts the code `TEST` to unlock Pro, exactly like the frontend did
before this migration.

When you're ready to add real Gumroad checkout, open `worker.js`, find
the `handleVerifyLicense` function, set `GUMROAD_PERMALINK` near the
top of the file to your real Gumroad product permalink, delete the
"TEST-ONLY" block, and uncomment the "GUMROAD" block right below it.
Nothing in `index.html` needs to change when you do this — it already
just calls `/api/verify-license` and reads back `{ valid, message }`.

**Heads up:** anyone who tries the code `TEST` can currently unlock Pro
for free. That's fine for your own testing, but change or remove it
before telling real customers about the site.

---

## 9. Common errors & troubleshooting

**"Server is not configured correctly (missing GEMINI_API_KEY)"**
You deployed without setting the secret. Run step 4 again:
`npx wrangler secret put GEMINI_API_KEY`, then redeploy.

**Generating a listing does nothing / spins forever**
Open your browser's developer console (usually F12 or long-press →
Inspect on mobile browsers that support it) and check the Network tab
for the `/api/generate` request. If it shows a red/failed request,
re-check that you deployed successfully and that your API key is
valid in [Google AI Studio](https://aistudio.google.com/apikey).

**"That code isn't valid yet" when testing Pro unlock**
Make sure you're typing exactly `TEST` (it's not case-sensitive, but
check for extra spaces).

**Changes to index.html don't show up after deploying**
Make sure `index.html` is inside the `public/` folder, and that you
ran `npx wrangler deploy` again after making changes — deploying isn't
automatic.

**"command not found: wrangler" or "npx: command not found"**
This means Node.js isn't installed, or your terminal can't find it.
Install Node.js from [nodejs.org](https://nodejs.org) (the LTS
version), restart your terminal, and try again.

**I want to use my own domain instead of `workers.dev`**
In the Cloudflare dashboard, go to your Worker → Settings → Domains &
Routes → Add Custom Domain, and follow the prompts. This requires your
domain's DNS to already be managed by Cloudflare.

**CORS errors in the browser console**
This shouldn't happen with the default setup since the site and API
share the same domain. If you see one anyway, double-check you're
visiting the `workers.dev` URL (or your custom domain) and not opening
`index.html` directly as a local file.

---

## Need to change something later?

- **Frontend (`index.html`)**: edit it inside `public/`, then run
  `npx wrangler deploy` again.
- **Backend logic (`worker.js`)**: edit it, then run
  `npx wrangler deploy` again.
- **Rotate your API key**: get a new one from Google AI Studio, then
  run `npx wrangler secret put GEMINI_API_KEY` again with the new
  value — it overwrites the old one.

That's the whole workflow. No servers to manage, no uptime to worry
about — Cloudflare handles all of that for you.
