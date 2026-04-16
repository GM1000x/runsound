# RunSound — Byggplan
*Målet: Bygga exakt vad LarryLoop är, fast för musikartister*

---

## Vad vi redan har byggt

Hela innehållspipelinen är klar som Node.js-scripts:
- `optimize-strategy.js` — AI feedback-loop, läser analytics, skriver strategy.json
- `whisper-sync.js` — hittar bästa 15-sekunders hook i låten
- `generate-slides.js` — genererar 6 bilder med gpt-image-1.5
- `add-text-overlay.js` — lägger text på bilderna
- `assemble-video.js` — sätter ihop video + ljud
- `strip-audio.js` — tar bort ljud inför TikTok-upload
- `post-to-tiktok.js` — postar utkast via Postiz
- `check-analytics.js` — hämtar stats
- `daily-report.js` — diagnos + rekommendationer
- `SKILL.md` — agentkonfiguration
- Supabase-schema för smart links och UTM-tracking
- Vercel smart link (Next.js, app/[slug])

Det som saknas är **omslaget** — dashboarden, betalningen och den automatiska körningen.

---

## Steg 0 — Konton du behöver skapa (gör detta idag, tar ~2 timmar)

Dessa konton är gratis att starta. Du behöver dem innan vi kan bygga något.

### 1. GitHub
Gå till github.com och skapa ett konto. Skapa ett privat repository och döp det till `runsound`. Ladda upp hela `runsound`-mappen dit. Vercel kopplas till GitHub — det är så deployments fungerar.

### 2. Vercel
Gå till vercel.com och logga in med ditt GitHub-konto. Gratis tier räcker för att börja.

### 3. Supabase
Gå till supabase.com, skapa ett gratis konto, skapa ett projekt och döp det till `runsound`. Spara **Project URL** och **service_role key** (finns under Settings → API).

### 4. Clerk
Gå till clerk.com, skapa ett konto och ett nytt projekt. Döp det till `runsound`. Clerk hanterar inloggning åt dina artister (Google, email, osv). Spara **Publishable Key** och **Secret Key**.

### 5. Stripe
Gå till stripe.com, skapa ett konto. Du behöver inte aktivera det fullt ut än — vi behöver bara **Publishable Key** och **Secret Key** från dashboardens API-sektion. Stripe hanterar månadsbetalningarna.

### 6. Postiz
Gå till postiz.com, skapa ett konto (betalplan behövs för API-access, ca $20/mån). Under Settings → API, skapa en API-nyckel. Koppla sedan ditt eget TikTok-konto under Channels — detta används för att testa pipelinen. Spara **API Key** och **TikTok Integration ID**.

### 7. Domän
Köp `runsound.fm` eller `runsound.com` på Namecheap eller Google Domains (ca $10-15/år). Vi pekar den mot Vercel när det är dags.

### 8. Trigger.dev
Gå till trigger.dev, skapa ett gratis konto och ett nytt projekt. Trigger.dev är det som körs pipeline-jobben i bakgrunden — det löser timeout-problemet med Vercel (vår pipeline tar 5-10 minuter, serverless-funktioner klarar max 60 sekunder). Spara **Secret Key**.

---

## Steg 1 — Testa pipelinen (denna vecka, ~2 timmar)

Innan vi bygger ett helt SaaS runt pipelinen måste vi bekräfta att den faktiskt fungerar från start till slut. Det gör vi i Replit med ditt eget TikTok-konto som testartist.

**Vad du gör:**
1. Öppna Replit-projektet
2. Uppdatera `package.json` — byt `"canvas": "^2.11.2"` mot `"@napi-rs/canvas": "^0.1.53"` och kör `npm install`
3. Lägg till dessa Replit Secrets:
   - `OPENAI_API_KEY` — din OpenAI-nyckel
   - `POSTIZ_API_KEY` — från Postiz
   - `SUPABASE_URL` — från Supabase
   - `SUPABASE_SERVICE_KEY` — från Supabase
   - `SERPER_API_KEY` — från serper.dev (gratis konto, 2500 sökningar/mån)
