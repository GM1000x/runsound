# RunSound — Deploy Checklist

Follow these steps in order. The whole thing takes about 20 minutes.

---

## 1. Supabase — run the migrations

Open https://app.supabase.com → your project → SQL Editor.
Run these files in order (copy-paste each one):

1. `supabase/schema.sql` — base tables (skip if already run)
2. `supabase/migrations/add_tiktok_oauth.sql`
3. `supabase/migrations/add_post_log_status.sql`
4. `supabase/migrations/add_onboarding_and_auth.sql`

After running, confirm in Table Editor that `campaigns` has columns:
`dash_token`, `onboarding_status`, `onboarding_error`

---

## 2. Resend — set up email sending

1. Go to https://resend.com and create a free account
2. Add and verify your sending domain (e.g. runsound.fm)
   - If you don't have a domain yet, use their test address for now
3. Create an API key → copy it (used as `RESEND_API_KEY`)

---

## 3. Railway — deploy the app

### First deploy

1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Select your RunSound repo
3. Railway auto-detects Node.js and uses `railway.json`

### Add environment variables

In Railway → your service → Variables, add all values from `.env.example`:

```
PORT                  (Railway sets this automatically — leave blank)
BASE_URL              https://your-app.up.railway.app   ← copy from Railway after first deploy
NODE_ENV              production
SUPABASE_URL          https://xxxx.supabase.co
SUPABASE_SERVICE_KEY  eyJ...
OPENAI_API_KEY        sk-...
POSTIZ_API_KEY        ...
RESEND_API_KEY        re_...
EMAIL_FROM            RunSound <hello@runsound.fm>
CRON_SCHEDULE         0 3 * * *
TZ                    Europe/Stockholm
NOTIFY_EMAIL          your@email.com
```

### Add the scheduler as a second service

1. Railway → your project → New Service → GitHub repo (same repo)
2. In that service's settings → Start Command: `node scheduler.js`
3. Add the same environment variables
4. The scheduler runs 24/7 and fires the pipeline at 3 AM nightly

### Set BASE_URL

After first deploy, Railway gives you a URL like `https://runsound-production.up.railway.app`.
Go back to your **web service** variables and set:
```
BASE_URL=https://runsound-production.up.railway.app
```
Redeploy. This makes dashboard links and smart links work correctly.

---

## 4. Test the full flow

Open your Railway URL and try the complete signup:

1. Go to `https://your-app.up.railway.app`
2. Fill in the signup form (use your own email + "Summer Love" for testing)
3. You'll be redirected to `connect.html` — watch the steps animate in real time
4. After ~8 minutes: check TikTok inbox for the draft
5. Check your email for the welcome message with dashboard link
6. Open the dashboard link — confirm stats page loads

If anything fails, check Railway logs:
- Web service logs → signup/API errors
- Worker service logs → pipeline errors

---

## 5. Point your domain (optional)

In Railway → your web service → Settings → Custom Domain:
Add `runsound.fm` (or whatever domain you have).

Then update `BASE_URL` to your real domain and redeploy.

---

## 6. Manual first run for MBN (Summer Love)

The existing `runsound-marketing/` setup still works for manual runs.
To send a post right now without waiting for the scheduler:

```bash
npm run scheduler:now
```

Or step by step:
```bash
npm run analytics     # fetch TikTok stats
npm run learn         # compute CTR patterns
npm run optimize      # update strategy.json
npm run pick          # pick slides
npm run texts         # generate hook/story/CTA
npm run overlay       # burn text onto images
npm run post          # send to TikTok inbox
```

---

## Checklist summary

- [ ] Supabase migrations run (all 4 files)
- [ ] Resend domain verified + API key copied
- [ ] Railway web service deployed
- [ ] Railway worker (scheduler) deployed
- [ ] All env vars set in both services
- [ ] BASE_URL set to real Railway URL
- [ ] Test signup → connect.html → TikTok draft → email received
- [ ] Dashboard loads with token from email link
