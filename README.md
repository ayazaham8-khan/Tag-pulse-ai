# TagPulse AI — Cloudflare Pages + Functions Edition

This is TagPulse AI running on the **official Cloudflare Pages + Functions**
architecture. The app looks and works exactly the same as before — same
UI, same buttons, same animations, same mobile layout. What changed is
purely backend: your Groq API key no longer lives inside the HTML,
and the site now deploys the standard Cloudflare Pages way instead of
as a standalone Worker (which is what caused the Error 522 / routing
conflict you ran into last time — a standalone Worker and a Pages
project competing for the same routes).

This guide assumes **zero coding experience**. Follow it top to bottom
and you'll have the site live.

---

## 1. Project structure

```
tagpulse-ai/
├── public/
│   └── index.html          ← Your app's frontend (UI, unchanged)
├── functions/
│   └── api/
│       ├── generate.js       ← Backend for POST /api/generate
│       └── verify-license.js ← Backend for POST /api/verify-license
└── README.md                ← This file
```

That's it — no `worker.js`, no `wrangler.json`/`wrangler.jsonc`. Cloudflare
Pages automatically turns any file inside `functions/api/` into a live
API route at the matching URL. `functions/api/generate.js` becomes
`/api/generate`, and `functions/api/verify-license.js` becomes
`/api/verify-license` — nothing to configure by hand.

Everything inside `public/` is served as your static site, exactly
like it would be on any normal web host.

---

## 2. Put your project on GitHub

Cloudflare Pages deploys straight from a GitHub repository, so your
code needs to live there first.

1. Go to [github.com](https://github.com) and log in (or create a free
   account).
2. Click the **+** icon in the top-right → **New repository**.
3. Name it something like `tagpulse-ai`, keep it **Public** or
   **Private** (either works), and click **Create repository**.
4. On the new repository's page, click **uploading an existing file**
   (or drag-and-drop).
5. Drag your entire `tagpulse-ai` folder contents in — make sure the
   folder structure from Step 1 is preserved (i.e. `public/index.html`
   and `functions/api/generate.js` should keep those exact paths, not
   get flattened into one folder).
6. Scroll down and click **Commit changes**.

If you're comfortable with Git instead of the web uploader, the
equivalent is:

```
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/your-username/tagpulse-ai.git
git push -u origin main
```

---

