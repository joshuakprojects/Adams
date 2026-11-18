/* The app's ▶ Videos: a player with this page's videos first. Any element with data-video="<slug>" opens that one. */
(() => {
  const list = () => window.AB_VIDEOS || [];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const page = () => (document.body.classList.contains('reception') ? 'reception' : (window.APP?.state?.tab || 'board'));
  const forRole = (v) => {
    const can = window.APP?.state?.can || {};
    if (can.snow_only) return v.pages.includes('snow');
    return true;
  };

  let dlg;
  function open(slug) {
    const here = page();
    const vids = list().filter(forRole).sort((a, b) => Number(b.pages.includes(here)) - Number(a.pages.includes(here)));
    const pick = vids.find((v) => v.slug === slug) || vids[0];
    if (!pick) return;
    if (!dlg) {
      dlg = document.createElement('dialog'); dlg.id = 'vid-dialog'; document.body.append(dlg);
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg || e.target.closest('[data-vclose]')) return close();
        const b = e.target.closest('[data-vpick]'); if (b) show(b.dataset.vpick);
      });
      dlg.addEventListener('close', () => dlg.querySelector('video')?.pause());
    }
    dlg.innerHTML = `<div class="vid-wrap"><div class="vid-head"><h2>How-to videos</h2><button type="button" class="x" data-vclose aria-label="Close">×</button></div>
      <div class="vid-body"><div class="vid-main"><video controls playsinline preload="metadata"></video><div class="vid-title"></div></div>
      <ol class="vid-list">${vids.map((v) => `<li><button type="button" data-vpick="${v.slug}"><img src="/videos/${v.slug}.jpg" alt="" loading="lazy">
        <span><b>${esc(v.title)}</b><span>${esc(v.who)} · ${window.AB_VIDEO_LEN(v.secs)}</span></span></button></li>`).join('')}</ol></div>
      <p class="vid-foot">Send someone all of them: <a href="/videos/" target="_blank" rel="noopener">${esc(location.host)}/videos</a> (no login needed)</p></div>`;
    dlg.showModal();
    show(pick.slug);
  }
  function show(slug) {
    const v = list().find((x) => x.slug === slug); if (!v) return;
    const el = dlg.querySelector('video');
    el.className = v.phone ? 'phone' : '';
    el.poster = `/videos/${slug}.jpg`; el.src = `/videos/${slug}.mp4`;
    el.play().catch(() => {});
    dlg.querySelector('.vid-title').textContent = v.title;
    dlg.querySelectorAll('[data-vpick]').forEach((b) => b.classList.toggle('on', b.dataset.vpick === slug));
  }
  function close() { dlg.querySelector('video')?.pause(); dlg.close(); }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-video]');
    if (!t) return;
    e.preventDefault();
    open(t.dataset.video);
  });
  window.VIDEOS = { open };
})();
