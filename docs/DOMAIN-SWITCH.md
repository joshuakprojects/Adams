# Moving from joshtemp.site to adamsbros.ca

Everything that has to change when the test addresses become the real ones. Keep this up to date: when a new
service is connected that knows the address, add it here.

| Now (testing) | After the switch |
|---|---|
| `joshtemp.site` (website) | `www.adamsbros.ca` (and `adamsbros.ca` → www) |
| `dispatch.joshtemp.site` (dispatch app) | `dispatch.adamsbros.ca` |

**Do it after hours.** Republishing takes the dispatch app off for about 10 minutes, and texts that come in
while it's off are not received.

## Before the day

- [ ] **Find out who runs the adamsbros.ca DNS** (likely Squarespace, where the old site is). Note the current
  **email records (MX, and any TXT for email)** and leave them exactly as they are, or company email stops.
- [ ] **Lower the DNS "TTL"** on the records you'll change to 5 minutes, a day ahead, so the change spreads quickly.
- [ ] **Download a copy** of the dispatch data (Setup → Backups) and keep it on the office PC.

## Dispatch app (Replit: the dispatch project)

1. [ ] **Publishing → Domains → Link a domain:** `dispatch.adamsbros.ca`. Replit shows the DNS records (A and TXT)
   to add at the DNS provider. Wait until Replit says **Verified**.
2. [ ] **Publishing → Secrets:** set `PUBLIC_URL` to `https://dispatch.adamsbros.ca`
   (the links in drivers' and site heads' texts, and the Google / QuickBooks sign-in returns, use it). Republish.
3. [ ] **Texting provider:** change where incoming texts are sent to the new address.
   Sunwire: `https://dispatch.adamsbros.ca/sms/sunwire` · Twilio (phone number → Messaging webhook):
   `https://dispatch.adamsbros.ca/sms/inbound`. Then text **OK** to the office number from a phone and check it
   shows on the Board.
4. [ ] **Google Cloud (project "backups for dispatch") → Google Auth Platform:**
   - Clients → the OAuth client → **Authorized redirect URIs:** add `https://dispatch.adamsbros.ca/gdrive/callback`
     (keep the joshtemp one until the end).
   - Branding: home page `https://www.adamsbros.ca`, privacy policy `https://www.adamsbros.ca/privacy`;
     authorized domains include `adamsbros.ca`.
   - Google Drive stays connected through the move; nothing to reconnect.
5. [ ] **Google Maps keys (Google Cloud → APIs & Services → Credentials):** if the browser key
   (`GOOGLE_MAPS_API_KEY`) is limited to websites, add `dispatch.adamsbros.ca/*` (the Board map and the pin
   drop use it). The server key (`GOOGLE_MAPS_SERVER_KEY`) is limited by API, not address: nothing to do.
6. [ ] **QuickBooks (developer.intuit.com → the app → Keys & credentials → Redirect URIs):** add
   `https://dispatch.adamsbros.ca/qbo/callback`. Only if QuickBooks is connected; it stays connected.
7. [ ] **Staff and drivers:** new bookmark / home-screen icon `https://dispatch.adamsbros.ca`. Everyone logs in
   again once (logins are per address).

## Website (Replit: the website project)

8. [ ] **Publishing → Domains:** link `www.adamsbros.ca` and `adamsbros.ca`. Add the DNS records Replit shows
   (replacing the Squarespace website records only; **not the email records**). The app already sends
   `adamsbros.ca` → `www.adamsbros.ca` and old Squarespace page addresses to the new pages.
9. [ ] **Secrets:** `DISPATCH_URL` = `https://dispatch.adamsbros.ca` (where website orders are sent). Republish.
   Then place a test septic order on the website and check it arrives in dispatch's website requests.
10. [ ] **Admin sign-in (Clerk, for /admin and the projects gallery):** the production Clerk keys must be set up
    for `adamsbros.ca` (Clerk dashboard → Domains; it shows DNS records to add). Then sign in at
    `https://www.adamsbros.ca/admin` to check.
11. [ ] **Emails from the website (Resend):** if `EMAIL_FROM` uses an @adamsbros.ca address, verify the domain in
    Resend (it shows DNS records to add) and send a test from the contact form.
12. [ ] **Google Maps browser key:** if limited to websites, add `www.adamsbros.ca/*` and `adamsbros.ca/*`.
13. [ ] **Search engines:** the test site is hidden from Google automatically and the real domain is shown
    automatically (nothing to switch). In **Google Search Console**, add `www.adamsbros.ca`, submit
    `https://www.adamsbros.ca/sitemap.xml`. In the **Google Business Profile**, set the website to
    `https://www.adamsbros.ca`.

## After the switch

14. [ ] Test: log in to dispatch; text OK from a phone; place a website order; open a driver link from a text;
    connect nothing new. Check Setup → Alerts & day summary and Backups look normal.
15. [ ] Keep **joshtemp.site** pointing at the apps for **a few weeks** (texts already sent and bookmarks still
    use it). Then remove the joshtemp redirect URIs from Google Cloud and QuickBooks.
16. [ ] **Squarespace:** cancel the website plan only after the new site is live. If the **domain is registered
    at Squarespace**, keep (or transfer) the domain registration: cancelling it loses adamsbros.ca and email.
17. [ ] Restore the DNS "TTL" to normal (e.g. 1 hour).

## Settings that do NOT change

- The database (Neon, `DISPATCH_DATABASE_URL`), backups, alerts numbers, Twilio/Sunwire account keys,
  QuickBooks connection, Google Drive connection.
