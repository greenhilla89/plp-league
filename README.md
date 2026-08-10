# PLP — Prediction League

Your football prediction league as a real, standalone website: React + Vite frontend, Supabase database, hosted free on Vercel, installable on phones as an app ("Add to Home Screen").

This guide assumes **no technical background**. Follow it top to bottom and you'll have the league live at its own web address, with all your existing data carried over.

---

## What you'll end up with

- A permanent web address like `https://plp-league.vercel.app` you can share with contestants
- Everyone sees the same shared data (stored in your Supabase database)
- Works on phones and can be installed to the home screen like an app
- All your league data from the old version, restored from a backup file

**Total time: roughly 20–30 minutes. Total cost: £0.**

---

## Before you start — two things to have ready

1. **Your Supabase database** — already set up (the `plp_storage` table). Nothing more to do there; the site is pre-configured to talk to it.
2. **A fresh backup of your league data** — in the OLD version of the app, go to **Admin → Backups & data safety → Download full backup now**. This saves a `.json` file to your device. Do this *last thing before you switch over*, so it contains everyone's latest predictions. Keep the old version untouched until you've confirmed the new site has everything.

---

## Step 1 — Put the code on GitHub (~10 minutes)

GitHub is where the website's code lives. Vercel (Step 2) reads it from there.

1. Go to **github.com** and click **Sign up** (free). Verify your email.
2. Once signed in, click the **+** in the top-right corner → **New repository**.
3. Repository name: `plp-league` (or anything you like). Leave it **Public**, and **don't** tick any of the "initialize" checkboxes. Click **Create repository**.
4. On the next page, click the link that says **"uploading an existing file"**.
5. On your computer, **unzip** the `plp-league.zip` you downloaded from this chat, then open the unzipped `plp-league` folder.
6. Select **everything inside** that folder (the `src` folder, `public` folder, `index.html`, `package.json`, `vite.config.js`, `README.md`) and **drag them all into the GitHub upload page**.
   - Important: upload the folder's *contents*, not the folder itself — after uploading, `package.json` should be at the top level of the repository, not inside a `plp-league` subfolder.
   - GitHub's drag-and-drop handles folders fine from a computer; this step is much harder from a phone, so use a computer if you can.
7. Scroll down and click **Commit changes**. Wait for the upload to finish.

## Step 2 — Deploy it with Vercel (~5 minutes)

Vercel turns that code into a live website, free, and redeploys automatically if the code ever changes.

1. Go to **vercel.com** and click **Sign up** → choose **Continue with GitHub** (this links the two accounts — simplest option).
2. After signing in you'll land on a page to import a project. Click **Import** next to your `plp-league` repository. (If you don't see it, click "Add New… → Project" and grant Vercel access to the repository when asked.)
3. Vercel auto-detects everything: **Framework Preset: Vite**, build command `npm run build`, output `dist`. **Don't change anything** — just click **Deploy**.
4. Wait a minute or two. When you see the confetti 🎉, click **Continue to Dashboard**, then **Visit** — that's your live site. The address will be something like `https://plp-league.vercel.app`.

That address is permanent — bookmark it and share it with contestants once you've finished Step 3.

## Step 3 — Restore your league data (~5 minutes)

The brand-new site starts with example seed data. Replace it with your real league:

1. Open your new site and, on the login screen, click **"Organizing this competition? Admin access"** at the bottom.
2. Enter your admin PIN. On a fresh database this is **2210** — if your backup contains a different PIN you'd set, that PIN takes over after the restore.
3. Go to the **Outcomes & Admin** tab → **Backups & data safety** card.
4. Click **Restore from backup file**, choose the `.json` backup you downloaded from the old version, and confirm.
5. You should see "Backup restored". **Check it**: standings, matchdays, rosters, profiles, honours, history — everything should look exactly as it did in the old version.
6. Log out of admin and try logging in as yourself with your normal email + password from the old version — accounts and passwords carry over inside the backup, so they just work.

Once you're satisfied everything's there, tell contestants the new address. Only then retire the old version.

## Step 4 — Contestants install it as an app (optional, 1 minute each)

- **iPhone (Safari):** open the site → tap the Share button → **Add to Home Screen**.
- **Android (Chrome):** open the site → tap the ⋮ menu → **Add to Home screen** (or "Install app").

It then opens full-screen from its own icon, like any app.

---

## Good to know

- **Supabase free tier pauses after ~1 week of no activity.** Your data is NOT lost — the project just goes to sleep. If the site ever shows a loading error after a quiet spell, log into supabase.com and click **Restore project**; it wakes up in a minute or two. During an active season with people checking in, this won't happen.
- **The database keys built into the site are safe to be public.** The site uses Supabase's "anon" key, which is designed to be visible in a website's code. Never put your Supabase *service role* key anywhere in this project.
- **Backups still matter.** The Admin → Backups card works exactly as before — download a manual backup regularly. It's the only copy that lives fully outside the database.
- **Deleting things:** the database is deliberately set up without a "delete" permission from the website (an extra safety net). Removing a contestant/matchday inside the app still works normally — the app rewrites its data rather than deleting rows.
- **Changing the code later:** edit files directly on GitHub (open a file → pencil icon → commit). Vercel redeploys the site automatically within a couple of minutes of any change.

## Project layout (for reference)

```
plp-league/
├── index.html              ← page shell + app metadata
├── package.json            ← dependencies (React, recharts, lucide, Tailwind)
├── vite.config.js          ← build configuration
├── public/
│   ├── manifest.webmanifest  ← makes the site installable
│   ├── sw.js                 ← service worker (app install support)
│   └── icon-*.png            ← home-screen icons
└── src/
    ├── App.jsx             ← the entire league app
    ├── main.jsx            ← startup: installs the storage adapter, renders the app
    ├── storageAdapter.js   ← talks to your Supabase database
    ├── supabaseConfig.js   ← your database address + public key
    └── index.css           ← Tailwind CSS
```
