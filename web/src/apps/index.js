// The apps the sidebar lists, in rail order. To add one: a folder with an
// index.js entry ({ id, title, icon, load }) and its code, listed here.
// README in this folder.

import { createRegistry } from './registry.js';
import starlink from './starlink/index.js';

export const APPS = [starlink];

export const createAppsRegistry = () => createRegistry(APPS);
