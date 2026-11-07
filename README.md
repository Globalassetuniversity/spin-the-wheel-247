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

## Payments — Square (status: built, NOT switched on)

The game ships in **free preview mode** (`payments.json` → `"mode": "free"`):
plays are free and add $0 to the pot. Nothing about payments is live until
Will does the steps below — the page says so plainly while it is off.

### How payment works (once switched on)

1. Player taps **Buy 1 play — $5** or **$100 = 22 plays (2 FREE)**. A Square
   payment link opens in a new tab; the player pays there.
2. Square sends the player back to the game with the order ID attached.
   The player taps **Claim** (single or bundle). The claim is `pending`.
3. The claim is CONFIRMED — and only then are credits issued — in one of
   two ways:
   - **(a) Square auto-verify (best, fully self-running):** if
     `SQUARE_ACCESS_TOKEN` is set on the server, the server checks the
     order with the Square Orders API and confirms it automatically when
     the order is COMPLETED for the exact amount. A used order ID can only
     ever credit once.
   - **(b) Will confirms in `/admin`:** open `/admin`, enter the
     `ADMIN_CODE`, match the player's name/amount/time against the Square
     sale, tap **Confirm**. (Needed only when no Square token is set, or
     when auto-verify could not confirm an order.)
4. A redirect URL alone never credits anyone — it can be faked by typing
   it in. A guess only counts once its credit is issued.

### Switching payments on — Will's steps

1. **In Square Dashboard** (phone or computer): go to **Payments** (or
   **Orders & payments**) → **Payment Links** → **Create link**.
   - Link 1: purpose **Collect a payment** (or **Take a payment**), title
     e.g. `Wheel Play — 1 play`, amount **$5.00**, one-time. In **Advanced
     settings** turn on **Redirect to a website after checkout** and enter
     the game URL + `?paid=single` (e.g.
     `https://YOUR-GAME-URL/?paid=single`). Save → **Copy link**.
   - Link 2: same flow, title e.g. `Wheel Bundle — 22 plays`, amount
     **$100.00**, redirect URL the game URL + `?paid=bundle`. Save → copy.
2. **Send the two links to Muse** (paste them in chat is fine — they are
   public checkout links, not secrets). Muse puts them in `payments.json`
   (`singlePlayUrl`, `bundleUrl`) and sets `"mode": "link"`, then redeploys.
3. **(Optional but recommended — makes it fully self-running)** Connect
   Square for auto-verify: in Square Dashboard → **Settings → Developer →
   API keys** (or **Developer Dashboard → Applications → your app**), copy
   the **production Access Token** and give it to Muse through the **secure
   form** (never paste it in chat). Muse sets it as the `SQUARE_ACCESS_TOKEN`
   environment variable on Railway. Without it, every payment waits for Will
   to tap Confirm in `/admin`.
4. **Set the admin code:** pick a private code and give it to Muse through
   the secure form (never in chat). Muse sets it as the `ADMIN_CODE`
   environment variable on Railway. `/admin` is how Will confirms payments
   when auto-verify is off.

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
`ADMIN_CODE` enables `/admin`. `SQUARE_ACCESS_TOKEN` turns on Square
auto-verify. `SQUARE_API_BASE` overrides the Square API host (testing only).

## Deploy to Railway (new service)

1. Create a new Railway project → **Deploy from GitHub repo** → pick this repo.
   (Use a NEW project/service — do not reuse the Crypto Hub classroom one.)
2. Add a **Volume**, mount path `/data`.
3. Variables: `DB_PATH=/data/data.db`. Railway sets `PORT` itself.
   Optional: `ADMIN_CODE` (a private code for `/admin`),
   `SQUARE_ACCESS_TOKEN` (Square production token, for auto-verify).
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
- `POST /api/payments/claim` — `{ playerToken, name, kind, orderId, receiptRef }`.
- `POST /api/admin/claims|confirm|reject` — `{ code, ... }` (Will only).
- `GET /api/health` — `{ "ok": true }`.
- `GET /admin` — the payment-confirmation page for Will.
