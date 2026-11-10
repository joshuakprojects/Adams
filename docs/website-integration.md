# Sending website orders to Adams Bros Dispatch

**Paste everything below the line into the Replit Assistant of the *website* project.**

---

When a customer submits any order or quote form on this website (septic pumping, aggregates, roll-off bins,
portable toilets, the general quote form, and any other service form), keep saving it exactly as we do now
(so it still shows in /admin). **Also** send a copy to our dispatch system:

- `POST {DISPATCH_URL}/api/intake`
- Headers: `Content-Type: application/json` and `Authorization: Bearer {DISPATCH_INTAKE_KEY}`
- Read `DISPATCH_URL` and `DISPATCH_INTAKE_KEY` from Replit Secrets. Never put the key in browser code:
  send this request **from the server**, right after the order is saved.
- If dispatch is down or returns an error, **don't** show an error to the customer and don't block the order.
  Log it, and retry later if possible. Sending the same order `id` again is safe: dispatch updates the order instead of duplicating it.
- Dispatch answers `201` (new) or `200` (updated) with `{ "ok": true, "request_id": 12 }`. Save `request_id` on the order if convenient.

## The JSON body (same shape for every form)

```json
{
  "id": "the order's id in the website database (string)",
  "service": "septic | aggregate | bin | toilet | quote | other",
  "submitted_at": "2026-11-09T14:05:00Z",
  "customer": { "name": "Full name", "phone": "705-555-1234", "email": "a@b.ca", "billing_address": "" },
  "location": { "address": "116 William St", "municipality": "Parry Sound" },
  "requested_date": "2026-11-12 or null",
  "estimate": {
    "subtotal": 395.57, "hst": 51.43, "total": 447.00,
    "lines": [ { "label": "Member-area pump-out up to 1,000 gallons", "amount": "395.57" },
               { "label": "Locating and digging lids", "amount": "Staff confirmation" } ],
    "note": "Site conditions and additional labour require staff confirmation"
  },
  "notes": "anything the customer typed in a comments box",
  "details": { "...": "service-specific, see below" }
}
```

Leave out anything a form doesn't ask for. `requested_date` is only for when the customer picked a specific date.

## `details` for each service

### Septic pumping (`"service": "septic"`)
```json
{
  "system_type": "septic | holding | pump_chamber",
  "tank_size_gallons": 1000,
  "scheduling": "regular_route | alternate_date",
  "lids": "uncovered | digging_required | not_sure",
  "steep_driveway": "no | yes | not_sure",
  "air_attachments": "no | yes | not_sure",
  "add_pump_chamber": false,
  "ecoethic": false
}
```
These map to the form: System type (Septic Tank / Holding Tank / Pump Chamber Only), Approximate size,
Scheduling (Next Regular Route / Request Alternate Date, so also send `requested_date`), the three access questions,
and the Pump Chamber / EcoEthic add-ons.

### Aggregates (`"service": "aggregate"`)
```json
{ "material": "Sand fill", "quantity": 10, "unit": "yards | tonnes | loads", "fulfillment": "delivery | pickup" }
```
Use the material name exactly as shown to the customer. For more than one material, send one order per material,
or put the extra materials in `notes`.

### Roll-off bins (`"service": "bin"`)
```json
{ "bin_size": "20 yd", "service": "deliver | empty_return | empty_no_return | haul_and_go",
  "pickup_date": "2026-11-20", "material_type": "household / construction / shingles…" }
```

### Portable toilets (`"service": "toilet"`)
```json
{ "toilets": [ { "type": "Standard", "qty": 2 }, { "type": "Wheelchair accessible", "qty": 1 } ],
  "pickup_date": "2026-11-24", "placement": "where to place it", "extra_servicing": "weekly pump-out" }
```
Use `requested_date` for the delivery date.

### Quote form and anything else (`"service": "quote"` or `"other"`)
```json
{ "service_name": "Excavation", "description": "what the customer wrote", "...": "any other fields as key/value" }
```
Every field is shown to the office, so use readable names.

## Optional: show the dispatch status in /admin

`GET {DISPATCH_URL}/api/intake/{id}` with the same Authorization header returns
`{ "status": "new | scheduled | declined | duplicate | completed | cancelled", "job_number": 1012, "scheduled_date": "2026-11-12" }`.
Show it next to each order in /admin (e.g. "Scheduled for Nov 12 — job #1012").

## Test

After building it, submit one test order of each type. Then tell me the HTTP status dispatch returned for each.
They should appear under **Requests** at {DISPATCH_URL}.
