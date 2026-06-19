# Jute sliver parallelization analyzer

A small web app for your team: upload photos of jute sliver, get an
objective fiber-parallelization score (0-100) using image processing
(Sobel gradients + circular statistics — no AI calls, fully algorithmic).
Everyone signs in with just a name, and all uploads are visible to the
whole team with history and trend charts.

This README assumes **no coding experience**. Follow it top to bottom.

---

## Part 1 — Run it on your own computer first (recommended)

This lets you make sure everything works before putting it online.

### 1. Install Node.js

Node.js is the program that runs this app.

- Go to https://nodejs.org
- Download the **LTS** version for your operating system
- Run the installer, click through with default options

### 2. Open a terminal in this folder

- **Windows:** open the `jute-app` folder in File Explorer, click the
  address bar, type `cmd`, press Enter
- **Mac:** open Terminal (search for it in Spotlight), type `cd ` (with a
  space), then drag the `jute-app` folder into the terminal window, press
  Enter

### 3. Install the app's dependencies

In the terminal, type:

```
npm install
```

Press Enter. This downloads everything the app needs (takes 1-2 minutes).
You'll see a new `node_modules` folder appear — that's normal, leave it
alone.

### 4. Start the app

```
npm start
```

You should see:

```
Jute sliver analyzer running at http://localhost:3000
```

### 5. Open it in your browser

Go to **http://localhost:3000** in Chrome, Firefox, or Edge.

Type a name, click Continue, and try uploading a sliver photo. You should
see a score, a gradient map, and a histogram appear.

To stop the app later, go back to the terminal and press `Ctrl+C`.

---

## Part 2 — Put it online so your team can use it

Once Part 1 works, you're ready to deploy. We'll use **Render**, which has
a free tier that's enough for a small team tool.

### 1. Put the code on GitHub

GitHub is a free place to store your code so Render can find it.

- Go to https://github.com and create a free account if you don't have one
- Click the **+** icon (top right) → **New repository**
- Name it `jute-sliver-analyzer`, keep it **Private** if you prefer, click
  **Create repository**
- On the next page, click **uploading an existing file**
- Drag your entire `jute-app` folder's contents into the upload box
  (everything *inside* the folder, not the folder itself — including
  `server.js`, `package.json`, the `public` folder, etc. Skip
  `node_modules` if it's there, GitHub doesn't need it)
- Scroll down, click **Commit changes**

### 2. Create a Render account and connect it

- Go to https://render.com, sign up (you can sign up with your GitHub
  account directly, which makes the next step easier)
- Click **New** → **Web Service**
- Connect your GitHub account if prompted, then select the
  `jute-sliver-analyzer` repository you just created

### 3. Configure the service

Render will show a settings form. Fill in:

- **Name:** `jute-sliver-analyzer` (or anything you like)
- **Region:** pick whichever is closest to you
- **Branch:** `main`
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Instance type:** Free

### 4. Add a persistent disk (important — don't skip this)

Without this step, your uploaded images and database will be **deleted**
every time Render restarts the app (which happens periodically on the free
tier).

- Scroll to **Disks** (or **Advanced** → **Add Disk**, depending on
  Render's current layout)
- Click **Add Disk**
- **Name:** `data`
- **Mount path:** `/opt/render/project/src/data`
- **Size:** 1 GB is plenty

Repeat for uploads:
- **Add Disk** again
- **Name:** `uploads`
- **Mount path:** `/opt/render/project/src/uploads`
- **Size:** 1 GB

(If Render's free tier doesn't allow disks in your account, that's a
real limitation — flag it back and we can switch the image storage to a
free cloud bucket instead. The scores/metrics will still save correctly
either way since those live in the database on the same disk.)

### 5. Deploy

Click **Create Web Service**. Render will install everything and start the
app — this takes a few minutes the first time. Watch the **Logs** tab; when
you see `Jute sliver analyzer running at http://localhost:...`, it's live.

### 6. Get your link

Render gives you a URL like `https://jute-sliver-analyzer.onrender.com`.
That's the link to share with your team — anyone with it can sign in with
their name and start uploading.

---

## Troubleshooting

- **"npm: command not found"** → Node.js isn't installed correctly, redo
  step 1 of Part 1 and restart your terminal afterward.
- **App crashes on Render with a "sharp" error** → this sometimes happens
  if Render's build environment differs from your computer's. Paste me the
  exact error from the Logs tab and I'll fix it.
- **Images disappear after a while** → you skipped the persistent disk step
  (Part 2, step 4). Add the disks and redeploy.
- **Free tier "spins down" the app when unused** → normal on Render's free
  tier; the first visit after idle time takes ~30 seconds to wake up. Fine
  for an internal tool, but mention it to your team so they're not
  confused.

## What's in this folder

| File/folder         | Purpose                                          |
|----------------------|---------------------------------------------------|
| `server.js`          | The web server and all API routes                 |
| `db.js`               | Database setup (SQLite)                          |
| `fiberAnalysis.js`    | The actual image-analysis math (Sobel + stats)   |
| `public/`             | The pages users see (login, dashboard, trends)   |
| `uploads/`            | Where uploaded sample images get stored          |
| `data/`               | Where the database file lives                    |
| `package.json`        | Lists what the app needs to run                  |

## What this version doesn't do yet (possible future additions)

- Password-protected accounts (currently name-only, fine for internal use)
- CSV/PDF export of results
- The AI-based qualitative commentary (separate from this algorithmic
  score) — can be added later as an optional extra note per sample
