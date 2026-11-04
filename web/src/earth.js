// The globe under the map, shared by the app (main.js) and the NetGL guest
// page (mapGuest.js): ocean, land and the graticule of globeScene.js.
import { GeoJsonLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { feature } from 'topojson-client';
import countries110 from 'world-atlas/countries-110m.json';
import { graticule } from './globeScene.js';

/**
 * The ocean, as 10° cells. deck tessellates a polygon once, at the
 * resolution of the viewport current then: a globe's subdivides it, a flat
 * map's doesn't. One quad for the whole Earth, made under a flat viewport,
 * didn't draw there (mapGuest.js makes a part's layers under its own view);
 * cells hold under either.
 */
const OCEAN = [];
for (let lon = -180; lon < 180; lon += 10) {
  for (let lat = -90; lat < 90; lat += 10) {
    OCEAN.push({ polygon: [[lon, lat], [lon + 10, lat], [lon + 10, lat + 10], [lon, lat + 10]] });
  }
}

/** The globe under the map: ocean, land and the graticule. */
export function earthLayers() {
  const land = feature(countries110, countries110.objects.countries);
  return [
    new SolidPolygonLayer({
      id: 'ocean',
      data: OCEAN,
      getPolygon: (d) => d.polygon,
      getFillColor: [4, 6, 11, 255],
    }),
    new GeoJsonLayer({
      id: 'land',
      data: land,
      filled: true,
      stroked: true,
      getFillColor: [22, 28, 40, 255],
      getLineColor: [60, 72, 96, 255],
      lineWidthMinPixels: 0.5,
    }),
    new GeoJsonLayer({
      id: 'grid',
      data: graticule,
      stroked: true,
      filled: false,
      getLineColor: (f) => (f.properties.major ? [36, 50, 74, 200] : [24, 32, 50, 170]),
      lineWidthUnits: 'pixels',
      getLineWidth: (f) => (f.properties.major ? 0.9 : 0.6),
    }),
  ];
}
