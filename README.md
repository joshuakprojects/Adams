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

**Keeping the board tidy:** the board shows one day. The filter chips switch between **Active** (the default: still to
text, waiting, or being worked), **Needs attention** (no driver, not texted, needs an update text, no OK after 30 minutes,
or a driver texted about it), **Done**, **Cancelled** and **All**, and by work order type. Each person's choice is remembered.
Done jobs fold into a "✓ Completed today" strip at the bottom. If any job from an earlier day was never marked done,
a banner says so, and **Review** lists them with **Move to today**, **Mark complete**, **Edit** or **Cancel**.

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
| 🪨 **Aggregate** | Aggregates Work Order (blue) | Deliver to site or **haul away from site** (show up empty); optionally **keep hauling until the site says stop**; two aggregate lines, each with: aggregate type, circle one (Tandem / Triaxle / H&G), # of loads OR # of yards |
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

## Orders from the website

Orders placed on the website (septic pumping, aggregates, bins, portable toilets, quotes) come into dispatch
automatically and wait in the **Requests** tab, with a count of new ones. Each shows the customer, address,
what they ordered and the website's estimate. **Schedule…** opens the matching work order already filled in:
septic tank type and size, lids, driveway, add-ons (in the special instructions), and the estimate as the quoted price.
The office picks the date and drivers and saves. **Duplicate** and **Decline** clear requests you won't schedule.

- Dispatch: set the `INTAKE_KEY` secret to a long random string.
- Website: set `DISPATCH_URL` (e.g. `https://dispatch.joshtemp.site`) and `DISPATCH_INTAKE_KEY` (the same string),
  then give the website's Replit Assistant the instructions in [`docs/website-integration.md`](docs/website-integration.md).
- The website can also ask dispatch for an order's status (scheduled / completed, job #, date) to show in its /admin.

## Records and tax season

Work orders are never deleted; they're kept in the database. The **Records** tab finds past work orders by
date range (quick buttons for this year, last year, this month and last month), status, type, and a search by customer,
address, municipality, W.O. # or phone.

- **⬇ Download spreadsheet (CSV):** opens in Excel or Google Sheets, one row per work order, with W.O. #, paper W.O. #,
  date, type, status, completed date, customer and billing details, PO #, address and municipality, the work, loads,
  drivers, trucks, quoted price, payment method, invoice # and amount billed, form details, the driver's report, and ticket photo count.
- **🖨 Print / Save as PDF:** every matching work order on its own page, laid out like the paper forms, with the
  scale ticket photos. In the print window choose *Save as PDF* to keep a file.

## Customers, septic reminders and history

- **Customers tab (address book):** every job is linked to a customer, matched by phone number (or exact name when there's
  no phone). New jobs and website orders add customers automatically; existing details are filled in but never overwritten.
  In the job form, start typing a name and pick the customer: phone, email, billing and site address fill in, and their
  notes (gate code, dog in yard, where the tank is) can be added to the driver's instructions. Each customer shows all their jobs.
- **Due for pump-out:** customers whose last completed septic pump-out was more than 2 years ago (1–5, set on the Setup
  tab), with the tank type and size from last time. **Book pump-out** opens a septic work order filled in from the last
  one; **Mark contacted** hides them for 90 days. Nothing is sent to customers automatically.
- **Invoice # and Amount billed** (office only) are on each work order, in the Records spreadsheet and on the printout.
- **History:** a job's **More → History** shows who did what and when: office edits (field by field, by login), texts sent,
  driver replies and job-page taps, ticket photos, and completion.

## Logins and roles

Everyone has their own login. Only the owner (`OWNER_EMAIL`, default **josh@adamsbros.ca**) sees **Setup → Logins**, where
logins are added, changed (name, role, new password) and removed.

| Role | Can |
|---|---|
| **Office** | Board (open and save work orders, but not assign or text drivers), Requests, Customers, Prices, Questions |
| **Dispatcher** | Everything Office can, plus assigning and texting drivers, Texts and Records |
| **Admin** | Everything, including Setup and changing prices and questions |

