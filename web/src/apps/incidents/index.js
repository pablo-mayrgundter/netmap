// The Incidents app: outages on networks, each incident a set of events that
// may share a cause, stepped through their timelines on the map. First: the
// 2026 ATC outages (Minneapolis, Philadelphia, the nationwide ground stop).
// Its registry entry; the code loads on first open (app.js).

export const INCIDENTS_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 2.5 1.8 20.5h20.4L12 2.5zm0 4.2 6.9 12H5.1L12 6.7z"/><rect x="11" y="10" width="2" height="5" rx=".6"/><circle cx="12" cy="17" r="1.1"/>' +
  '</svg>';

export default {
  id: 'incidents',
  title: 'Incidents',
  icon: INCIDENTS_ICON,
  load: () => import('./app.js'),
};
