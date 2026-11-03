// The globe under the map, shared by the app (main.js) and the NetGL guest
// page (mapGuest.js): ocean, land and the graticule of globeScene.js.
import { GeoJsonLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { feature } from 'topojson-client';
import countries110 from 'world-atlas/countries-110m.json';
import { graticule } from './globeScene.js';

/** The globe under the map: ocean, land and the graticule. */
export function earthLayers() {
  const land = feature(countries110, countries110.objects.countries);
  return [
    new SolidPolygonLayer({
      id: 'ocean',
      data: [{ polygon: [[-180, 90], [0, 90], [180, 90], [180, -90], [0, -90], [-180, -90]] }],
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