The server checks the role on every action, not just what the screen shows. Logins that existed before roles were added
are Admins. To create the owner login the first time, in the Replit Shell:
`npm run add-user -- josh@adamsbros.ca "Josh" "a-good-password" admin`

## Booking jobs

- **Saving a work order never texts drivers.** Dispatch texts them from the board (the button on each job card, or
  **Text drivers their day**) when they're ready.
- **Time** is **First thing / AM / PM / Any time**; customers aren't given exact times. (Jobs saved with an exact time
  before this change were switched to AM or PM.)
- **Calendar** (on the board, next to Lanes / List / Map): the month with the number of jobs each day; click a day to
  open it. Jobs can be booked any distance ahead.
- **Required fields:** an admin picks, for each work order type, which fields must be filled in (Setup → Required fields;
  to start with: customer name, phone and address). If any are missing the form says which, and the job can be
  **saved as a draft** instead — handy for jobs booked weeks ahead. Drafts show greyed out with what they still need,
  and can't be texted to drivers until they're finished. A pin dropped on the map counts as the address.
- **Printed work orders** show who created the work order, when, and when it was printed.
- **Website requests** and **All texts from drivers** open from the board (the Website requests tile and the link under
  the tiles), so there are fewer tabs.

## Prices

The **Prices** tab is the office price sheets (2025 Aggregate, Delivery Fees, 2025 Septic, Roll-off, Toilet & Water).
Everyone can look prices up; **admins** edit a price in the table and press **Save**. Every change is listed under
*Price changes*. A work order keeps the price it was booked at, so changing the price book never changes old jobs.

**Price a job** (left side of the Prices tab) works out a quote from the address and a few choices, and
**Turn into a work order** opens the job form with everything filled in.

In the job form, **Price & payment** prices the work order automatically as it's filled in:
- **Distance:** the delivery address is looked up and the **driving distance** from the starting point (116 William St,
  changeable per job or in *Pricing settings*) picks the delivery fee. Inside the Town of Parry Sound boundary = the town price.
  No address yet? **Drop a pin** on the map. Google not set up? **Type the km**.
- **Aggregate:** material per tandem/triaxle load (or per yard) + delivery fee per load + $10 per delivery + $10 per triaxle load.
- **Bins and toilets:** delivery and pick-up are each charged; bin deposits are shown separately. Bin disposal is per ton
  from the scale ticket.
- **Septic:** up to 1000 gal flat; larger tanks per gallon; non-members of the lagoon (by municipality) pay the non-member
  disposal rate. Off-schedule +$100.
- Lines can be changed or added by hand (from the price book or free text); those are kept when the price is worked out again.
  **Reset to price book** undoes hand changes. Totals include HST (13%; water is exempt).

### Google keys for distances

Distances are worked out by the server, so they need a **second** Google key (Google doesn't accept the website-restricted
map key from a server):
1. Google Cloud console → **APIs & Services → Library**: enable **Geocoding API** and **Routes API**.
2. **Credentials → Create credentials → API key**. Name it "dispatch server". *Application restrictions*: None.
   *API restrictions*: Restrict key → tick **Geocoding API** and **Routes API**.
3. On Replit add it as the secret **`GOOGLE_MAPS_SERVER_KEY`** and republish.

## QuickBooks Online

Built and **switched off** until the company is ready. Every work order with prices gets a **pending Estimate** in
QuickBooks (QuickBooks has no "pending invoice"; the bookkeeper opens the Estimate and clicks *Create invoice*):
- It's created when the work order is saved, and updated as the job goes: price changes, bin tonnage, loads done, ticket
  photos, the driver's report (in the Estimate's private note), done. Once the Estimate is turned into an invoice (or
  accepted/closed) the app stops changing it. A cancelled work order marks its Estimate *Rejected*.
- Deposits aren't sold, so they go in the note, not as a line. HST or tax-exempt per line (water is exempt).
- **QuickBooks is the master customer list:** *Import customers from QuickBooks* links them to the address book (by phone,
  then name); a customer QuickBooks doesn't have yet is added there with their first Estimate.
- Until it's connected and switched on, **Setup → QuickBooks Online** lists each work order with a **preview** of the
  Estimate it would send (*View*), so you can check it first.