## 3. Deploy to Cloudflare Pages

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) and
   log in (create a free account first if you don't have one).
2. In the left sidebar, go to **Workers & Pages**.
3. Click **Create** → **Pages** → **Connect to Git**.
4. Choose the `tagpulse-ai` repository you just created and click
   **Begin setup**.
5. On the build settings screen:
   - **Project name**: `tagpulse-ai` (or anything you like — this
     becomes part of your URL).
   - **Production branch**: `main`.
   - **Framework preset**: choose **None**.
   - **Build command**: leave this **empty**.
   - **Build output directory**: `public`
     (this is the important one — it tells Cloudflare that your
     `index.html` lives inside the `public` folder).
   - **Root directory (Advanced)**: leave this **empty** (or `/`).
     This setting is only for monorepos where your project lives in
     a subfolder of the repository — since `public/` and
     `functions/` sit right at the top of this repo, the default
     empty value is correct. Do not point it at `public` — that's
     what "Build output directory" is for, not this field.
6. Click **Save and Deploy**.

Cloudflare will build and deploy your site — this usually takes under
a minute for a project this size. When it's done, you'll get a URL
like:

```
https://tagpulse-ai.pages.dev
```

Your site is technically live at this point, but generating listings
won't work yet — you still need to add your API key (next step).

---

## 4. Add your GROQ_API_KEY environment variable

This is the whole point of this architecture — your key never touches
the HTML file, and it's stored securely by Cloudflare.

1. In the Cloudflare dashboard, go to **Workers & Pages** → click your
   `tagpulse-ai` project.
2. Go to **Settings** → **Environment variables**.
3. Under **Production**, click **Add variable**.
4. Set:
   - **Variable name**: `GROQ_API_KEY`
   - **Value**: your actual Groq API key (starts with `gsk_...`)
5. Click the **Encrypt** option if offered (keeps it hidden even from
   you in the dashboard afterward) — recommended for a real key.
6. Click **Save**.
7. Repeat the same steps under the **Preview** tab if you want preview
   deployments (e.g. from pull requests) to also be able to generate
   listings.
8. **Important:** after adding an environment variable, you must
   **redeploy** for it to take effect. Go to the **Deployments** tab
   and click **Retry deployment** on the latest one (or just push a
   new commit to GitHub, which triggers a fresh deploy automatically).

**Where do I get a Groq API key?** From the
[GroqCloud console](https://console.groq.com/keys) — click "Create API
key" and copy the value that starts with `gsk_...`.

---

## 5. Test it live

Visit your `https://tagpulse-ai.pages.dev` URL, fill in the generator
form, and click **Generate Optimized Tags**. You should see a title,
13 tags, and a description come back within a few seconds.

To test the Pro unlock flow, click **Upgrade**, enter the code `TEST`,
and click **Unlock Pro** — it should unlock instantly.

---

## 6. Run it locally (optional, for developers)

If you want to test changes on your own computer before pushing to
GitHub:

1. Install [Node.js](https://nodejs.org) if you don't have it.
2. In your project folder, run:
   ```
   npm install --save-dev wrangler
   ```
3. Create a file named `.dev.vars` in your project root (next to
   `public/` and `functions/`) containing:
   ```
   GROQ_API_KEY=your-key-here
   ```
   (Don't commit this file to GitHub — add `.dev.vars` to a
   `.gitignore` file so it never gets uploaded.)
4. Run:
   ```
   npx wrangler pages dev public
   ```
5. Open the local URL it prints (usually `http://localhost:8788`).
   Everything — including `/api/generate` and `/api/verify-license` —
   runs locally, exactly like it will in production.

---

## 7. Deploying updates later

Any time you change `public/index.html` or the files in `functions/`:

- **If using the GitHub web uploader**: upload the changed files again
  and commit. Cloudflare Pages automatically detects the new commit
  and redeploys within a minute or two.
- **If using Git locally**: `git add .`, `git commit -m "..."`,
  `git push`. Same automatic redeploy.

You never need to manually trigger a deploy unless you're just
retrying after adding an environment variable (Step 4.8).

---

## 8. About the "TEST" Pro-unlock code

Per current project scope, real Gumroad license verification isn't
wired up yet. `functions/api/verify-license.js` currently only accepts
the exact code `TEST` (case-insensitive) to unlock Pro — everything
else is reported as invalid, and no external service is called.

When you're ready to add real Gumroad checkout: open
`functions/api/verify-license.js`, set `GUMROAD_PERMALINK` near the top
of the file to your real Gumroad product permalink, delete the
"TEMPORARY DEVELOPMENT VERIFIER" block, and uncomment the "GUMROAD"
block right below it. Nothing in `index.html` needs to change when you
do this — it already just calls `/api/verify-license` and reads back
`{ valid, message }`.

**Heads up:** anyone who tries the code `TEST` can currently unlock Pro
for free. That's fine for your own testing, but replace it with real
verification before telling real customers about the site.

---

## 9. Common mistakes

**Build output directory set to the project root instead of `public`**
If you left this as `/` or blank during setup, Cloudflare will try to
serve `functions/` and other files as if they were part of your site,
and `index.html` may not be found at all. Go to **Settings** → **Builds
& deployments** and correct it to `public`.

**Folder structure got flattened when uploading to GitHub**
If you dragged individual files instead of the whole folder, you might
end up with `index.html`, `generate.js`, and `verify-license.js` all
sitting in the repository root with no `public/` or `functions/api/`
folders. Cloudflare Pages Functions **require** the exact
`functions/api/generate.js` path to create the `/api/generate` route —
re-upload preserving folder structure, or use `git add .` from inside
the correctly-structured folder.

**Forgetting to redeploy after adding the environment variable**
Environment variables only apply to deployments made *after* you save
them. If generation fails right after adding your key, retry the
deployment (Step 4.8).

**Mixing this with a standalone Worker on the same domain**
This is what caused your earlier Error 522. Don't attach a separate
Cloudflare Worker route to the same domain/zone this Pages project
uses — Pages Functions already provide everything you need at
`/api/*`. If you still have the old standalone Worker deployed
anywhere, delete it (Workers & Pages → select the old Worker →
Settings → Delete) to avoid any future conflict.

---

## 10. Troubleshooting

**"Server is not configured correctly (missing GROQ_API_KEY)"**
Your environment variable isn't set, or you haven't redeployed since
adding it. Recheck Step 4.

**Generating a listing spins forever, then fails**
Open your browser's developer console (F12, or long-press → Inspect on
mobile browsers that support it) and check the Network tab for the
`/api/generate` request. A red/failed request usually means either the
API key is invalid (recheck it in the
[GroqCloud console](https://console.groq.com/keys)) or the request
timed out — try again.

**404 on `/api/generate` or `/api/verify-license`**
This almost always means the `functions/api/` folder structure didn't
make it to GitHub correctly, or the build output directory isn't set
to `public`. Recheck Steps 2 and 3.

**"That code isn't valid yet" when testing Pro unlock**
Make sure you're typing exactly `TEST` (not case-sensitive, but check
for extra spaces before/after).

**Changes don't show up after pushing to GitHub**
Check the **Deployments** tab in your Cloudflare Pages project — if
the latest deployment shows a red ✕, click into it to see the error.
Most often this is a typo in a file path.

**CORS errors in the browser console**
Shouldn't happen with the default setup since the site and its API
share the same domain. If you see one anyway, make sure you're
visiting your actual `pages.dev` URL (or custom domain) and not
opening `index.html` directly as a local file from your computer.

**Error 522 (Connection timed out)**
This was the earlier standalone-Worker issue. With this Pages +
Functions architecture it shouldn't happen again — if it does, check
that no old standalone Worker is still attached to the same domain
(see the "Common mistakes" section above).

**I want to use my own domain instead of `pages.dev`**
In your Pages project, go to **Custom domains** → **Set up a custom
domain**, and follow the prompts. This requires your domain's DNS to
already be managed by Cloudflare.

---

## Need to change something later?

- **Frontend (`public/index.html`)**: edit it, then upload/push to
  GitHub. Cloudflare redeploys automatically.
- **Backend logic (`functions/api/generate.js` or
  `functions/api/verify-license.js`)**: edit, then upload/push the
  same way.
- **Rotate your API key**: get a new one from the GroqCloud console,
  then update the `GROQ_API_KEY` environment variable in **Settings** →
  **Environment variables**, and retry the deployment.

That's the whole workflow. No servers to manage, no uptime to worry
about, and no separate Worker to conflict with your Pages project —
Cloudflare handles all of that for you.
