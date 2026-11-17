/* Setup → Backups → Google Drive: connect a Google account so the nightly backup also goes to Drive. Uses app.js (window.APP). */
(function () {
  const A = window.APP;
  if (!A) return;
  const { api, esc, toast } = A;
  const box = document.getElementById('gdrive-box');
  if (!box) return;

  function render(s) {
    if (!s.configured) {
      box.innerHTML = `<h3>Google Drive</h3>
        <p class="small">Keep the nightly backup in your Google Drive too. It needs a one-time set-up in Google Cloud:</p>
        <ol>
          <li>In Google Cloud, make a project, turn on the <b>Google Drive API</b>, and set the OAuth consent screen to <b>In production</b>.</li>
          <li>Make an <b>OAuth client ID</b> (Web application) with this redirect URI: <code>${esc(s.redirect_uri)}</code></li>
          <li>Add its ID and secret to Replit's Secrets as <code>GOOGLE_DRIVE_CLIENT_ID</code> and <code>GOOGLE_DRIVE_CLIENT_SECRET</code>, then Republish.</li>
        </ol>`;
      return;
    }
    if (!s.connected) {
      box.innerHTML = `<h3>Google Drive</h3>
        <p class="small">Not connected. Connect a Google account and the nightly backup and new ticket photos also go to a Drive folder,
          <b>${esc(s.folder)}</b>. The app can only see the files it puts there.</p>
        <div class="row-actions"><button class="btn primary" type="button" data-gd="connect">Connect Google Drive</button></div>`;
      return;
    }
    box.innerHTML = `<h3>Google Drive <span class="pill ok">Connected</span></h3>
      <p class="small">Nightly backups and new ticket photos go to <b>${esc(s.folder)}</b>${s.email ? ` in <b>${esc(s.email)}</b>'s Drive` : ''}.
        Copies older than 30 days are removed there too. If a copy can't be saved, the alert numbers get a text.</p>
      <div class="row-actions"><button class="btn" type="button" data-gd="backup">Back up to Drive now</button>
        <button class="btn danger" type="button" data-gd="disconnect">Disconnect</button></div>`;
  }

  async function load() {
    if (!A.state.can?.admin) return;
    try { render(await api('/gdrive')); } catch (err) { box.innerHTML = `<p class="muted small">Google Drive: ${esc(err.message)}</p>`; }
  }

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-gd]');
    if (!b) return;
    try {
      if (b.dataset.gd === 'connect') { window.location.href = (await api('/gdrive/connect')).url; return; }
      if (b.dataset.gd === 'disconnect') {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to disconnect'; return; }
        render(await api('/gdrive/disconnect', { method: 'POST' }));
        toast('Google Drive disconnected. Backups still go to the other places.');
        return;
      }
      if (b.dataset.gd === 'backup') {
        b.disabled = true; b.textContent = 'Backing up…';
        const out = await api('/gdrive/backup', { method: 'POST' });
        toast(out.ok ? `Saved to Google Drive (${Math.round(out.bytes / 1024)} KB${out.photos ? `, ${out.photos} photos` : ''})` : `Google Drive: ${out.error}`);
        load();
      }
    } catch (err) { toast(err.message); load(); }
  });

  document.addEventListener('click', (e) => { if (e.target.closest('[data-tab="people"], [data-setup-go="backups"]')) load(); });

  // Back from Google's sign-in page.
  const q = new URLSearchParams(location.search);
  if (q.get('gdrive')) {
    setTimeout(() => {
      toast(q.get('gdrive') === 'connected' ? 'Google Drive connected. Tonight\'s backup will go there too.' : `Google Drive: ${q.get('msg') || 'not connected'}`);
      A.showTab('people');
      history.replaceState(null, '', '/');
      load();
    }, 600);
  }
  window.GDRIVE_UI = { load };
})();