To go live:
1. At **developer.intuit.com** create an app (QuickBooks Online and Payments → Accounting scope). Under *Keys & OAuth*
   add the redirect URI `https://<your dispatch address>/qbo/callback`.
2. On Replit add the Secrets **`QBO_CLIENT_ID`** and **`QBO_CLIENT_SECRET`** (development keys work with Intuit's sandbox
   company; for the real company file use the production keys and add **`QBO_ENVIRONMENT`** = `production`). Republish.
3. **Setup → QuickBooks Online → Connect QuickBooks**, sign in and pick the company.
4. Pick a QuickBooks product for each kind of price and the HST / exempt tax codes, *Import customers*, check a few
   previews, then tick **Send estimates to QuickBooks** (and *Check all priced work orders* to send the ones already booked).

The QuickBooks sign-in is kept in the database but never in backups.

## Customer questions

The **Questions** tab holds the standard answers to customer questions, so everyone answers the same way. Admins add,
edit and delete them; everyone can search them.

## Map

The board has a **Map** layout next to Lanes and List: each job is a pin coloured by stage (to text, waiting for OK,
working, done), with the yard marked. Click a pin for the job, Edit and Directions. If a pin is in the wrong spot (rural
addresses often are), drag it: the spot is saved for that job and remembered for the customer's next job at the same address.

