// The Starlink app's sections, in panel order, below its summary. A section
// is { id, mount(el, ctx), unmount(), onHash?(params) }: app.js gives each
// its own element and the app's ctx, and passes on the app's hash params
// (starlink.*; a section keeps to its own keys). To add one: one import, one
// entry.

import atlas from './atlas/section.js';

export const SECTIONS = [atlas];
