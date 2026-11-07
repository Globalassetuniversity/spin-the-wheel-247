# Spin the Wheel 24/7

A self-running public number game. Players open the link any time, enter a
name and a guess from 0 to 100. The wheel spins by itself at the top of every
hour (Eastern Time) — nobody has to press anything or be live.

## Money model (locked in Nov 6, 2026)

- **$5 per play** (single) or **$100 bundle = 22 plays** (20 paid + 2 free).
- Each **paid** play puts $5 in its round's pot. Split of the pot:
  **70% round winner / 10% rollover jackpot / 20% house (Will)**.
  Example: 20 players × $5 = $100 pot → winner $70, jackpot +$10, Will $20.
- **Closest guess wins the round** (70% of the round's paid pot).
- **Hit the exact number and you ALSO take the whole jackpot** (rollover +
  this round's 10%); the jackpot then resets to $0. If nobody hits it
  exactly, the jackpot rolls over and keeps growing.
- **Bonus plays** (the 2 free bundle plays + referral rewards) can win but
  add **$0** to the pot. Free plays are spent before paid credits.
- **Referrals:** every player gets a personal link (`?ref=CODE`). When a
  friend **pays** for at least one game ($5 play or $100 bundle), the
  referrer earns **1 free play**, once per friend who pays. Joining free
  earns nothing.
- Credits live on the player's device (no login — a token in the browser).
  1 credit = 1 guess; credits work across rounds; several guesses in one
  round are fine as long as each number is different.
- All money is integer cents in the code — no float rounding.

## Payments — Square embedded checkout (status: built, NOT switched on)

The game ships in **free preview mode**: plays are free and add $0 to the
pot. Nothing about payments is live until Will does the steps below — the
page says so plainly while it is off.

### How payment works (once switched on)

1. Player taps **Buy 1 play — $5** or **$100 = 22 plays (2 FREE)**. A
   secure card form (Square Web Payments SDK) opens **right on the game
   page** — the player never leaves the site, no redirect, no new tab.
   The card number is tokenized by Square in the browser; it never
   touches this server.
2. The server charges the card via the Square Payments API
   (`POST /v2/payments`) with an idempotency key, and checks the result:
   status must be `COMPLETED`, currency `USD`, amount exactly **$5.00**
   (single) or **$100.00** (bundle). Only then are the plays added —
   instantly, no manual step. A declined card or a wrong amount adds 0
   plays. A Square payment ID can only ever add plays once.
3. The old payment-link redirect flow (`?paid=single|bundle` + claim) is
   retired — embedded checkout is the only payment path.

### Apple Pay & Google Pay (built; Apple Pay needs one Square step to go live)

On an iPhone or Mac in Safari, an **Apple Pay button** appears above the
card form in the checkout panel — the player pays with Face ID / Touch ID
and the token goes through the exact same server charge path as a card
token (same $5 / $100 amounts, same verification, same credits). On
Chrome, Firefox, Safari or Edge, a **Google Pay button** appears in the
same spot and works the same way — no domain file and no registration
needed for Google Pay. On any other browser or device the wallet buttons
stay hidden and the card form works as before. Two pieces make Apple Pay
work:

- **Domain verification file** — already in the repo at
  `public/.well-known/apple-developer-merchantid-domain-association`
  (downloaded from Square) and served by the game server at
  `/.well-known/apple-developer-merchantid-domain-association`.
  Square updates this file from time to time — if Apple Pay ever stops
  verifying, re-download it from
  https://app.squareup.com/digital-wallets/apple-pay/apple-developer-merchantid-domain-association.
- **Domain registration (still to do)** — in the Square Developer
  Console, open the app, switch to **Production**, choose **Apple Pay**
  in the left pane, and **Add Domain** for
  `spin-the-wheel-247-production.up.railway.app`. Apple Pay stays hidden
  until that is done; Google Pay and card payments are unaffected.

### Switching payments on — Will's steps

1. **In Square Dashboard** (phone or computer): **Settings → Developer
   → API keys** (or **Developer Dashboard → Applications → your app**).
   You need three values from the **production** app:
   - **Application ID** (public) — the page needs it to load the card form.
   - **Location ID** (public) — found under **Locations** in the Square
     Dashboard (or in the Developer Dashboard); this is the location
     payments settle to.
   - **Production Access Token** (secret).
2. **Give all three to Muse through the secure form** (never paste the
   token in chat). Muse sets them as environment variables on Railway:
   `SQUARE_APPLICATION_ID`, `SQUARE_LOCATION_ID`,
   `SQUARE_ACCESS_TOKEN`. When all three are set, card payments go live
   on the next deploy — no payment links to create, no code change.
3. **Set the admin code:** pick a private code and give it to Muse
   through the secure form (never in chat). Muse sets it as the
   `ADMIN_CODE` environment variable on Railway. `/admin` is a read-only
   view of the jackpot, house cut, and recent payments.

**Test before going live:** Square sandbox cards (e.g. `4111 1111 1111
1111`, any future expiry, any CVV) work with sandbox credentials. The
local test suite (`node test-payments.js`) exercises the charge flow
against a mock Square server — $5 credits 1 play, $100 credits 22,
declines and wrong amounts credit 0.

## Live chat (built Nov 7, 2026)

A fun, playful chat panel sits right under the wheel. Players chat with
the name/token they already have — no new login. Short messages (200
chars max, one per player every 3 seconds), emoji reactions on every
message (🎉 🙌 😲 😂 🔥 👀 💯 🍀 — tap to add, tap again to remove), and
one-tap shouts (Cheer / Wow / LOL / Hot / Lucky). History keeps the
latest 100 messages. Message text is HTML-escaped on the way out, so no
one can inject markup. The Wheel itself posts a spin announcement in chat
when each round closes. `node test-chat.js` runs the chat test suite.

## How it runs itself

Rounds are 60 minutes, aligned to the America/New_York hour. A tick runs
every 5 seconds (and on every API call): any round whose end time passed is
drawn with a random winning number, winners are paid, and the next round
opens. A restart never loses state — rounds, guesses, credits, points, and
the jackpot live in SQLite.

## Run locally

```bash
npm install
npm start            # http://localhost:3000
```

`ROUND_MINUTES=1 npm start` runs 1-minute rounds (for testing the spin cycle).
`DB_PATH` sets the SQLite file (default `./data.db`).
`ADMIN_CODE` enables `/admin`. Square card payments go live when all three
are set: `SQUARE_APPLICATION_ID`, `SQUARE_LOCATION_ID`,
`SQUARE_ACCESS_TOKEN`. `SQUARE_API_BASE` overrides the Square API host
(testing only). `node test-payments.js` runs the payment test suite against
a mock Square server (no real charges).

## Deploy to Railway (new service)

1. Create a new Railway project → **Deploy from GitHub repo** → pick this repo.
   (Use a NEW project/service — do not reuse the Crypto Hub classroom one.)
2. Add a **Volume**, mount path `/data`.
3. Variables: `DB_PATH=/data/data.db`. Railway sets `PORT` itself.
   Optional: `ADMIN_CODE` (a private code for `/admin`),
   `SQUARE_APPLICATION_ID` + `SQUARE_LOCATION_ID` +
   `SQUARE_ACCESS_TOKEN` (Square production credentials, for card payments).
4. Deploy. Open the Railway-generated URL — the game is live immediately;
   the first round opens on first boot and spins at the next hour.
5. Railway needs the **Hobby plan ($5/month)** for the volume to persist
   across restarts. Without the volume, rounds/credits/jackpot reset on
   every redeploy.

## API

- `GET /api/state?playerToken=…` — current round, countdown end time,
  pot + split, jackpot, guesses, leaderboard, history, sponsors, payments
  config, and (with a token) the player's credits and referral info.
- `POST /api/player` — `{ playerToken, name, ref }` (register/update, capture referral).
- `POST /api/guess` — `{ playerToken, name, guess }` (1 credit in paid mode).
- `GET /api/chat?playerToken=…&since=…` — latest 100 chat messages (or everything newer than `since`), with emoji reaction counts.
- `POST /api/chat` — `{ playerToken, name, text }` (200 chars max, one per player every 3 seconds).
- `POST /api/chat/react` — `{ playerToken, messageId, emoji }` (toggle one of the 8 allowed emojis on a message).
- `GET /api/square-config` — `{ enabled, applicationId, locationId }` (public Square IDs only).
- `POST /api/payments/charge` — `{ playerToken, name, kind, sourceId }` (charges the tokenized card; credits only on a confirmed Square payment).
- `POST /api/admin/stats` — `{ code }` (Will only; jackpot, house cut, payments status, recent payments).
- `GET /api/health` — `{ "ok": true }`.
- `GET /admin` — the read-only stats page for Will.
