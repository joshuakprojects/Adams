// QuickBooks Online: a pending Estimate for every work order, kept up to date as the job goes.
//
//  • Saving a work order queues it. The queue builds the Estimate from the job's price lines (QuickBooks products
//    picked per price-book category, HST or exempt tax code per line) and sends it — or, while QuickBooks is switched
//    off or not connected, keeps it as a preview an admin can look at ("what would be sent").
//  • Later changes (prices, loads, ticket photos, the driver's report, done) update the same Estimate.
//  • Once the bookkeeper turns the Estimate into an invoice (or closes it) in QuickBooks, the app stops changing it.
//  • A cancelled work order marks its Estimate "Rejected".
//  • QuickBooks is the master customer list: customers can be imported from it, and a customer the app doesn't
//    know in QuickBooks yet is added there when their first Estimate is sent.
//
// Needs an Intuit developer app: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENVIRONMENT (sandbox | production), and the
// redirect URI <PUBLIC_URL>/qbo/callback registered in that app. Then an admin presses "Connect QuickBooks".
const crypto = require('node:crypto');
const config = require('./config');
const PRICING = require('../public/pricing');
const FORMS = require('../public/forms');
const sms = require('./sms');

class QboError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = { sandbox: 'https://sandbox-quickbooks.api.intuit.com', production: 'https://quickbooks.api.intuit.com' };
const MINOR = 75;
const CATEGORIES = ['aggregate', 'delivery', 'septic', 'bin', 'toilet', 'water', 'other'];
const round2 = PRICING.round2;
const cut = (s, n) => String(s ?? '').slice(0, n);

/**
 * The Estimate for a work order (pure: no QuickBooks calls). map = {
 *   items: { aggregate: '12', delivery: '13', …, other: '1' }, tax: { hst: '5', exempt: '7' }, customerRef: '58' }
 */
function buildEstimate(job, map, { categoryOf = () => 'other' } = {}) {
  const lines = [];
  const missing = [];
  for (const l of job.lines || []) {
    if (l.kind === 'deposit') continue; // deposits are collected, not sold
    const cat = categoryOf(l.item_key);
    const itemRef = map.items?.[cat] || map.items?.other;
    if (!itemRef) missing.push(`a QuickBooks product for "${cat}"`);
    const taxRef = Number(l.taxable) ? map.tax?.hst : map.tax?.exempt;
    if (!taxRef) missing.push(Number(l.taxable) ? 'the HST tax code' : 'the tax-exempt code');
    const priced = l.unit_price != null && l.unit_price !== '';
    const qty = Number(l.qty) || 0;
    const unit = priced ? Number(l.unit_price) : 0;
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: round2(qty * unit),
      Description: cut([l.description, l.note, priced ? '' : '(price to be set)'].filter(Boolean).join(' — '), 4000),
      SalesItemLineDetail: { ItemRef: { value: String(itemRef || '') }, Qty: qty, UnitPrice: unit, TaxCodeRef: { value: String(taxRef || '') } },
    });
  }
  const deposit = (job.lines || []).filter((l) => l.kind === 'deposit').reduce((n, l) => n + PRICING.amount(l), 0);
  const done = (job.assignments || []).reduce((n, a) => n + (a.loads_done || 0), 0);
  const reports = (job.assignments || []).filter((a) => a.report && Object.keys(a.report).length).map((a) => `${a.driver_name}: ${
    Object.entries(a.report).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')}`);
  const progress = [
    `Adams Bros Dispatch work order #${job.id}`,
    job.paper_wo && `Paper W.O. #${job.paper_wo}`,
    job.created_by_name && `Created by ${job.created_by_name}`,
    `Status: ${job.status}${job.completed_at ? ` (${job.completed_at})` : ''}`,
    done ? `Loads done: ${done}` : '',
    job.tickets?.length ? `Ticket photos: ${job.tickets.length} (in Dispatch)` : '',
    job.from_location && `${FORMS.labels(job).from || 'From'}: ${job.from_location}`,
    deposit ? `Deposit to collect: ${PRICING.money(deposit)}` : '',
    job.payment_method && `Payment: ${job.payment_method}`,
    ...reports.map((r) => `Report — ${r}`),
  ].filter(Boolean).join('\n');
  if (!map.customerRef) missing.push('the QuickBooks customer');
  const est = {
    CustomerRef: { value: String(map.customerRef || '') },
    TxnDate: job.scheduled_date,
    DocNumber: cut(`WO-${job.id}`, 21),
    TxnStatus: job.status === 'cancelled' ? 'Rejected' : 'Pending',
    GlobalTaxCalculation: 'TaxExcluded',
    Line: lines,
    CustomerMemo: { value: cut(FORMS.summary(job), 1000) },
    PrivateNote: cut(progress, 4000),
  };
  if (job.billing_address) est.BillAddr = { Line1: cut(job.billing_address, 500) };
  if (job.to_location || job.municipality) est.ShipAddr = { Line1: cut(job.to_location, 500), City: cut(job.municipality, 255), CountrySubDivisionCode: 'ON', Country: 'Canada' };
  if (job.customer_email) est.BillEmail = { Address: cut(job.customer_email, 100) };
  if (job.po_number) est.PrivateNote = cut(`PO #${job.po_number}\n${est.PrivateNote}`, 4000);
  return { estimate: est, missing: [...new Set(missing)] };
}