4. Uppdatera `runsound-marketing/config.json` med TikTok Integration ID från Postiz
5. Ladda upp en MP3-fil till `runsound-marketing/assets/song.mp3`
6. Kör: `npm run whisper` → ser den hook-timestamp i config.json?
7. Kör: `npm run generate` → genereras 6 bilder? (tar 5-10 minuter)
8. Kör: `npm run overlay && npm run assemble && npm run strip && npm run post`
9. Öppna TikTok — dyker ett utkast upp i din inkorg?

Om ja: pipelinen fungerar. Vi bygger SaaSen.
Om nej: vi felsöker det specifika steget.

---

## Steg 2 — Bygg SaaSen (vecka 2-4)

Det här är det riktiga bygget. Jag bygger allt — du behöver bara godkänna och testa.

### Vecka 2 — Grund och auth

**Vad jag bygger:**
- Next.js-app med Clerk-inloggning
- Landningssida (runsound.fm) med headline, features, pricing, CTA
- `/dashboard` — artistens hem efter inloggning
- Supabase-tabeller för artister, låtar och prenumerationer

**Vad du gör:**
- Godkänner designen
- Delar Clerk- och Supabase-nycklar med mig

### Vecka 3 — Onboarding och betalning

**Vad jag bygger:**
- 6-stegs onboarding-flöde (som Larrys 7 steg, fast för musik):
  - Steg 1: Din låt (titel, genre, mood)
  - Steg 2: Ladda upp MP3 och cover
  - Steg 3: Koppla TikTok (via Postiz OAuth)
  - Steg 4: Smart link-inställningar (Spotify, Apple Music)
  - Steg 5: Välj visuell stil
  - Steg 6: Välj plan (Starter $39/mo, Growth $99/mo)
- Stripe-integration för månadsprenumerationer
- Trigger.dev-jobb som körs när artist onboardas

**Vad du gör:**
- Aktiverar ditt Stripe-konto (fyller i bankuppgifter)
- Testar att betala med ett testkort

### Vecka 4 — Pipeline, analytics och launch

**Vad jag bygger:**
- Vercel Cron som kör `optimize → generate → overlay → assemble → strip → post` kl 07:00 för varje aktiv artist
- Analytics-vy i dashboarden (views, klick, diagnos per post)
- Daglig e-postrapport till artisten
- Trigger.dev-retry-logik om ett steg misslyckas

**Vad du gör:**
- Kopplar domänen runsound.fm till Vercel
- Bjuder in 2-3 testartister (gratis) för att verifiera flödet end-to-end
- Ger feedback på UI

---

## Steg 3 — Launch (vecka 5)

- Produkten är live på runsound.fm
- Stripe är aktivt, artister kan betala
- TikTok-utkast genereras automatiskt varje morgon
- Du behöver inte röra något

**Lanseringsstrategi:**
- Posta din egen artist-onboarding-video på TikTok ("Jag testade ett AI-verktyg som postar åt mig...")
- Erbjud de första 10 artisterna 1 månads gratis (skapar testimonials och social proof)
- Sätt upp ett affiliate-program (30% livstidsprovision, precis som Larry)

---

## Teknisk stack (samma som LarryLoop)

| Lager | Verktyg | Kostnad |
|---|---|---|
| Frontend | Next.js + Vercel | Gratis |
| Auth | Clerk | Gratis upp till 10k MAU |
| Databas | Supabase | Gratis upp till 500MB |
| Betalning | Stripe | 2.9% per transaktion |
| Pipeline-jobs | Trigger.dev | Gratis upp till 50k runs/mån |
| TikTok-posting | Postiz | ~$20/mån |
| Bilder | OpenAI gpt-image-1.5 | ~$0.04/bild × 6 = $0.24/artist/dag |
| Domän | Namecheap | ~$12/år |
| **Total månadskostnad** | | **~$25-30/mån** |

En betalande artist på $39/mån täcker all infrastruktur. Allt däröfer är vinst.

---

## Nästa steg för dig just nu

1. Skapa de 8 kontona i Steg 0 (tar ca 2 timmar)
2. Samla ihop alla API-nycklar i ett dokument
3. Kom tillbaka hit — då startar vi Steg 1 (testa pipelinen) direkt

Det är allt du behöver göra. Jag bygger resten.
