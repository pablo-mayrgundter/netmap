// The ATC app: the FAA's en route centers and incidents on the network that
// joins them (first: the 13 Nov 2026 ground stop). Its registry entry; the
// code loads on first open (app.js).

export const ATC_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M10 3h4v2h2l-1 5h-6L8 5h2z"/><rect x="10.5" y="10" width="3" height="9"/><rect x="7" y="19" width="10" height="2" rx=".5"/>' +
  '<path d="M4.5 4.5a8 8 0 0 0 0 7M19.5 4.5a8 8 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
  '</svg>';

export default {
  id: 'atc',
  title: 'Air traffic control',
  icon: ATC_ICON,
  load: () => import('./app.js'),
};
