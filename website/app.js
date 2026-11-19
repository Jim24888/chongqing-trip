(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const data = JSON.parse($('#gallery-data').textContent);
  const stateKey = 'chongqing-guide-picks-v2';
  let state = {}, filter = 'all';
  try { state = JSON.parse(localStorage.getItem(stateKey) || '{}'); if (!state || typeof state !== 'object' || Array.isArray(state)) state = {}; } catch { $('#status').textContent = '当前查看方式不支持保存勾选，攻略仍可正常阅读。'; }
  function persist() { try { localStorage.setItem(stateKey, JSON.stringify(state)); } catch { $('#status').textContent = '勾选仅在本次查看有效。'; } window.CQSync?.changed(); }
  function switchTab(name, scroll = true) {
    $$('[data-tab]').forEach(b => { const on = b.dataset.tab === name; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    $$('.panel').forEach(p => { p.hidden = p.id !== 'panel-' + name; });
    const hash = window.CQSync?.hashForTab(name) || '#' + name;
    try { history.replaceState(null, '', hash); }
    catch { if (location.hash !== hash) location.hash = hash; }
    if (scroll) $('.tabs').scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  $$('[data-tab]').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
    b.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const tabs = $$('[data-tab]');
      const current = tabs.indexOf(b);
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 :
        (current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      switchTab(tabs[index].dataset.tab);
      tabs[index].focus();
    });
  });
  function applyFilter(next) {
    filter = next;
    $$('[data-filter]').forEach(b => { const on = b.dataset.filter === filter; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    let visible = 0;
    $$('.recommend-card').forEach(card => { const id = card.id.slice(4); const show = filter === 'all' || card.dataset.category === filter || (filter === 'saved' && !!state['pick-' + id]); card.hidden = !show; if (show) visible++; });
    $('#empty').hidden = visible > 0;
    document.dispatchEvent(new CustomEvent('guide-filter', { detail: filter }));
  }
  $$('[data-filter]').forEach(b => b.addEventListener('click', () => applyFilter(b.dataset.filter)));
  $$('[data-switch]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); switchTab(a.dataset.switch); if (a.dataset.filterLink) applyFilter(a.dataset.filterLink); }));
  window.CQSync?.register('picks', () => ({...state}), next => {
    state = next;
    try { localStorage.setItem(stateKey, JSON.stringify(state)); } catch {}
    $$('[data-pick], [data-check]').forEach(b => {
      const key = b.dataset.pick ? 'pick-' + b.dataset.pick : 'check-' + b.dataset.check;
      b.checked = !!state[key];
    });
    renderSummary(); if (filter === 'saved') applyFilter(filter);
  });
  function renderSummary() { const chosen = data.filter(it => state['pick-' + it.id]); $('#pick-summary').textContent = chosen.length ? `已选 ${chosen.length} 项：` + chosen.map(it => it.name).join(' · ') : '还没有加入候选，慢慢挑。'; }
  $$('[data-pick], [data-check]').forEach(b => { const key = b.dataset.pick ? 'pick-' + b.dataset.pick : 'check-' + b.dataset.check; b.checked = !!state[key]; b.addEventListener('change', () => { state[key] = b.checked; persist(); renderSummary(); if (filter === 'saved') applyFilter(filter); }); });
  renderSummary();
  $$('[data-gallery]').forEach(g => { let scheduled = false; g.addEventListener('scroll', () => { if (scheduled) return; scheduled = true; setTimeout(() => { scheduled = false; if (!g.clientWidth) return; const item = data.find(it => it.id === g.dataset.gallery); const index = Math.max(0, Math.min(item.photos.length - 1, Math.round(g.scrollLeft / g.clientWidth))); const counter = document.querySelector(`[data-counter="${g.dataset.gallery}"]`); counter.textContent = `${index + 1} / ${item.photos.length}`; const credit = item.photoCredits[index]; document.querySelector(`[data-photo-credit="${item.id}"]`).textContent = credit.label; document.querySelector(`[data-photo-origin="${item.id}"]`).href = credit.url; }); }, { passive: true }); });
  $$('.thumb').forEach(b => b.addEventListener('click', () => { const g = document.querySelector(`[data-gallery="${b.dataset.target}"]`); g.scrollTo({ left: Number(b.dataset.index) * g.clientWidth, behavior: 'smooth' }); }));
  const dialog = $('#lightbox');
  let current = null, index = 0, opener = null;
  function showPhoto() { $('#lightbox-title').textContent = current.name; $('#lightbox-image').src = current.photos[index]; $('#lightbox-image').alt = `${current.name} · 第${index + 1}张来源图片`; $('#lightbox-count').textContent = `${index + 1} / ${current.photos.length}`; const credit = current.photoCredits[index]; const link = document.createElement('a'); link.href = credit.url; link.textContent = credit.label + ' · 查看原出处 ↗'; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('#lightbox-credit').replaceChildren(link); }
  function move(delta) { if (!current) return; index = (index + delta + current.photos.length) % current.photos.length; showPhoto(); }
  $$('.photo-open').forEach(b => b.addEventListener('click', () => { current = data.find(it => it.id === b.dataset.card); index = Number(b.dataset.index); opener = b; showPhoto(); if (typeof dialog.showModal === 'function') { dialog.showModal(); document.body.style.overflow = 'hidden'; } else { window.open(current.photos[index], '_blank', 'noopener'); } }));
  $('#lightbox-close').addEventListener('click', () => dialog.close());
  $('#lightbox-prev').addEventListener('click', () => move(-1));
  $('#lightbox-next').addEventListener('click', () => move(1));
  dialog.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); } if (e.key === 'ArrowRight') { e.preventDefault(); move(1); } });
  dialog.addEventListener('close', () => { document.body.style.overflow = ''; if (opener) opener.focus({ preventScroll: true }); });
  let touchX = null;
  $('#lightbox-image').addEventListener('touchstart', e => { if (e.touches.length === 1) touchX = e.touches[0].clientX; }, { passive: true });
  $('#lightbox-image').addEventListener('touchend', e => { if (touchX === null) return; const delta = e.changedTouches[0].clientX - touchX; touchX = null; if (Math.abs(delta) > 60) move(delta < 0 ? 1 : -1); }, { passive: true });
  $('#print').addEventListener('click', () => window.print());
  const initialTab = new URLSearchParams(location.hash.slice(1)).get('tab') || location.hash.slice(1);
  if ($$('[data-tab]').some(tab => tab.dataset.tab === initialTab)) switchTab(initialTab, false);
})();
