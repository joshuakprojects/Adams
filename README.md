# Adams Bros Dispatch

A simple dispatch system for the trucks: the office uses a web dashboard, and **drivers just get a text**.
Drivers don't install an app or log in.

## How it works

1. **The office creates a job** on the dashboard and picks the type: work order type (Aggregate, Bin, Septic, Toilet, Float or Misc, see below). They fill in the material or equipment, quantity, number of loads,
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

## Work orders (matching the paper forms)

Each job is one of the office's work order types. The fields come from the paper forms:

| Type | Paper form | Type-specific fields |
|---|---|---|
| 🪨 **Aggregate** | Aggregates Work Order (blue) | Two aggregate lines, each with: aggregate type, circle one (Tandem / Triaxle / H&G), # of loads OR # of yards |
| 🗑️ **Bin** | Bin Work Order (green) | Bin size; Deliver bin / Empty & return / Empty & no return / H&G |
| 💧 **Septic** | Septic pump-out sheet | Tank size, elevation, hose length, lids uncovered, tank type, tank location, steep driveway, back in, directions |
| 🚻 **Toilet** | Portable toilet rental (blue) | Deliver / pick up / service, expected pick-up date, up to 3 toilet types with counts, placement, extra servicing |
| 🚜 **Float** | Equipment moves | Equipment, pick up and drop off |
| 🛠️ **Misc** | Miscellaneous Work Order | Work or material, quantity, loads |

Every type also has the fields that are on all the forms: customer name, phone, email, billing/mailing address,
PO #, delivery address, municipality, site contact, delivery date, quoted price and payment method. If a job was
first written in a paper book, the paper W.O. # can be recorded too.

- **Driver reports:** for septic, the driver fills in the *observed conditions of tanks* half of the sheet on their
  phone (baffles, liquid level, filter, lids…) with big tap buttons. Any driver can leave notes for the office.
- **Payments are handled by the office.** Quoted price and payment method are office-only: they're never in the
  driver's text or on their page, and changing them doesn't re-text anyone.
- **🖨 Print** opens the job laid out like the paper form, with the chosen options circled, the driver's report filled in,
  and the company header and HST #. A septic sheet with no report yet prints the conditions section blank so it can be filled in by hand.
- **Book pick-up** on a toilet or bin job creates the return trip on the pick-up date.
- The fields for each type are defined in one place, `public/forms.js`. Add or change a question there and the
  office form, driver text, driver page and printout all follow.

Not covered yet: the **equipment rental agreement** (counter rentals with a signature). That could be added as its own type.

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

1. Sign up at <https://www.twilio.com/try-twilio> and **upgrade** the account (add a payment method).
   A trial account can only text numbers you've verified, and it adds a trial message to every text.
2. Buy a **Canadian local number** with **SMS and MMS** (a 705 number is easiest for drivers to recognise):
   Console → Phone Numbers → Buy a number → Country: Canada. Costs roughly $1–2/month plus about 1–2¢ per text.
3. Put these in `.env` and restart:
   ```
   TWILIO_ACCOUNT_SID=AC...        # console home page
   TWILIO_AUTH_TOKEN=...           # console home page (click "show")
   TWILIO_FROM_NUMBER=+1705...     # the number you bought
   PUBLIC_URL=https://dispatch.adamsbros.ca
   ```
4. Run `npm run twilio`, or open **Setup → Texting** on the dashboard. It checks the credentials, the number
   (SMS/MMS), whether the account is still a trial, and where incoming texts go.
5. Run `npm run twilio -- connect`, or click **Connect number to this app**. This points the number's incoming texts at
   `PUBLIC_URL/sms/inbound`, so you don't need to set it by hand in the console. Incoming texts are verified with Twilio's signature.
6. Run `npm run twilio -- test 705-555-1234`, or use **Send test text**, to text your own phone. Reply **OK** and check the
   **Texts** tab: the reply should show up there.

Texts go out as soon as step 3 is done, even with the app on your own computer. Driver **replies**, ticket
photos and the job links need the app online at a public `https://` address (see Hosting).

## Hosting

Any small server or VPS works (for example a $5–10/month droplet or Render/Fly.io with a persistent disk).
A `Dockerfile` is included: mount a persistent volume at `/app/data` and set the `.env` values as environment variables.
Run it behind HTTPS on a subdomain like `dispatch.adamsbros.ca` and set `COOKIE_SECURE=true`.
All data is in the `data/` folder: the SQLite database (`DB_PATH`, default `data/dispatch.db`) and ticket photos
(`UPLOAD_DIR`, default `data/uploads`). Back up that folder.
Times use Eastern (`TZ_NAME=America/Toronto`). The company details printed on work orders (address, phone, HST #) can be changed with the `COMPANY_*` settings in `.env`.

## Code layout

| Path | What |
|---|---|
| `src/server.js` | Web server and routes (office API, driver job page, Twilio webhook) |
| `src/dispatch.js` | Dispatch logic: jobs, assignments, sending, reply handling |
| `src/sms.js` | Text wording, reply parsing (OK / DONE), Twilio sending and signature check |
| `public/forms.js` | The work order types and their fields, modelled on the paper forms (shared by server and dashboard) |
| `src/driverPage.js` | The driver's job page and after-job report (works without JavaScript) |
| `src/printPage.js` | Printable work orders laid out like the paper forms |
| `src/db.js` | SQLite schema |
| `src/auth.js` | Office logins and sessions |
| `public/` | Office dashboard (plain HTML/CSS/JS, no build step) |

## Ideas for later

- Typing the ticket number and weight next to each photo
- Billing export / QuickBooks: jobs already record customer, material, quantity and loads per driver
- Saved customers and pits with exact map pins
