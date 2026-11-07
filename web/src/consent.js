// The analytics consent toast (src/analytics.js; README: Analytics): asks once
// when there's a measurement ID and the viewer hasn't chosen, and again from
// the Privacy link. Without an ID there's no toast and no link.

const README = 'https://github.com/pablo-mayrgundter/netmap#analytics';

export function mountConsent(analytics, { link = null } = {}) {
  const status = analytics.status();
  if (status === 'off') {
    if (link) link.hidden = true;
    return;
  }
  const el = document.createElement('div');
  el.id = 'consent';
  el.className = 'card';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Analytics');
  el.hidden = true;
  document.body.appendChild(el);

  const close = () => {
    el.hidden = true;
  };
  function open() {
    const s = analytics.status();
    const more = `<a href="${README}" target="_blank" rel="noopener">What's sent</a>`;
    if (s === 'blocked') {
      el.innerHTML = `<p>Your browser asks sites not to track you (Do Not Track or Global Privacy Control), so netmap sends no analytics. ${more}.</p>
        <div class="actions"><button class="btn primary" data-a="close">OK</button></div>`;
    } else {
      const now = s === 'granted' ? ' <b>Analytics are on.</b>' : s === 'denied' ? ' <b>Analytics are off.</b>' : '';
      el.innerHTML = `<p>May netmap count how it's used? Anonymous usage only (which views and tools get used), through Google Analytics; no ads, nothing you type.${now} ${more}.</p>
        <div class="actions"><button class="btn" data-a="deny">No thanks</button><button class="btn primary" data-a="grant">Allow analytics</button></div>`;
    }
    el.hidden = false;
  }
  el.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'grant') analytics.grant();
    else if (a === 'deny') analytics.deny();
    if (a) close();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(); // not a choice: it asks again next visit
    }
  });
  if (link) {
    link.hidden = false;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (el.hidden) open();
      else close();
    });
  }
  if (analytics.needsPrompt()) open();
}