/** What QuickBooks's customer record should say for an address-book customer. */
function buildCustomer(c) {
  const out = { DisplayName: cut(c.name || sms.prettyPhone(c.phone) || `Customer ${c.id}`, 500) };
  if (c.phone) out.PrimaryPhone = { FreeFormNumber: sms.prettyPhone(c.phone) };
  if (c.email) out.PrimaryEmailAddr = { Address: c.email };
  if (c.billing_address) out.BillAddr = { Line1: cut(c.billing_address, 500) };
  if (c.site_address) out.ShipAddr = { Line1: cut(c.site_address, 500), City: cut(c.municipality, 255) };
  return out;
}

function createQuickBooks(db, dispatch, {
  clientId = config.qbo.clientId, clientSecret = config.qbo.clientSecret, environment = config.qbo.environment,
  redirectUri = `${config.publicUrl}/qbo/callback`, fetchImpl = (...a) => fetch(...a), now = () => Date.now(),
} = {}) {
  const base = API_BASE[environment] || API_BASE.sandbox;
  async function getSetting(key, fallback = null) {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? row.value : fallback;
  }
  async function setSetting(key, value) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }
  const getJson = async (key, fallback) => { try { return JSON.parse(await getSetting(key, '')) || fallback; } catch { return fallback; } };

  // ---------- settings & status ----------
  async function mapping() {
    return getJson('qbo_mapping', { items: {}, tax: {} });
  }
  async function saveMapping(input) {
    const m = { items: {}, tax: {} };
    for (const c of CATEGORIES) if (input?.items?.[c]) m.items[c] = String(input.items[c]).slice(0, 40);
    for (const k of ['hst', 'exempt']) if (input?.tax?.[k]) m.tax[k] = String(input.tax[k]).slice(0, 40);
    await setSetting('qbo_mapping', JSON.stringify(m));
    return m;
  }
  async function tokens() { return getJson('qbo_tokens', null); }
  async function enabled() { return (await getSetting('qbo_enabled', '0')) === '1'; }
  async function setEnabled(on) {
    await setSetting('qbo_enabled', on ? '1' : '0');
    if (on) process.nextTick(() => processQueue().catch(() => {}));
    return status();
  }
  const configured = () => Boolean(clientId && clientSecret);

  async function status() {
    const t = await tokens();
    const counts = Object.fromEntries((await db.all('SELECT status, COUNT(*) AS n FROM qbo_sync GROUP BY status')).map((r) => [r.status, Number(r.n)]));
    return {
      configured: configured(),
      environment,
      redirect_uri: redirectUri,
      connected: Boolean(t?.refresh_token && t?.realm_id),
      company: t?.company_name || '',
      realm_id: t?.realm_id || '',
      enabled: await enabled(),
      live: Boolean((await enabled()) && t?.refresh_token),
      mapping: await mapping(),
      counts,
    };
  }

  // ---------- OAuth ----------
  async function authUrl() {
    if (!configured()) throw new QboError('QuickBooks isn\'t set up yet: add QBO_CLIENT_ID and QBO_CLIENT_SECRET (see the README, "QuickBooks").');
    const state = crypto.randomBytes(16).toString('hex');
    await setSetting('qbo_oauth_state', JSON.stringify({ state, at: now() }));
    const q = new URLSearchParams({ client_id: clientId, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: redirectUri, state });
    return `${AUTH_URL}?${q}`;
  }

  async function tokenRequest(params) {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new QboError(`QuickBooks sign-in failed: ${body.error_description || body.error || res.status}`, 502);
    return body;
  }

  async function saveTokens(body, realmId, extra = {}) {
    const prev = (await tokens()) || {};
    const t = {
      ...prev, ...extra,
      access_token: body.access_token,
      refresh_token: body.refresh_token || prev.refresh_token,
      expires_at: now() + (Number(body.expires_in) || 3600) * 1000 - 60e3,
      realm_id: realmId || prev.realm_id,
    };
    await setSetting('qbo_tokens', JSON.stringify(t));
    return t;
  }

  /** Back from Intuit's sign-in page. */
  async function finishConnect({ code, state, realmId }) {
    const saved = await getJson('qbo_oauth_state', null);
    await db.run("DELETE FROM settings WHERE key = 'qbo_oauth_state'");
    if (!saved || saved.state !== state || now() - saved.at > 15 * 60e3) throw new QboError('That QuickBooks sign-in link expired. Press Connect QuickBooks again.');
    if (!code || !realmId) throw new QboError('QuickBooks didn\'t send back a company. Try connecting again.');
    const body = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    await saveTokens(body, realmId);
    try {
      const info = await call('GET', `/companyinfo/${realmId}`);
      await saveTokens({ access_token: (await tokens()).access_token, expires_in: ((await tokens()).expires_at - now()) / 1000 + 60 }, realmId,
        { company_name: info.CompanyInfo?.CompanyName || '' });
    } catch { /* the name is only for show */ }
    return status();
  }

  async function disconnect() {
    await db.run("DELETE FROM settings WHERE key IN ('qbo_tokens', 'qbo_enabled')");
    return status();
  }

  async function accessToken() {
    const t = await tokens();
    if (!t?.refresh_token) throw new QboError('QuickBooks isn\'t connected');
    if (t.access_token && t.expires_at > now()) return t;
    const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    return saveTokens(body, t.realm_id);
  }

  /** One QuickBooks API call; refreshes the sign-in once if it has expired. */
  async function call(method, path, body, retried = false) {
    const t = await accessToken();
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetchImpl(`${base}/v3/company/${t.realm_id}${path}${sep}minorversion=${MINOR}`, {
      method,
      headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      await saveTokens({ access_token: '', expires_in: -3600 }, t.realm_id);
      return call(method, path, body, true);
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.Fault) {
      const e = out.Fault?.Error?.[0] || {};
      const err = new QboError(`QuickBooks: ${[e.Message, e.Detail].filter(Boolean).join(' — ') || `HTTP ${res.status}`}`, 502);
      err.code = e.code;
      throw err;
    }
    return out;
  }
  const query = (sql) => call('GET', `/query?query=${encodeURIComponent(sql)}`);

  // ---------- lists for the settings screen ----------
  async function lists() {
    const items = (await query("select Id, Name, Type from Item where Active = true maxresults 1000")).QueryResponse?.Item || [];
    const codes = (await query('select Id, Name, Description from TaxCode where Active = true')).QueryResponse?.TaxCode || [];
    return { items: items.map((i) => ({ id: i.Id, name: i.Name, type: i.Type })), tax_codes: codes.map((c) => ({ id: c.Id, name: c.Name, description: c.Description || '' })) };
  }

  // ---------- customers (QuickBooks is the master list) ----------
  async function customerRef(job) {
    const c = job.customer_id ? await dispatch.customers.get(job.customer_id) : null;
    if (c?.qbo_id) return c.qbo_id;
    const data = buildCustomer(c || { name: job.customer, phone: job.customer_phone, email: job.customer_email, billing_address: job.billing_address });
    let id;
    try {
      id = (await call('POST', '/customer', data)).Customer.Id;
    } catch (err) {
      if (String(err.code) !== '6240') throw err; // 6240 = that name is already in QuickBooks: use that customer
      const name = data.DisplayName.replace(/'/g, "\\'");
      id = (await query(`select Id from Customer where DisplayName = '${name}'`)).QueryResponse?.Customer?.[0]?.Id;
      if (!id) throw err;
    }
    if (c) await db.run('UPDATE customers SET qbo_id = ? WHERE id = ?', String(id), c.id);
    return String(id);
  }

  /** Bring QuickBooks customers into the address book (matched by phone, then exact name). */
  async function importCustomers() {
    let start = 1;
    let linked = 0;
    let added = 0;
    for (;;) {
      const page = (await query(`select * from Customer where Active = true startposition ${start} maxresults 500`)).QueryResponse?.Customer || [];
      for (const q of page) {
        const phone = sms.normalizePhone(q.PrimaryPhone?.FreeFormNumber || '') || '';
        const name = q.DisplayName || '';
        let row = await db.get('SELECT id FROM customers WHERE qbo_id = ?', String(q.Id));
        if (!row && phone) row = await db.get('SELECT id FROM customers WHERE phone = ? AND (qbo_id IS NULL OR qbo_id = \'\')', phone);
        if (!row && name) row = await db.get('SELECT id FROM customers WHERE lower(name) = lower(?) AND (qbo_id IS NULL OR qbo_id = \'\')', name);
        if (row) {
          await db.run('UPDATE customers SET qbo_id = ? WHERE id = ?', String(q.Id), row.id);
          linked++;
        } else {
          const saved = await dispatch.customers.save({ name, phone, email: q.PrimaryEmailAddr?.Address || '',
            billing_address: [q.BillAddr?.Line1, q.BillAddr?.City].filter(Boolean).join(', '),
            site_address: q.ShipAddr?.Line1 || '', municipality: q.ShipAddr?.City || '' }).catch(() => null);
          if (saved) { await db.run('UPDATE customers SET qbo_id = ? WHERE id = ?', String(q.Id), saved.id); added++; }
        }
      }
      if (page.length < 500) break;
      start += 500;
    }
    return { linked, added };
  }

  // ---------- the queue ----------
  async function categoryLookup() {
    const rows = await db.all('SELECT key, category FROM price_items');
    const byKey = new Map(rows.map((r) => [r.key, r.category]));
    return (key) => byKey.get(key) || 'other';
  }

  /** A work order changed: (re)build its Estimate soon. */
  async function enqueue(jobId) {
    const id = Number(jobId);
    if (!id) return;
    const row = await db.get('SELECT status FROM qbo_sync WHERE job_id = ?', id);
    if (row?.status === 'locked') return;
    if (row) await db.run("UPDATE qbo_sync SET status = 'queued', updated_at = datetime('now') WHERE job_id = ?", id);
    else await db.run("INSERT INTO qbo_sync (job_id, status) VALUES (?, 'queued')", id);
    clearTimeout(enqueue.timer);
    enqueue.timer = setTimeout(() => processQueue().catch((err) => console.error('QuickBooks sync:', err.message)), 3000);
    enqueue.timer.unref?.();
  }

  let running = null;
  /** Work through queued jobs: send them (QuickBooks on and connected) or keep a preview (off). */
  async function processQueue({ limit = 25 } = {}) {
    // One run at a time; a run asked for meanwhile waits, then picks up whatever was queued since.
    while (running) await running.catch(() => {});
    running = (async () => {
      const live = (await enabled()) && Boolean((await tokens())?.refresh_token);
      const rows = await db.all("SELECT * FROM qbo_sync WHERE status IN ('queued', 'error') ORDER BY updated_at LIMIT ?", limit);
      const out = { sent: 0, previewed: 0, errors: 0, locked: 0 };
      const categoryOf = await categoryLookup();
      const map = await mapping();
      for (const row of rows) {
        const job = await dispatch.getJob(row.job_id);
        // Gone, or a labour work order (not billed): nothing for QuickBooks.
        if (!job || FORMS.typeInfo(job.job_type).noPricing) { await db.run('DELETE FROM qbo_sync WHERE job_id = ?', row.job_id); continue; }
        const set = (fields) => db.run(`UPDATE qbo_sync SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE job_id = ?`,
          ...Object.values(fields), row.job_id);
        // Nothing priced and never sent: nothing to put in QuickBooks yet.
        if (!job.lines.length && !row.estimate_id) { await set({ status: 'waiting', last_error: 'No prices on this work order yet' }); continue; }
        if (!live) {
          const { estimate, missing } = buildEstimate(job, { ...map, customerRef: (await customerQboId(job)) || '(new customer)' }, { categoryOf });
          await set({ status: 'preview', payload: JSON.stringify(estimate), last_error: missing.length ? `Still to set up: ${missing.join(', ')}` : '' });
          out.previewed++;
          continue;
        }
        try {
          let estimate;
          if (row.estimate_id) {
            const current = (await call('GET', `/estimate/${row.estimate_id}`)).Estimate;
            // Turned into an invoice or closed by the bookkeeper: hands off from now on.
            if ((current.LinkedTxn || []).some((t) => t.TxnType === 'Invoice') || ['Closed', 'Accepted', 'Converted'].includes(current.TxnStatus)) {
              await set({ status: 'locked', last_error: '' });
              out.locked++;
              continue;
            }
            const built = buildEstimate(job, { ...map, customerRef: current.CustomerRef?.value }, { categoryOf });
            if (built.missing.length) throw new QboError(`Set up in Dispatch first: ${built.missing.join(', ')}`);
            estimate = (await call('POST', '/estimate', { ...built.estimate, Id: current.Id, SyncToken: current.SyncToken, sparse: false })).Estimate;
          } else {
            const built = buildEstimate(job, { ...map, customerRef: await customerRef(job) }, { categoryOf });
            if (built.missing.length) throw new QboError(`Set up in Dispatch first: ${built.missing.join(', ')}`);
            estimate = (await call('POST', '/estimate', built.estimate)).Estimate;
            await dispatch.logHistory(job.id, 'Estimate created in QuickBooks', `Estimate ${estimate.DocNumber || estimate.Id}`, 'System');
          }
          await set({ status: 'synced', estimate_id: String(estimate.Id), sync_token: String(estimate.SyncToken ?? ''), payload: JSON.stringify(estimate), last_error: '' });
          out.sent++;
        } catch (err) {
          await set({ status: 'error', last_error: String(err.message).slice(0, 500) });
          out.errors++;
        }
      }
      return out;
    })();
    try { return await running; } finally { running = null; }
  }

  async function customerQboId(job) {
    if (!job.customer_id) return null;
    return (await dispatch.customers.get(job.customer_id))?.qbo_id || null;
  }

  async function log(limit = 50) {
    return db.all(`SELECT s.job_id, s.status, s.estimate_id, s.last_error, s.updated_at, j.customer, j.scheduled_date, j.job_type
      FROM qbo_sync s LEFT JOIN jobs j ON j.id = s.job_id ORDER BY s.updated_at DESC, s.job_id DESC LIMIT ?`, limit);
  }
  async function preview(jobId) {
    const row = await db.get('SELECT * FROM qbo_sync WHERE job_id = ?', Number(jobId));
    return row ? { ...row, payload: row.payload ? JSON.parse(row.payload) : null } : null;
  }

  return { status, authUrl, finishConnect, disconnect, setEnabled, saveMapping, lists, importCustomers, enqueue, processQueue, log, preview, call };
}

module.exports = { createQuickBooks, buildEstimate, buildCustomer, QboError, CATEGORIES };
