// Small pieces of the app's own look, used by every page:
//  1. drop-down lists (the list that opens under a <select>) drawn in the app's style instead of the plain system list
//  2. messages (alert) and questions (msAsk) as the app's own windows instead of the plain system boxes
(function () {
  const css = `
  .ms-pop { position:fixed; z-index:100000; min-width:160px; max-height:320px; overflow:auto; padding:6px; border-radius:14px; background:#1a2148; border:1px solid rgba(255,255,255,.14); box-shadow:0 14px 34px rgba(0,0,0,.45); font:500 13px/1.3 Inter, "Segoe UI", system-ui, sans-serif; color:#eef1f8; }
  .ms-pop button { all:unset; box-sizing:border-box; display:flex; align-items:center; gap:8px; width:100%; padding:8px 12px; border-radius:8px; cursor:pointer; white-space:nowrap; }
  .ms-pop button::before { content:""; width:14px; flex:none; text-align:center; } .ms-pop button.on::before { content:"\\2713"; }
  .ms-pop button:hover, .ms-pop button:focus-visible { background:#3b6cff; color:#fff; } .ms-pop button:disabled { opacity:.4; pointer-events:none; }
  .ms-pop.nm button::before { display:none; } .ms-pop hr { border:0; border-top:1px solid rgba(255,255,255,.12); margin:5px 8px; } .ms-pop button.dg { color:#ff8a90; } .ms-pop button.dg:hover { background:#e5484d; color:#fff; }
  .ms-pop .g { padding:8px 12px 4px; font-size:10.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; opacity:.6; }
  .ms-pop.lt, .ms-box.lt .c { background:#fff; color:#13201a; border-color:rgba(0,0,0,.12); }
  .ms-box { position:fixed; inset:0; z-index:100001; display:grid; place-items:center; background:rgba(4,6,15,.6); font:500 14px/1.5 Inter, "Segoe UI", system-ui, sans-serif; }
  .ms-box .c { width:min(440px, 92vw); padding:22px 22px 18px; border-radius:22px; background:#161c40; color:#eef1f8; border:1px solid rgba(255,255,255,.14); box-shadow:0 24px 60px rgba(0,0,0,.5); display:flex; flex-direction:column; gap:16px; }
  .ms-box .t { display:flex; gap:14px; align-items:flex-start; } .ms-box .t p { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; flex:1; }
  .ms-box .ic { width:36px; height:36px; border-radius:50%; flex:none; display:grid; place-items:center; background:rgba(59,108,255,.2); color:#8fb0ff; font-weight:800; font-size:18px; }
  .ms-box.warn .ic { background:rgba(255,93,108,.18); color:#ff8a90; }
  .ms-box .b { display:flex; justify-content:flex-end; gap:8px; }
  .ms-box .b button { all:unset; box-sizing:border-box; padding:9px 18px; border-radius:999px; font-weight:600; font-size:13px; cursor:pointer; background:rgba(255,255,255,.1); color:inherit; }
  .ms-box.lt .b button { background:rgba(0,0,0,.07); }
  .ms-box .b button.p { background:#3b6cff; color:#fff; } .ms-box .b button.d { background:#e5484d; color:#fff; }
  .ms-box .b button:focus-visible { outline:2px solid #fff; outline-offset:2px; }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const light = () => { try { return /light/.test(getComputedStyle(document.documentElement).colorScheme) && !/dark/.test(getComputedStyle(document.documentElement).colorScheme); } catch { return false; } };

  // ---- 1. drop-down lists ----
  let pop = null, popFor = null;
  function closePop() { if (pop) { pop.remove(); pop = null; popFor = null; } }
  function openPop(sel) {
    closePop();
    const p = document.createElement('div'); p.className = 'ms-pop' + (light() ? ' lt' : ''); p.setAttribute('role', 'listbox');
    let cur = null;
    const add = (o) => {
      if (o.hidden || o.style.display === 'none') return;
      const b = document.createElement('button'); b.type = 'button'; b.textContent = o.textContent; b.disabled = o.disabled; b.setAttribute('role', 'option');
      if (o.selected) { b.className = 'on'; cur = b; }
      b.onclick = () => { closePop(); if (sel.value !== o.value || !o.selected) { o.selected = true; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); } sel.focus(); };
      p.appendChild(b);
    };
    [...sel.children].forEach((c) => {
      if (c.tagName === 'OPTGROUP') { const g = document.createElement('div'); g.className = 'g'; g.textContent = c.label; p.appendChild(g); [...c.children].forEach(add); }
      else if (c.tagName === 'OPTION') add(c);
    });
    if (!p.querySelector('button')) return;
    document.body.appendChild(p); pop = p; popFor = sel;
    const r = sel.getBoundingClientRect(); p.style.minWidth = Math.max(160, r.width) + 'px';
    const h = p.offsetHeight, w = p.offsetWidth, below = window.innerHeight - r.bottom - 8;
    p.style.top = (below >= Math.min(h, 200) ? r.bottom + 6 : Math.max(8, r.top - 6 - h)) + 'px';
    if (below < h && below >= 200) p.style.maxHeight = below - 6 + 'px';
    p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    if (cur) { cur.scrollIntoView({ block: 'nearest' }); }
    p.addEventListener('keydown', (e) => {
      const bs = [...p.querySelectorAll('button:not(:disabled)')], i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (bs[i + 1] || bs[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (bs[i - 1] || bs[bs.length - 1]).focus(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closePop(); sel.focus(); }
    });
    return cur || p.querySelector('button');
  }
  // a small menu under a button, in the same style: msMenu(button, [{ t: 'Play', fn }, null (a line), { t: 'Delete', fn, danger: true }])
  window.msMenu = (anchor, items) => {
    if (pop && popFor === anchor) { closePop(); return; }
    closePop();
    const p = document.createElement('div'); p.className = 'ms-pop nm' + (light() ? ' lt' : ''); p.setAttribute('role', 'menu');
    items.forEach((it) => {
      if (!it) { const h = document.createElement('hr'); p.appendChild(h); return; }
      const b = document.createElement('button'); b.type = 'button'; b.textContent = it.t; b.setAttribute('role', 'menuitem'); if (it.danger) b.className = 'dg';
      b.onclick = () => { closePop(); it.fn(); }; p.appendChild(b);
    });
    document.body.appendChild(p); pop = p; popFor = anchor;
    const r = anchor.getBoundingClientRect(), h = p.offsetHeight, w = p.offsetWidth;
    p.style.top = (window.innerHeight - r.bottom - 8 >= h ? r.bottom + 6 : Math.max(8, r.top - 6 - h)) + 'px';
    p.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
    p.addEventListener('keydown', (e) => { const bs = [...p.querySelectorAll('button')], i = bs.indexOf(document.activeElement); if (e.key === 'ArrowDown') { e.preventDefault(); (bs[i + 1] || bs[0]).focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); (bs[i - 1] || bs[bs.length - 1]).focus(); } else if (e.key === 'Escape') { e.stopPropagation(); closePop(); anchor.focus(); } });
  };
  const usable = (s) => s && s.tagName === 'SELECT' && !s.multiple && !(s.size > 1) && !s.disabled && !s.hasAttribute('data-native');
  document.addEventListener('mousedown', (e) => {
    if (pop && !pop.contains(e.target)) { const same = popFor === e.target, menuBtn = popFor && popFor.tagName !== 'SELECT' && popFor.contains(e.target); if (menuBtn) return; closePop(); if (same) { e.preventDefault(); return; } }
    const s = e.target.closest ? e.target.closest('select') : null;
    if (e.button === 0 && usable(s)) { e.preventDefault(); s.focus(); openPop(s); }
  }, true);
  document.addEventListener('keydown', (e) => {
    const s = e.target;
    if (usable(s) && (e.key === ' ' || e.key === 'Enter' || e.key === 'F4' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')))) { e.preventDefault(); const b = openPop(s); if (b) b.focus(); }
  }, true);
  window.addEventListener('blur', closePop); window.addEventListener('resize', closePop);
  document.addEventListener('scroll', (e) => { if (pop && !pop.contains(e.target)) closePop(); }, true);
  document.addEventListener('wheel', (e) => { if (pop && !pop.contains(e.target)) closePop(); }, { capture: true, passive: true });

  // ---- 2. messages and questions ----
  function box(text, o) {
    return new Promise((done) => {
      closePop();
      const m = document.createElement('div'); m.className = 'ms-box' + (o.warn ? ' warn' : '') + (light() ? ' lt' : ''); m.setAttribute('role', o.ask ? 'alertdialog' : 'alert'); m.setAttribute('aria-modal', 'true');
      m.innerHTML = '<div class="c"><div class="t"><span class="ic" aria-hidden="true"></span><p></p></div><div class="b"></div></div>';
      m.querySelector('.ic').textContent = o.ask ? '?' : '!';
      let t = String(text == null ? '' : text); try { if (!o.ask && window.msNice) t = window.msNice(t); } catch {}
      m.querySelector('p').textContent = t;
      const before = document.activeElement;
      const end = (v) => { m.remove(); document.removeEventListener('keydown', key, true); try { if (before && before.focus) before.focus(); } catch {} done(v); };
      const bb = m.querySelector('.b');
      const mk = (label, cls, v) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = cls; b.onclick = () => end(v); bb.appendChild(b); return b; };
      if (o.ask) mk(o.no || 'Cancel', '', false);
      const ok = mk(o.ok || (o.ask ? 'Continue' : 'OK'), o.danger ? 'd' : 'p', true);
      const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); } else if (e.key === 'Tab') { const bs = [...bb.querySelectorAll('button')]; e.preventDefault(); bs[(bs.indexOf(document.activeElement) + 1) % bs.length].focus(); } e.stopPropagation(); };
      document.addEventListener('keydown', key, true);
      m.addEventListener('mousedown', (e) => { if (e.target === m && !o.ask) end(false); });
      document.body.appendChild(m); ok.focus();
    });
  }
  // a message: shown in the app's own window (does not stop the app while it is open)
  let chain = Promise.resolve();
  window.alert = (text) => { chain = chain.then(() => box(text, { warn: true })); };
  // a question: await msAsk('Delete it?', { ok: 'Delete', danger: true }) gives true or false
  window.msAsk = (text, o) => box(text, Object.assign({ ask: true }, o || {}));
})();

// ---- 3. an X on every pop-up window ----
// A pop-up that has no close button of its own gets one in the top right corner. It closes the pop-up the same way
// clicking outside it (or pressing Esc) does; a question (msAsk) counts as Cancel.
(function () {
  const st = document.createElement('style');
  st.textContent = `.ms-x { position:absolute; top:10px; right:10px; z-index:5; width:30px; height:30px; padding:0; border:0; border-radius:8px; background:rgba(255,255,255,.09); color:inherit; font:400 20px/1 system-ui, sans-serif; cursor:pointer; display:grid; place-items:center; }
  .ms-x:hover, .ms-x:focus-visible { background:rgba(255,255,255,.2); outline:none; } .lt .ms-x, html.t-light .ms-x { background:rgba(0,0,0,.07); } html.t-light .ms-x:hover { background:rgba(0,0,0,.14); }`;
  document.head.appendChild(st);
  const CARDS = '.overlay > .modal, .overlay > .swin, .modal > .dlg, .mdl > div, .ms-box > .c, .lsp, dialog[open]';
  const OWN = 'button.as-x, button.sd-x, button.ms-x, button.x, button[aria-label="Close"], button[aria-label="Close dialog"], button[title="Close"], #setClose, #propsClose';
  const shown = (el) => el.isConnected && el.getClientRects().length > 0;
  const hasX = (card) => Boolean(card.querySelector(OWN)) || [...card.querySelectorAll('button')].some((b) => /^[×✕x]$/i.test(b.textContent.trim()));
  function closeIt(card) {
    const back = card.parentElement, wait = (fn) => setTimeout(() => { if (shown(card)) fn(); }, 70);
    // 1. like a click outside the window
    if (back && back !== document.body) { try { back.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); back.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch {} }
    // 2. like the Esc key (a question answers Cancel)
    wait(() => { try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); } catch {} 
      // 3. the Cancel / Close / Done button, or hide it
      wait(() => { const b = [...card.querySelectorAll('button')].find((x) => /^(cancel|close|done|back|no)$/i.test(x.textContent.trim())); if (b) b.click(); else if (back) { back.hidden = true; back.classList.remove('open'); } }); });
  }
  function scan() {
    document.querySelectorAll(CARDS).forEach((card) => {
      if (card.dataset.msx || !shown(card)) return;
      card.dataset.msx = '1';
      if (hasX(card)) return;
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ms-x'; b.textContent = '×'; b.title = 'Close'; b.setAttribute('aria-label', 'Close');
      b.onclick = (e) => { e.stopPropagation(); closeIt(card); };
      card.appendChild(b);
    });
  }
  let raf = 0; const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; scan(); }); };
  new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'open'] });
  later();
})();