It uses Google Maps and needs a browser key:
1. In [Google Cloud console](https://console.cloud.google.com/), create a project and turn on **Maps JavaScript API** and **Geocoding API**.
2. **Credentials → Create credentials → API key.** Restrict it: *Application restrictions → Websites*, add
   `https://dispatch.joshtemp.site/*` (your dispatch address); *API restrictions* → those two APIs.
3. Set it as `GOOGLE_MAPS_API_KEY` (on Replit: **Secrets**, then republish).

Google's monthly free allowance normally covers an office this size; addresses are looked up once and reused for 30 days.

## Backups

The whole database (jobs, customers, drivers, prices, history, logins) is saved **every hour** and **every night after
2 AM** (Eastern), with any new ticket photos. Hourly copies are kept 48 hours, nightly copies 30 days, photos for good.
Copies go to:
- **The cloud — Replit App Storage.** In the project open **App Storage**, create a bucket (once), copy its ID and add it as
  the Secret **`BACKUP_BUCKET_ID`**. (Elsewhere than Replit: the folder `data/backups/`, or `BACKUP_DIR`.)
- **Your own server**, as a second, separate copy, once it exists. Add Secrets and republish:
  - **WebDAV** (Synology / QNAP NAS with WebDAV turned on, Windows Server IIS, Nextcloud):
    `BACKUP_SERVER_URL` = `https://nas.example.ca:5006/adams-backups`, `BACKUP_SERVER_USER`, `BACKUP_SERVER_PASSWORD`.
  - **S3-compatible storage** (a NAS's S3 service, MinIO, Backblaze B2, Amazon S3):
    `BACKUP_SERVER_URL` = `s3://bucket-name` (optionally `s3://bucket-name/folder`), `BACKUP_SERVER_ENDPOINT` =
    `https://s3.example.ca`, `BACKUP_SERVER_REGION` (default `us-east-1`), `BACKUP_SERVER_USER` = access key ID,
    `BACKUP_SERVER_PASSWORD` = secret key.
  The server has to be reachable from the internet over HTTPS (ask whoever sets it up to open that port, with a login).
  If one place is down, the other still gets its copy, and the one that failed is tried again 15 minutes later.
- **The office hard drive:** **Setup → Backups → Download a copy (with photos)** gives one .zip with the database and every
  ticket photo in a folder per work order (`Photos/WO-1042 - Customer - date/…`), plus `Photos/index.csv` listing which photo
  is which. Move it onto the drive each evening. (*database only* gives just the database.) The .zip includes customer
  details and the office logins (passwords are scrambled), so keep the drive somewhere safe.

The Setup tab shows each place's last good copy and any problem, and has **Back up now**.

**Restore button (easiest):** Setup → Backups → **Restore** (only the owner login sees it). Pick a backup from the list
— nightly, hourly, or a "safety" copy — or choose a downloaded .zip, type RESTORE, and the live app is put back the way it
was then, photos included. A safety copy of how things were just before is saved first, so a restore can be undone the
same way. Everyone logs in again afterwards (the logins come back from the backup too).

From the Shell instead, into an empty database (e.g. a fresh Replit database):
```bash
npm run restore -- list                 # stored copies (nightly and hourly)
npm run restore -- latest               # or a night: 2026-11-09, or an hour: 2026-11-09-14
npm run restore -- ./adams-dispatch-backup-2026-11-09.zip    # a downloaded copy: database and photos
npm run restore -- latest --from server # from your own server instead of the cloud
```
Add `--force` to wipe a database that already has data. Then restart / republish.

## Running it

Requires Node.js 22.13 or newer. The only dependency is Express; the database is SQLite (built into Node).

```bash
npm install
cp .env.example .env      # fill in at least ADMIN_EMAIL / ADMIN_PASSWORD
npm run seed              # optional: sample trucks, drivers and jobs
npm start                 # http://localhost:3000
npm test                  # tests on SQLite
npm run test:pg           # the same tests on PostgreSQL (set TEST_DATABASE_URL)
```

Until Twilio is set up, the app runs in **test mode**. Texts are printed in the server log instead of sent,
and the Texts tab has a "Try a driver reply" box so you can test OK and DONE without a phone.

Add more office logins with:

```bash
npm run add-user -- jane@adamsbros.ca "Jane" "a-good-password"
```

## Drivers, labourers and texts

- **Labourers** are added on the Setup tab in their own column (name and cell, no truck). In the job form they're listed
  under the drivers; they get the same texts, job page link and OK / DONE replies.
- **Labour work orders** (Labour in the job form) are just the boss telling the crew where to be and what to do: date,
  time, *what they're doing*, *where*, site contact, what to bring, who to report to and instructions. No customer billing,
  no prices, nothing sent to QuickBooks. Labourers are listed first when picking who's going.
- **Which job a text is about:** "WO 1042", "W.O. #1042", "work order 1042", "job 1042" and "#1042" always count as a job
  number. A plain number only counts when it's one of that person's open jobs, so "pumped 1200 gallons" isn't taken for job
  #1200.
- **A photo with no job number:** it goes on the job they're working on, or their only job today. With more than one job
  and none under way, the app doesn't guess: it replies *"Which job is it for? Reply with the job number: 1042 (Smith), 1043
  (Jones)"*, and the number they send puts the photo on that job. If the number arrives as a separate text just after the
  photo (some phones split them), the photo is moved to that job. DONE without a number works the same way.
- **Notes** texted with a job number (or by someone with one job) are added to that job's history, and still shown to the
  office on the board.
- The **job page link** in each text is still the surest way to send photos: they always land on the right job.

## Texting from the office (VoIP) number

Texts go out through Twilio from (249) 701-4820 for now. To send from the office VoIP number instead, there are two ways
— ask the VoIP provider which they support:
1. **Twilio "Hosted SMS":** the number stays with the VoIP provider for calls, and Twilio handles its texts. Nothing in the
   app changes except `TWILIO_FROM_NUMBER`. (Twilio checks the number is yours; the VoIP provider must allow it.)
2. **The VoIP provider's own texting:** if they have a texting API with a "webhook" for incoming texts (VoIP.ms, Telnyx,
   Bandwidth and others do), the app needs a small adapter for that provider — tell the developer the provider's name.
   All sending is in `src/sms.js` (`sendSms`) and incoming texts arrive at `/sms/inbound` in `src/server.js`.

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

## Hosting on Replit (e.g. a demo at dispatch.joshtemp.site)

Run the dispatch app as its own Replit project, next to the website, on a subdomain.

1. In Replit: **Create → Import from GitHub** → `joshuakprojects/Adams` (use the branch with the dispatch app).
   The included `.replit` file sets up Node 22.
2. Open **Secrets** (the padlock) and add:

   | Secret | Value |
   |---|---|
   | `PUBLIC_URL` | `https://dispatch.joshtemp.site` |
   | `COOKIE_SECURE` | `true` |
   | `ADMIN_EMAIL` / `ADMIN_PASSWORD` | the first office login |
   | `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | from Twilio (`+12497014820`) |
   | `DEMO_DATA` | `true` for a demo: fills an empty board with sample jobs (remove for real use) |

3. Click **Run** to try it in Replit's preview, then **Deploy → Reserved VM**. Choose Reserved VM rather than Autoscale so the app
   stays awake for the 5 PM "tomorrow's jobs" text and for driver replies.
4. In the deployment's **Settings → Link a domain**, enter `dispatch.joshtemp.site`. Replit shows the DNS records to add
   wherever joshtemp.site's DNS is managed. The main website isn't affected.
5. Log in at `https://dispatch.joshtemp.site`, go to **Setup → Texting**, and click **Connect number to this app**.
   Driver replies and ticket photos now come in.

For the demo, add yourself (and your boss) as drivers with your real cell numbers and assign them a job; the sample drivers
have made-up 555 numbers that never receive texts.

### Database on Replit (keeps data permanently)

Replit doesn't keep files across republishes, so on Replit the app stores everything, ticket photos included, in
Replit's built-in **PostgreSQL** database. In the project, open **Tools → Database** and create a PostgreSQL database.
Replit then sets `DATABASE_URL`, and the app uses it automatically; the start-up log says `Database: PostgreSQL`.
Without `DATABASE_URL` (on a laptop, for example) it uses a local SQLite file instead.

## Hosting

Any small server or VPS works (for example a $5–10/month droplet or Render/Fly.io with a persistent disk).
A `Dockerfile` is included: mount a persistent volume at `/app/data` and set the `.env` values as environment variables.
Run it behind HTTPS on a subdomain like `dispatch.adamsbros.ca` and set `COOKIE_SECURE=true`.
With `DATABASE_URL` set, everything, ticket photos included, is in PostgreSQL. The nightly backups (see Backups) are a second copy.
Without it, everything is in the SQLite file `data/dispatch.db` (`DB_PATH`). Back up that file.
Times use Eastern (`TZ_NAME=America/Toronto`). The company details printed on work orders (address, phone, HST #) can be changed with the `COMPANY_*` settings in `.env`.

## Code layout

| Path | What |
|---|---|
| `src/server.js` | Web server and routes (office API, driver job page, Twilio webhook) |
| `src/dispatch.js` | Dispatch logic: jobs, assignments, sending, reply handling |
| `src/intake.js` | Orders from the website: intake API, Requests inbox, filling in work orders |
| `src/sms.js` | Text wording, reply parsing (OK / DONE), Twilio sending and signature check |
| `public/forms.js` | The work order types and their fields, modelled on the paper forms (shared by server and dashboard) |
| `src/driverPage.js` | The driver's job page and after-job report (works without JavaScript) |
| `src/printPage.js` | Printable work orders laid out like the paper forms (one, or a whole date range) |
| `src/records.js` | Spreadsheet (CSV) export of work orders |
| `src/customers.js` | Address book and septic pump-out reminders |
| `src/geo.js` | Map pin lookups cache |
| `src/backup.js`, `src/backupTargets.js`, `src/zip.js` | Hourly/nightly backups (cloud, your server), the download .zip, restore (`scripts/restore.js`) |
| `src/prices.js`, `src/priceSeed.js` | Price book (starting prices copied from the price sheets) |
| `public/pricing.js` | The pricing rules: works out a work order's price lines (shared by the server and the dashboard) |
| `src/distance.js` | Driving distance (Google Geocoding + Routes) and the Parry Sound town boundary check |
| `src/roles.js` | Office / Dispatcher / Admin permissions |
| `src/quickbooks.js`, `public/qbo-ui.js` | QuickBooks Online: pending Estimates per work order, customer import, the Setup panel |
| `public/pricing-ui.js` | Prices tab, job-form price panel, Questions, Logins |
| `src/db.js` | Database tables, and the PostgreSQL / SQLite drivers |
| `src/auth.js` | Office logins and sessions |
| `public/` | Office dashboard (plain HTML/CSS/JS, no build step) |

## Ideas for later

- Typing the ticket number and weight next to each photo
- Billing export / QuickBooks: jobs already record customer, material, quantity and loads per driver
