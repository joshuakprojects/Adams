/* Setup → QuickBooks Online (admins). Uses app.js (window.APP). */
(() => {
  const A = window.APP;
  const { api, esc, toast, $, state } = A;
  const STATUS = {
    preview: ['Preview', 'sent'], queued: ['Waiting to send', 'sent'], synced: ['In QuickBooks', 'done'], error: ['Problem', 'cancelled'],
    locked: ['Invoiced — hands off', 'done'], waiting: ['No prices yet', ''],
  };
  const CATS = [['aggregate', 'Aggregate'], ['delivery', 'Delivery fees'], ['septic', 'Septic'], ['bin', 'Bins'], ['toilet', 'Toilets'],
    ['water', 'Water'], ['other', 'Everything else (and lines typed by hand)']];

  async function loadQbo() {
    if (!state.can?.admin) return;
    const s = await api('/qbo');
    const box = $('#qbo-status');
    const where = s.environment === 'production' ? 'live company' : 'sandbox (test company)';
    if (!s.configured) {
      box.innerHTML = `<p><b>Not set up yet.</b> Work orders are saved as <b>previews</b> of the Estimate they'll create, so you can check them below.</p>
        <p class="muted small">To connect: create an app at developer.intuit.com (QuickBooks Online Accounting), add the redirect URI
        <code>${esc(s.redirect_uri)}</code>, then add its keys on Replit as the Secrets <code>QBO_CLIENT_ID</code> and <code>QBO_CLIENT_SECRET</code>
        (and <code>QBO_ENVIRONMENT=production</code> when you're ready for the real company file), and republish.</p>`;
    } else if (!s.connected) {
      box.innerHTML = `<p><b>Ready to connect</b> (${esc(where)}). Until it's connected and switched on, work orders are saved as previews only.</p>`;
    } else {
      box.innerHTML = `<p>Connected to <b>${esc(s.company || 'QuickBooks company ' + s.realm_id)}</b> (${esc(where)}).
        ${s.enabled ? '<b class="ok-text">Sending estimates: ON.</b>' : '<b>Sending estimates: OFF</b> — previews only.'}</p>`;
    }
    $('#qbo-actions').innerHTML = [
      s.configured && !s.connected ? '<button class="btn primary" data-qbo="connect">Connect QuickBooks</button>' : '',
      s.connected ? `<label class="check"><input type="checkbox" id="qbo-on" ${s.enabled ? 'checked' : ''}> Send estimates to QuickBooks</label>` : '',
      s.connected ? '<button class="btn" data-qbo="import">Import customers from QuickBooks</button>' : '',
      s.connected ? '<button class="btn danger" data-qbo="disconnect">Disconnect</button>' : '',
    ].join('');
    await renderMapping(s);
    await loadLog();
  }

  async function renderMapping(s) {
    const el = $('#qbo-mapping');
    if (!s.connected) {
      el.innerHTML = '<p class="muted small">Once connected, pick which QuickBooks product each kind of price goes to, and the HST and tax-exempt codes.</p>';
      return;
    }
    let lists;
    try { lists = await api('/qbo/lists'); } catch (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
    const m = s.mapping || { items: {}, tax: {} };
    const sel = (name, options, value) => `<select name="${name}"><option value="">Pick…</option>${options.map((o) =>
      `<option value="${esc(o.id)}" ${String(value) === String(o.id) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`;
    el.innerHTML = `<form id="qbo-map-form" class="qbo-map">
      <h3>QuickBooks products</h3>
      ${CATS.map(([k, t]) => `<label>${esc(t)} ${sel('items.' + k, lists.items, m.items?.[k])}</label>`).join('')}
      <h3>Tax codes</h3>
      <label>HST (13%) ${sel('tax.hst', lists.tax_codes, m.tax?.hst)}</label>
      <label>Tax exempt (water) ${sel('tax.exempt', lists.tax_codes, m.tax?.exempt)}</label>
      <div class="row-actions"><button class="btn primary" type="submit">Save</button></div>
    </form>`;
    $('#qbo-map-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { items: {}, tax: {} };
      for (const [k, v] of new FormData(e.target).entries()) {
        const [group, key] = k.split('.');
        if (v) body[group][key] = v;
      }
      try { await api('/qbo/mapping', { method: 'POST', body }); toast('Saved'); } catch (err) { toast(err.message); }
    });
  }

  async function loadLog() {
    const rows = await api('/qbo/log');
    $('#qbo-rows').innerHTML = rows.map((r) => {
      const [label, chip] = STATUS[r.status] || [r.status, ''];
      return `<tr><td><b>#${r.job_id}</b></td><td>${esc(r.scheduled_date || '')}</td><td>${esc(r.customer || '')}</td>
        <td><span class="chip ${chip}">${esc(label)}</span>${r.estimate_id ? ` <span class="muted small">estimate ${esc(r.estimate_id)}</span>` : ''}</td>
        <td class="muted small">${esc(r.last_error || '')}</td>
        <td><button class="btn tiny" data-qbo-view="${r.job_id}">View</button></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">Nothing yet — work orders with prices show up here when they\'re saved.</td></tr>';
  }

  async function showPreview(jobId) {
    const p = await api('/qbo/preview/' + jobId);
    const e = p?.payload;
    const money = window.PRICING.money;
    $('#qbo-dialog-title').textContent = `Work order #${jobId} — ${p.status === 'preview' ? 'what would be sent to QuickBooks' : 'the Estimate in QuickBooks'}`;
    $('#qbo-dialog-body').innerHTML = !e ? '<p class="muted">Nothing built yet.</p>' : `
      <p><b>Estimate ${esc(e.DocNumber || '')}</b> · ${esc(e.TxnDate || '')} · status <b>${esc(e.TxnStatus || '')}</b> · customer ${esc(e.CustomerRef?.value || '')}</p>
      <table class="table lines-table"><thead><tr><th>Line</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th><th>Product / tax code</th></tr></thead><tbody>
      ${(e.Line || []).map((l) => `<tr><td>${esc(l.Description)}</td><td class="num">${esc(l.SalesItemLineDetail?.Qty)}</td>
        <td class="num">${money(l.SalesItemLineDetail?.UnitPrice)}</td><td class="num">${money(l.Amount)}</td>
        <td class="muted small">${esc(l.SalesItemLineDetail?.ItemRef?.value || '—')} / ${esc(l.SalesItemLineDetail?.TaxCodeRef?.value || '—')}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted small">Message on estimate: ${esc(e.CustomerMemo?.value || '')}</p>
      <pre class="qbo-note">${esc(e.PrivateNote || '')}</pre>
      ${p.last_error ? `<p class="error">${esc(p.last_error)}</p>` : ''}`;
    $('#qbo-dialog').showModal();
  }

  $('#qbo-panel').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-qbo]');
    const v = e.target.closest('[data-qbo-view]');
    try {
      if (v) return showPreview(v.dataset.qboView);
      if (!b) return;
      const act = b.dataset.qbo;
      if (act === 'connect') location.href = (await api('/qbo/connect')).url;
      if (act === 'import') {
        const r = await api('/qbo/import-customers', { method: 'POST' });
        toast(`Customers: ${r.linked} matched, ${r.added} added to the address book`);
      }
      if (act === 'disconnect' && confirm('Disconnect QuickBooks? Nothing more is sent until it is connected again.')) {
        await api('/qbo/disconnect', { method: 'POST' });
      }
      if (act === 'sync') {
        const r = await api('/qbo/sync', { method: 'POST' });
        toast(`Sent ${r.sent}, previews ${r.previewed}, problems ${r.errors}`);
      }
      if (act === 'queue-open') {
        const r = await api('/qbo/queue-open', { method: 'POST' });
        await api('/qbo/sync', { method: 'POST' });
        toast(`${r.queued} priced work orders checked`);
      }
      loadQbo();
    } catch (err) { toast(err.message); }
  });
  $('#qbo-panel').addEventListener('change', async (e) => {
    if (e.target.id !== 'qbo-on') return;
    if (e.target.checked && !confirm('Start sending a pending Estimate to QuickBooks for every work order that has prices?')) {
      e.target.checked = false;
      return;
    }
    try { await api('/qbo/enabled', { method: 'POST', body: { on: e.target.checked } }); loadQbo(); } catch (err) { toast(err.message); }
  });
  $('[data-close-qbo]').addEventListener('click', () => $('#qbo-dialog').close());

  // Back from QuickBooks's sign-in page.
  const q = new URLSearchParams(location.search);
  if (q.get('qbo')) {
    setTimeout(() => {
      toast(q.get('qbo') === 'connected' ? 'QuickBooks connected. Pick the products and tax codes, then switch sending on.' : `QuickBooks: ${q.get('msg') || 'not connected'}`);
      A.showTab('people');
      history.replaceState(null, '', '/');
    }, 600);
  }

  window.QBO_UI = { loadQbo };
})();
