// Small helpers for apps' HTML (README in this folder).

/** Text for HTML: & < > " ' escaped. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 12345 -> "12,345" (as the rest of netmap writes numbers). */
export const fmt = (x) => (typeof x === 'number' && Number.isFinite(x) ? x.toLocaleString('en-US') : '—');
