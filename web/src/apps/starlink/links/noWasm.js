// Stands in for satellite.js's WASM builds (vite.config.js aliases them
// here): netmap propagates with its JavaScript SGP4, and the WASM entry
// points would add megabytes and top-level await to the worker's bundle.
export default function noWasm() {
  throw new Error("satellite.js's WASM runtime isn't bundled in netmap");
}
