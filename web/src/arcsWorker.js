// Builds the globe's link arcs off the main thread (main.js startArcs): each
// chunk goes back as soon as it's built, its arrays transferred, not copied.
import { arcChunks } from './arcs.js';

self.onmessage = ({ data: { id, ends, coarse, liftK, budget } }) =>
  arcChunks(ends, liftK, { coarse, budget }, (c) => self.postMessage({ id, ...c }, [c.startIndices.buffer, c.path.buffer]));
