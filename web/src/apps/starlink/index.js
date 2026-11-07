// The Starlink app (AS14593): its registry entry. The code loads on first
// open (app.js); the icon is here so the rail can show it at once.

export const STARLINK_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<g transform="rotate(-45 12 12)"><rect x="10" y="8.5" width="4" height="7" rx="1"/>' +
  '<rect x="2" y="9.5" width="7" height="5" rx=".6"/><rect x="15" y="9.5" width="7" height="5" rx=".6"/></g>' +
  '<path d="M14 21.2a7.2 7.2 0 0 0 7.2-7.2M14 18a4 4 0 0 0 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
  '</svg>';

export default {
  id: 'starlink',
  title: 'Starlink',
  icon: STARLINK_ICON,
  load: () => import('./app.js'),
};
