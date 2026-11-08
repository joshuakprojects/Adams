# Adams Bros Dispatch

A simple dispatch system for the trucks: the office uses a web dashboard, and **drivers just get a text**.
Drivers don't install an app or log in.

## How it works

1. **The office creates a job** on the dashboard and picks the type: **Haul** (gravel, clear, topsoil, asphalt…),
   **Float** (equipment moves) or **Septic** (pump-outs). They fill in the material or equipment, quantity, number of loads,
   pickup and drop-off, time, site contact and notes, then tick the drivers and the truck each one is taking.
2. **Save & text drivers** sends each driver a plain text with all the details:

   ```
   ADAMS BROS - Job #1001
   Tue Nov 10 @ 7:00 AM
   Truck: T1
   Haul: 3/4" clear - 200 tonnes - 12 loads
   From: Adams pit, Range Rd 20
   To: 45 Oak St, Red Deer
   Customer: Northland Homes
   Site contact: Mike 403-555-1234
   Notes: Dump at back of lot, by the garage pad.

   Reply OK to confirm. Reply DONE when finished.
   Details: https://dispatch.adamsbros.ca/j/Xk3…
   ```

3. **The driver replies `OK`** (or `yes`, `10-4`, `got it`, 👍…) and the board shows **Confirmed ✓ (text)**.
   They get a short reply back so they know it worked. One `OK` confirms every new job sent to them.
4. **The driver replies `DONE`** when finished (or `DONE 1001` if they have more than one job that day).
5. Any other reply, like *"running 20 min late"*, shows up as a **red alert at the top of the board** for the office.
6. The **Details link** is optional. It opens a big-button page with map buttons, a **+1 Load delivered** counter,
   **Job finished**, and **Call dispatch**.

**Scale tickets:** a driver can tap **📷 Add scale ticket photo** on the job page, or just **text a photo** to the
dispatch number. The photo is attached to the job they're on today. Tickets show as thumbnails on the job card.
A texted photo that can't be matched to a job shows up at the top of the board, and the office can attach it to a job.

**Tomorrow's jobs:** every evening (5:00 PM Eastern by default; change or turn it off on the **Setup** tab), each driver
gets one text listing all their jobs for tomorrow, with a details link for each. One `OK` confirms them all.
The board also has a **📱 Text drivers their day** button to send it whenever you want. The automatic send skips
drivers who already got their day, unless something was added or changed.

Other features:
- **Edit a job** that was already texted: the driver is flagged **Needs update**. One click sends an "UPDATED Job" text, and they confirm again.
- **Take a driver off** a job: they automatically get a text saying so.
- **Cancel a job**: everyone who was texted gets a cancellation text.
- **Copy to…** puts the same job and drivers on another day, for multi-day runs.
- The **Drivers today** panel shows who's on what and who's free. The job form warns when a driver is already booked that day.
- The office can mark a driver confirmed, add a load, or mark them done by hand when a driver phones in.
- The **Texts** tab is a full log of every text sent and received.

## Running it

Requires Node.js 22.13 or newer. The only dependency is Express; the database is SQLite (built into Node).

```bash
npm install
cp .env.example .env      # fill in at least ADMIN_EMAIL / ADMIN_PASSWORD
npm run seed              # optional: sample trucks, drivers and jobs
npm start                 # http://localhost:3000
npm test
```

Until Twilio is set up, the app runs in **test mode**. Texts are printed in the server log instead of sent,
and the Texts tab has a "Try a driver reply" box so you can test OK and DONE without a phone.

Add more office logins with:

```bash
npm run add-user -- jane@adamsbros.ca "Jane" "a-good-password"
```

## Going live with texting (Twilio)

1. Create a Twilio account and buy a Canadian local number (roughly $1–2 per month, plus about 1–2¢ per text).
2. Put `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` in `.env`, and set `PUBLIC_URL`
   to the app's real address (for example `https://dispatch.adamsbros.ca`).
3. In Twilio, under the number's settings, set **"A message comes in"** to webhook
   `POST https://dispatch.adamsbros.ca/sms/inbound`. Inbound texts are checked against Twilio's signature.
   Make sure the number is **MMS-capable** so drivers can text ticket photos.

## Hosting

Any small server or VPS works (for example a $5–10/month droplet or Render/Fly.io with a persistent disk).
Run it behind HTTPS on a subdomain like `dispatch.adamsbros.ca` and set `COOKIE_SECURE=true`.
All data is in the `data/` folder: the SQLite database (`DB_PATH`, default `data/dispatch.db`) and ticket photos
(`UPLOAD_DIR`, default `data/uploads`). Back up that folder.
Times use Eastern (`TZ_NAME=America/Toronto`).

## Code layout

| Path | What |
|---|---|
| `src/server.js` | Web server and routes (office API, driver job page, Twilio webhook) |
| `src/dispatch.js` | Dispatch logic: jobs, assignments, sending, reply handling |
| `src/sms.js` | Text wording, reply parsing (OK / DONE), Twilio sending and signature check |
| `src/driverPage.js` | The driver's job page (works without JavaScript) |
| `src/db.js` | SQLite schema |
| `src/auth.js` | Office logins and sessions |
| `public/` | Office dashboard (plain HTML/CSS/JS, no build step) |

## Ideas for later

- Typing the ticket number and weight next to each photo
- Billing export / QuickBooks: jobs already record customer, material, quantity and loads per driver
- Saved customers and pits with exact map pins
