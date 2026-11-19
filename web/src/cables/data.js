// Well-known fiber routes, submarine and overland, drawn by hand for netmap.
//
// Submarine cables follow their public landing points (the cities below), with
// waypoints at sea so a route goes round the coasts and not over them. The
// waypoints are approximate: a cable's real path on the sea floor isn't drawn
// here, only its corridor. Overland routes are the long-haul corridors the big
// carriers run along (interstates, railways, pipelines), simplified to the
// cities they join; they're named for the corridor, not for any one carrier.
//
// A landing near a metro (Wall NJ, Shirley NY) is its own station, joined to
// the metro by a short overland link, as the real backhaul is.
//
// Cities: key -> [name, lon, lat].
export const CITIES = {
  // North America
  nyc: ['New York', -74.0, 40.71],
  wall: ['Wall, NJ', -74.06, 40.15],
  shirley: ['Shirley, NY', -72.87, 40.8],
  lynn: ['Lynn, MA', -70.95, 42.47],
  bos: ['Boston', -71.06, 42.36],
  vab: ['Virginia Beach', -75.98, 36.85],
  ash: ['Ashburn', -77.49, 39.04],
  myr: ['Myrtle Beach', -78.89, 33.69],
  atl: ['Atlanta', -84.39, 33.75],
  jax: ['Jacksonville', -81.66, 30.33],
  boca: ['Boca Raton', -80.1, 26.37],
  mia: ['Miami', -80.19, 25.76],
  chi: ['Chicago', -87.63, 41.88],
  kc: ['Kansas City', -94.58, 39.1],
  msp: ['Minneapolis', -93.27, 44.98],
  dal: ['Dallas', -96.8, 32.78],
  hou: ['Houston', -95.37, 29.76],
  den: ['Denver', -104.99, 39.74],
  slc: ['Salt Lake City', -111.89, 40.76],
  phx: ['Phoenix', -112.07, 33.45],
  la: ['Los Angeles', -118.24, 34.05],
  hermosa: ['Hermosa Beach', -118.4, 33.86],
  morro: ['Morro Bay', -120.85, 35.37],
  sj: ['San Jose', -121.89, 37.34],
  eureka: ['Eureka', -124.16, 40.8],
  hil: ['Hillsboro', -122.99, 45.52],
  pcity: ['Pacific City', -123.96, 45.2],
  sea: ['Seattle', -122.33, 47.61],
  van: ['Vancouver', -123.12, 49.28],
  cal: ['Calgary', -114.07, 51.05],
  wpg: ['Winnipeg', -97.14, 49.9],
  tor: ['Toronto', -79.38, 43.65],
  mtl: ['Montreal', -73.57, 45.5],
  hfx: ['Halifax', -63.57, 44.65],
  mex: ['Mexico City', -99.13, 19.43],
  mty: ['Monterrey', -100.32, 25.69],
  hnl: ['Honolulu', -157.86, 21.31],
  // Latin America
  sju: ['San Juan', -66.11, 18.47],
  pty: ['Panama City', -79.52, 8.98],
  baq: ['Barranquilla', -74.8, 10.96],
  bog: ['Bogotá', -74.07, 4.71],
  lim: ['Lima', -77.04, -12.05],
  vap: ['Valparaíso', -71.62, -33.05],
  scl: ['Santiago', -70.67, -33.45],
  bue: ['Buenos Aires', -58.38, -34.6],
  toninas: ['Las Toninas', -56.7, -36.49],
  pde: ['Punta del Este', -54.95, -34.96],
  sao: ['São Paulo', -46.63, -23.55],
  santos: ['Santos', -46.33, -23.96],
  rio: ['Rio de Janeiro', -43.17, -22.91],
  for: ['Fortaleza', -38.54, -3.72],
  // Europe
  lon: ['London', -0.13, 51.51],
  bude: ['Bude', -4.54, 50.83],
  brean: ['Brean', -3.01, 51.29],
  dub: ['Dublin', -6.26, 53.35],
  cork: ['Cork', -8.47, 51.9],
  ams: ['Amsterdam', 4.9, 52.37],
  fra: ['Frankfurt', 8.68, 50.11],
  par: ['Paris', 2.35, 48.86],
  lannion: ['Lannion', -3.46, 48.73],
  sthilaire: ['Saint-Hilaire-de-Riez', -1.94, 46.72],
  leporge: ['Le Porge', -1.2, 44.87],
  bio: ['Bilbao', -2.93, 43.26],
  mad: ['Madrid', -3.7, 40.42],
  bcn: ['Barcelona', 2.17, 41.39],
  lis: ['Lisbon', -9.14, 38.72],
  sines: ['Sines', -8.87, 37.95],
  mrs: ['Marseille', 5.37, 43.3],
  lyon: ['Lyon', 4.84, 45.76],
  gen: ['Genoa', 8.93, 44.41],
  mil: ['Milan', 9.19, 45.46],
  zrh: ['Zurich', 8.54, 47.38],
  rome: ['Rome', 12.5, 41.9],
  pmo: ['Palermo', 13.36, 38.12],
  bari: ['Bari', 16.87, 41.13],
  muc: ['Munich', 11.58, 48.14],
  vie: ['Vienna', 16.37, 48.21],
  bud: ['Budapest', 19.04, 47.5],
  buh: ['Bucharest', 26.1, 44.43],
  sof: ['Sofia', 23.32, 42.7],
  ist: ['Istanbul', 28.98, 41.01],
  ath: ['Athens', 23.73, 37.98],
  ham: ['Hamburg', 9.99, 53.55],
  ber: ['Berlin', 13.4, 52.52],
  rostock: ['Rostock', 12.1, 54.09],
  blaabjerg: ['Blaabjerg', 8.2, 55.7],
  cph: ['Copenhagen', 12.57, 55.68],
  krs: ['Kristiansand', 8.0, 58.15],
  osl: ['Oslo', 10.75, 59.91],
  sto: ['Stockholm', 18.07, 59.33],
  hel: ['Helsinki', 24.94, 60.17],
  waw: ['Warsaw', 21.01, 52.23],
  kyiv: ['Kyiv', 30.52, 50.45],
  led: ['St Petersburg', 30.32, 59.94],
  mow: ['Moscow', 37.62, 55.76],
  // Russia and Central Asia
  yek: ['Yekaterinburg', 60.61, 56.84],
  nsk: ['Novosibirsk', 82.92, 55.03],
  irk: ['Irkutsk', 104.28, 52.29],
  khv: ['Khabarovsk', 135.07, 48.48],
  vvo: ['Vladivostok', 131.89, 43.12],
  // Middle East and Africa
  alx: ['Alexandria', 29.92, 31.2],
  cai: ['Cairo', 31.24, 30.04],
  suez: ['Suez', 32.55, 29.97],
  zaf: ['Zafarana', 32.65, 29.11],
  jed: ['Jeddah', 39.17, 21.54],
  ruh: ['Riyadh', 46.68, 24.71],
  dxb: ['Dubai', 55.27, 25.2],
  fuj: ['Fujairah', 56.33, 25.12],
  mct: ['Muscat', 58.41, 23.59],
  jib: ['Djibouti', 43.15, 11.59],
  mba: ['Mombasa', 39.67, -4.04],
  nbo: ['Nairobi', 36.82, -1.29],
  dar: ['Dar es Salaam', 39.28, -6.79],
  mpm: ['Maputo', 32.57, -25.97],
  mtz: ['Mtunzini', 31.75, -28.95],
  jnb: ['Johannesburg', 28.05, -26.2],
  cpt: ['Cape Town', 18.42, -33.92],
  lad: ['Luanda', 13.23, -8.84],
  kribi: ['Kribi', 9.91, 2.94],
  los: ['Lagos', 3.38, 6.52],
  acc: ['Accra', -0.19, 5.6],
  abj: ['Abidjan', -4.01, 5.36],
  dkr: ['Dakar', -17.45, 14.69],
  cas: ['Casablanca', -7.59, 33.57],
  // South Asia
  khi: ['Karachi', 67.01, 24.86],
  bom: ['Mumbai', 72.88, 19.08],
  del: ['Delhi', 77.21, 28.61],
  blr: ['Bangalore', 77.59, 12.97],
  maa: ['Chennai', 80.27, 13.08],
  ccu: ['Kolkata', 88.36, 22.57],
  cmb: ['Colombo', 79.86, 6.93],
  // East and Southeast Asia
  sin: ['Singapore', 103.82, 1.35],
  kul: ['Kuala Lumpur', 101.69, 3.14],
  cgk: ['Jakarta', 106.85, -6.21],
  bkk: ['Bangkok', 100.5, 13.76],
  songkhla: ['Songkhla', 100.6, 7.2],
  sgn: ['Ho Chi Minh City', 106.63, 10.82],
  vungtau: ['Vung Tau', 107.08, 10.35],
  dad: ['Da Nang', 108.2, 16.05],
  han: ['Hanoi', 105.85, 21.03],
  hkg: ['Hong Kong', 114.17, 22.32],
  can: ['Guangzhou', 113.26, 23.13],
  swa: ['Shantou', 116.68, 23.35],
  sha: ['Shanghai', 121.47, 31.23],
  tao: ['Qingdao', 120.38, 36.07],
  pek: ['Beijing', 116.4, 39.9],
  wuh: ['Wuhan', 114.31, 30.59],
  xiy: ['Xi’an', 108.94, 34.34],
  ctu: ['Chengdu', 104.07, 30.57],
  tpe: ['Taipei', 121.56, 25.03],
  mnl: ['Manila', 120.98, 14.6],
  baler: ['Baler', 121.56, 15.76],
  pus: ['Busan', 129.08, 35.18],
  sel: ['Seoul', 126.98, 37.57],
  tyo: ['Tokyo', 139.69, 35.69],
  chikura: ['Chikura', 139.95, 34.95],
  shima: ['Shima', 136.84, 34.33],
  kitaibaraki: ['Kitaibaraki', 140.75, 36.8],
  osa: ['Osaka', 135.5, 34.69],
  fuk: ['Fukuoka', 130.4, 33.59],
  gum: ['Guam', 144.79, 13.44],
  // Oceania
  syd: ['Sydney', 151.21, -33.87],
  mel: ['Melbourne', 144.96, -37.81],
  adl: ['Adelaide', 138.6, -34.93],
  per: ['Perth', 115.86, -31.95],
  bne: ['Brisbane', 153.03, -27.47],
  akl: ['Auckland', 174.76, -36.85],
  suva: ['Suva', 178.44, -18.14],
};

// Sea lanes reused by many cables: [lon, lat] waypoints, in order.
const MED_WEST = [[5.6, 42.6], [8.8, 40.6], [11.4, 37.6]]; // Marseille .. Sicily channel
const MED_EAST = [[16, 35.2], [22, 34.2], [27, 33.2]]; // .. Alexandria
const RED_SEA = [[33.6, 27.6], [35.4, 25.4], [37.6, 22.8]]; // Gulf of Suez .. off Jeddah
const RED_SOUTH = [[40.4, 18.6], [42.0, 15.2], [43.3, 12.6]]; // .. Bab-el-Mandeb
const ADEN = [[46, 12.4], [51.5, 12.8], [56, 16]]; // Gulf of Aden .. Arabian Sea
const MALACCA = [[95.5, 6.2], [98.2, 4.4], [101, 2.6]]; // north of Sumatra .. Singapore Strait
const W_AFRICA_N = [[-12, 34], [-15.5, 27], [-18.2, 21]]; // off Portugal .. off Mauritania
const W_AFRICA_GULF = [[-15, 9], [-10, 4.2]]; // Dakar .. Gulf of Guinea
const W_AFRICA_S = [[11.5, -14], [12.6, -22], [15.2, -29.5]]; // Luanda .. Namibia .. Cape
const SA_EAST = [[21, -36], [27, -34.8], [31.2, -31]]; // Cape .. KwaZulu-Natal
const MOZ = [[36, -22], [40.8, -15], [40.6, -9.5]]; // Mozambique Channel
const E_AFRICA_N = [[41, -2], [47, 3.5], [51.5, 10.5]]; // Kenya .. Horn of Africa
const ARABIAN = [[60.5, 19.5], [64, 21]]; // Oman .. Pakistan / India
const LANKA_E = [[82.5, 5.8], [88, 5.8]]; // south of Sri Lanka .. Bay of Bengal
const S_CHINA_SEA = [[105.6, 3.5], [107.5, 7.5]]; // Singapore .. Vietnam
const VN_HK = [[110, 12.5], [111.2, 17.8], [113.6, 21.2]]; // Vietnam .. Hong Kong
const LUZON = [[117.5, 21.2], [121, 20.8], [124, 23.5]]; // Hong Kong .. Luzon Strait .. Okinawa
const PACIFIC_N = [[150, 38.5], [170, 44], [-170, 45], [-150, 45]]; // Japan .. north Pacific
const ATL_N = [[-60, 41.5], [-40, 45], [-20, 48.5]]; // New York .. Western Approaches

/**
 * Each cable: { name, kind: 'sub' | 'land', year (ready for service), path }.
 * `path` is a list of city keys and [lon, lat] waypoints; `paths` gives a
 * cable with branches, one list per branch. A city key is a station: cables
 * that share one meet there.
 */
export const CABLES = [
  // --- North Atlantic ---------------------------------------------------
  { name: 'MAREA', kind: 'sub', year: 2018, path: ['vab', [-68, 37.5], [-45, 40.5], [-20, 43.5], [-5, 44.2], 'bio'] },
  { name: 'Dunant', kind: 'sub', year: 2021, path: ['vab', [-66, 38.5], [-40, 43.5], [-15, 46.5], 'sthilaire'] },
  { name: 'Grace Hopper', kind: 'sub', year: 2022, paths: [['shirley', ...ATL_N, [-8, 50.2], 'bude'], [[-20, 48.5], [-10, 45], [-4, 44.1], 'bio']] },
  { name: 'Amitié', kind: 'sub', year: 2023, paths: [['lynn', [-58, 42.5], [-35, 46.5], [-12, 46.6], [-2.2, 45.3], 'leporge'], [[-12, 46.6], [-7.5, 49.6], 'bude']] },
  { name: 'AC-2 (Yellow)', kind: 'sub', year: 2000, path: ['shirley', [-60, 41.8], [-40, 46], [-20, 49.5], [-7.5, 50.4], 'bude'] },
  { name: 'Apollo', kind: 'sub', year: 2003, paths: [['shirley', [-58, 42.2], [-35, 47.5], [-15, 50], 'bude'], ['wall', [-60, 39.8], [-35, 45], [-12, 48.2], [-5, 48.9], 'lannion']] },
  { name: 'Havfrue / AEC-2', kind: 'sub', year: 2020, paths: [['wall', [-55, 44], [-30, 54], [-12, 58.6], [-2, 59.2], [5, 57.6], 'blaabjerg'], [[-12, 58.6], [-11, 53.5], 'cork'], [[5, 57.6], 'krs']] },
  { name: 'Hibernia Express', kind: 'sub', year: 2015, path: ['hfx', [-45, 48], [-20, 51], 'cork', [-6.5, 51.2], 'brean'] },
  { name: 'Celtic Norse / Irish Sea', kind: 'sub', year: 2001, path: ['dub', [-5.2, 53.3], [-4.2, 53.4], 'lon'] },
  { name: 'C-Lion1', kind: 'sub', year: 2016, path: ['hel', [22.5, 59.6], [19.5, 57.5], [15, 55.2], 'rostock'] },

  // --- South Atlantic and the Americas ------------------------------------
  { name: 'EllaLink', kind: 'sub', year: 2021, path: ['for', [-32, 0], [-25, 15], [-17, 30], [-10.5, 36.8], 'sines'] },
  { name: 'SACS', kind: 'sub', year: 2018, path: ['for', [-25, -6], [0, -8], 'lad'] },
  { name: 'SAIL', kind: 'sub', year: 2018, path: ['for', [-25, -3], [0, 0.5], 'kribi'] },
  { name: 'Monet', kind: 'sub', year: 2017, path: ['boca', [-72, 24], [-55, 12], [-38, -1], 'for', [-34.5, -8], [-38, -19], [-44.5, -25], 'santos'] },
  { name: 'Seabras-1', kind: 'sub', year: 2017, path: ['wall', [-65, 30], [-45, 8], [-32, -6], [-37, -20], [-44.8, -25.2], 'santos'] },
  { name: 'BRUSA', kind: 'sub', year: 2018, path: ['vab', [-70, 28], 'sju', [-50, 12], [-36.5, -2], 'for', [-34.4, -10], [-39, -21], 'rio'] },
  { name: 'GlobeNet', kind: 'sub', year: 2001, paths: [['boca', [-73, 22], 'sju', [-55, 12], [-37, -1.5], 'for', [-34.3, -9], [-39.5, -21.8], 'rio'], ['sju', [-72, 13], 'baq']] },
  { name: 'SAm-1', kind: 'sub', year: 2001, paths: [['boca', [-74, 21], 'sju', [-52, 11], [-37, -2.5], 'for', [-34.6, -9], [-39.8, -22.2], 'rio', [-44, -24.6], 'santos', [-50, -32], [-55, -36.6], 'toninas'], ['vap', [-73.5, -25], [-79.5, -14], 'lim', [-82.5, -2], [-80, 6.5], 'pty']] },
  { name: 'Firmina', kind: 'sub', year: 2024, paths: [['myr', [-70, 25], [-45, 5], [-30, -10], [-40, -26], [-48, -30], [-53.5, -34.6], 'pde', [-55.8, -36.2], 'toninas'], [[-40, -26], [-45, -25.3], 'santos']] },
  { name: 'Curie', kind: 'sub', year: 2019, path: ['hermosa', [-112, 20], [-95, 9], [-81, 6.5], 'pty', [-82, 0], [-81, -15], [-74.5, -30], 'vap'] },

  // --- Pacific ----------------------------------------------------------
  { name: 'Unity', kind: 'sub', year: 2010, path: ['chikura', [150, 34], [180, 34.5], [-150, 34], [-125, 33.2], 'hermosa'] },
  { name: 'FASTER', kind: 'sub', year: 2016, paths: [['chikura', ...PACIFIC_N, [-128, 45.3], 'pcity'], ['shima', [138, 33], [148, 36.5], [150, 38.5]]] },
  { name: 'New Cross Pacific', kind: 'sub', year: 2018, paths: [['sha', [124.5, 30.6], [128.5, 32.8], 'pus', [131.5, 33], [134.5, 32.6], [139, 34.2], 'chikura', [152, 37], [172, 42.5], [-168, 44], [-148, 44.3], [-128, 45], 'pcity'], ['tpe', [122.8, 26.5], [126, 30], [128.5, 32.8]]] },
  { name: 'Trans-Pacific Express', kind: 'sub', year: 2008, paths: [['tao', [122.5, 35.4], [124.5, 33.6], [128.5, 33.6], 'pus'], ['sha', [123.8, 30.4], [124.5, 33.6]], ['pus', [130.5, 33.4], [135, 32.4], [140.5, 34.5], [142, 36.4], 'kitaibaraki', [155, 40.5], [175, 45.5], [-165, 46.4], [-145, 46.2], [-128, 45.4], 'pcity']] },
  { name: 'JUPITER', kind: 'sub', year: 2020, paths: [['shima', [138.5, 33.4], [150, 33.5], [180, 33], [-150, 32.5], [-125, 33], 'hermosa'], [[150, 33.5], [135, 22], [124.5, 17.5], 'baler']] },
  { name: 'PLCN', kind: 'sub', year: 2022, paths: [['hermosa', [-125, 31.5], [-150, 28], [180, 25], [150, 22], [130, 20.5], [124, 20.2], [122.6, 22.2], 'tpe'], [[124, 20.2], [123, 17.5], 'baler']] },
  { name: 'Topaz', kind: 'sub', year: 2023, path: ['van', [-127, 49], [-145, 50.5], [-170, 49], [165, 43], [146, 37.5], 'kitaibaraki'] },
  { name: 'Southern Cross', kind: 'sub', year: 2000, path: ['syd', [158, -35.5], [170, -36], 'akl', [176.5, -30], 'suva', [-175, -8], [-162, 13], 'hnl', [-140, 28], [-125, 34.6], 'morro'] },
  { name: 'Hawaiki', kind: 'sub', year: 2018, path: ['syd', [160, -33], [170, -33.5], 'akl', [180, -30], [-170, -10], [-160, 14], 'hnl', [-140, 34], [-128, 44.2], 'pcity'] },
  { name: 'Asia-America Gateway', kind: 'sub', year: 2009, path: ['kul', [102, 2.8], 'sin', ...S_CHINA_SEA, 'vungtau', ...VN_HK, 'hkg', [117.5, 18], [119.8, 14.4], 'mnl', [124.5, 12.5], [135, 13], 'gum', [180, 18], 'hnl', [-140, 28], [-125, 35], 'morro'] },
  { name: 'Japan-Guam-Australia', kind: 'sub', year: 2020, path: ['syd', [156, -28], [158, -10], [150, 5], 'gum', [143, 25], [141, 32.5], 'chikura'] },
  { name: 'Bifrost', kind: 'sub', year: 2024, path: ['sin', [107, 1.5], [118, 0.5], [128, 3.5], [138, 10], 'gum', [180, 25], [-150, 31], [-125, 34.5], 'morro'] },
  { name: 'Echo', kind: 'sub', year: 2024, path: ['sin', [107.5, 2], [119, 1.4], [129, 4.5], [139, 11.5], 'gum', [180, 30], [-150, 37], [-127, 40.6], 'eureka'] },

  // --- Asia ---------------------------------------------------------------
  { name: 'Asia Pacific Gateway', kind: 'sub', year: 2016, paths: [['sin', [104.6, 2.2], [102.6, 5], 'songkhla'], ['sin', ...S_CHINA_SEA, [109.4, 12.5], [109.8, 15.5], 'dad', [111.5, 17.5], [113.6, 21.3], 'hkg', ...LUZON, [127, 28.5], [124.6, 30.8], 'sha', [124.5, 32], [128.5, 33.6], 'pus', [131.5, 33.2], [136, 33.2], 'shima', [139, 34.3], 'chikura'], [[121, 20.8], [122.4, 23.5], 'tpe']] },
  { name: 'SJC', kind: 'sub', year: 2013, paths: [['sin', [106, 4], [110.5, 9.5], [114.5, 15], [117.6, 20.4], 'hkg'], [[117.6, 20.4], [117.4, 22.7], 'swa'], [[117.6, 20.4], [120.2, 21], [124.5, 24], [133, 30], [138.5, 33.8], 'chikura']] },
  { name: 'Indigo', kind: 'sub', year: 2019, paths: [['sin', [105.5, 0], [106.6, -4.5], 'cgk', [105.6, -7], [110, -12.5], [113, -24], [114.8, -31.8], 'per', [114.6, -35.5], [125, -35.8], [136, -36.2], [143, -39.6], [150.8, -38.2], [151.6, -35], 'syd']] },
  { name: 'Australia-Singapore', kind: 'sub', year: 2018, path: ['per', [113.5, -30], [110, -14], [105.8, -7.2], 'cgk', [106.3, -3.8], [105, 0.5], 'sin'] },
  { name: 'i2i', kind: 'sub', year: 2002, path: ['maa', [83, 12], [90, 8.5], ...MALACCA, 'sin'] },
  { name: 'Bharat-Lanka', kind: 'sub', year: 2006, path: ['maa', [80.8, 11], [80.3, 8.5], 'cmb'] },
  { name: 'Korea-Japan', kind: 'sub', year: 2002, path: ['pus', [129.6, 34.4], 'fuk'] },

  // --- Europe to Asia via Egypt, and round Africa -------------------------
  { name: 'SEA-ME-WE 5', kind: 'sub', year: 2016, paths: [['mrs', [5.8, 42.4], [9.5, 40.4], [12.6, 38.6], 'pmo', [14, 37.2], ...MED_EAST, 'alx'], ['zaf', ...RED_SEA, 'jed', ...RED_SOUTH, 'jib', ...ADEN, ...ARABIAN, 'khi', [66, 20], [70, 12], [76, 5.8], 'cmb', ...LANKA_E, ...MALACCA, 'sin']] },
  { name: 'SEA-ME-WE 6', kind: 'sub', year: 2025, paths: [['mrs', ...MED_WEST, ...MED_EAST, 'alx'], ['zaf', ...RED_SEA, ...RED_SOUTH, 'jib', ...ADEN, [62, 16.5], [69, 17], 'bom', [72, 13], [76.4, 6.4], 'cmb', [81.6, 9.5], 'maa', [86, 10], [92, 7], ...MALACCA, 'sin']] },
  { name: 'AAE-1', kind: 'sub', year: 2017, paths: [['mrs', ...MED_WEST, [15, 35.6], [21, 33.8], [27.2, 32.6], 'alx'], ['zaf', ...RED_SEA, 'jed', ...RED_SOUTH, 'jib', ...ADEN, 'mct', ...ARABIAN, 'khi', [68, 21], 'bom', [72.5, 12], [77, 5.5], ...LANKA_E, [94, 6], [97, 7.2], 'songkhla', [102.6, 4.5], [104.5, 2], 'sin', ...S_CHINA_SEA, 'vungtau', ...VN_HK, 'hkg']] },
  { name: 'PEACE', kind: 'sub', year: 2022, paths: [['mrs', [6, 42.2], [9.8, 39.8], [12.8, 37], [16, 34.8], [22, 33.6], [27, 32.7], 'alx'], ['zaf', ...RED_SEA, ...RED_SOUTH, 'jib', [46, 12], [52, 13.5], [58, 18], [62.5, 21.5], 'khi'], ['jib', [48, 9], [46, 2], [42, -2.5], 'mba']] },
  { name: '2Africa', kind: 'sub', year: 2024, paths: [
    ['gen', [8.5, 43.6], [6.8, 42.9], 'mrs', [4.2, 42.5], [2.8, 41.2], 'bcn', [1, 40], [-0.5, 38], [-2.5, 36.4], [-5.6, 35.95], [-7.5, 36.4], [-9.6, 37.5], [-9.6, 38.6], 'lis', ...W_AFRICA_N, 'dkr', ...W_AFRICA_GULF, 'abj', 'acc', 'los', [5, 3], [8.2, 1.8], [10.2, -4], [12.2, -7.5], 'lad', ...W_AFRICA_S, 'cpt', ...SA_EAST, 'mtz', [33.6, -27.5], 'mpm', ...MOZ, 'dar', [40.5, -5.2], 'mba', ...E_AFRICA_N, [49, 11.6], 'jib', ...RED_SOUTH.slice().reverse(), [38.6, 21], 'jed', [36.6, 25], [34.4, 27.2], 'zaf'],
    ['alx', [27, 33.4], [20, 35.6], [16.5, 39.2], 'bari'],
    ['bude', [-8, 48], [-11, 42], [-10.2, 39], 'lis'],
    ['jib', [48, 13], [55, 15.5], [59.6, 21], 'mct', [62, 21], [68.5, 19.5], 'bom'],
  ] },
  { name: 'Equiano', kind: 'sub', year: 2022, path: ['lis', [-12, 34], [-20, 22], [-20, 8], [-6, 1.5], [2, 3.2], 'los', [6, -2], [9, -12], [11.6, -22], [14.6, -30], 'cpt'] },
  { name: 'WACS', kind: 'sub', year: 2012, path: ['cpt', [15.8, -30], [12.8, -21], [12, -14], 'lad', [10.5, -5], [7.6, 1.6], 'los', 'acc', 'abj', [-11, 3.4], [-17, 10], [-19.5, 21], [-16, 30], [-12, 38], [-10.2, 46], [-6.4, 49.6], 'bude'] },
  { name: 'SAT-3 / WASC', kind: 'sub', year: 2002, path: ['lis', [-11, 35], [-16, 28], [-18.4, 21.4], 'dkr', [-16, 8.6], [-9, 4], 'abj', 'acc', 'los', [5.5, 2.4], [9, -2], [11.8, -6.8], 'lad', [11.8, -16], [13.4, -24], [15.8, -30.6], 'cpt'] },
  { name: 'EASSy', kind: 'sub', year: 2010, path: ['mtz', [33.4, -27.2], 'mpm', [36.4, -21.5], [41.2, -14.8], [40.4, -9.2], 'dar', [40.2, -5.6], 'mba', [42, -1.2], [47.6, 4.2], [51, 10.8], [46.5, 12.2], 'jib'] },
  { name: 'SEACOM', kind: 'sub', year: 2009, paths: [['mtz', [33.2, -27], 'mpm', [35.8, -22.4], [40.4, -15.4], [40, -9.8], 'dar', [40, -6], 'mba', [42.6, -1.6], [48.4, 4.8], [51.8, 11.2], [47, 12.2], 'jib', [43.1, 13.1], [41.2, 16.4], [39.4, 19.8], [36.8, 24], [34.2, 27.4], 'zaf'], ['mba', [48, -2], [58, 6], [66, 14], [70.8, 18.2], 'bom']] },

  // --- Overland: North America --------------------------------------------
  { name: 'I-95 corridor', kind: 'land', path: ['mia', 'boca', 'jax', 'atl', 'ash', 'nyc', 'bos'] },
  { name: 'I-80 transcontinental', kind: 'land', path: ['nyc', 'chi', 'den', 'slc', 'sj'] },
  { name: 'I-90 / northern tier', kind: 'land', path: ['chi', 'msp', 'sea'] },
  { name: 'I-10 southern route', kind: 'land', path: ['jax', 'hou', 'phx', 'la'] },
  { name: 'Mid-continent', kind: 'land', path: ['chi', 'kc', 'dal', 'hou'] },
  { name: 'I-20 / I-40', kind: 'land', path: ['atl', 'dal', 'phx'] },
  { name: 'Ashburn-Chicago', kind: 'land', path: ['ash', 'chi'] },
  { name: 'Chicago-Atlanta', kind: 'land', path: ['chi', 'atl'] },
  { name: 'Denver-Kansas City', kind: 'land', path: ['den', 'kc'] },
  { name: 'West coast (I-5)', kind: 'land', path: ['van', 'sea', 'hil', 'sj', 'la'] },
  { name: 'California coast', kind: 'land', path: ['eureka', 'sj', 'morro', 'la', 'hermosa'] },
  { name: 'Canada transcontinental', kind: 'land', path: ['hfx', 'mtl', 'tor', 'wpg', 'cal', 'van'] },
  { name: 'Toronto-Chicago', kind: 'land', path: ['tor', 'chi'] },
  { name: 'Montreal-New York', kind: 'land', path: ['mtl', 'nyc'] },
  { name: 'Texas-Mexico', kind: 'land', path: ['dal', 'mty', 'mex'] },
  { name: 'Landing backhaul (US)', kind: 'land', paths: [['wall', 'nyc'], ['shirley', 'nyc'], ['lynn', 'bos'], ['vab', 'ash'], ['myr', 'atl'], ['pcity', 'hil']] },

  // --- Overland: Latin America ----------------------------------------------
  { name: 'Brazil coastal', kind: 'land', path: ['for', 'rio', 'sao', 'santos'] },
  { name: 'Southern Cone', kind: 'land', path: ['sao', 'bue', 'toninas'] },
  { name: 'Trans-Andean', kind: 'land', path: ['bue', 'scl', 'vap'] },
  { name: 'Colombia', kind: 'land', path: ['baq', 'bog'] },
  { name: 'Uruguay-Argentina', kind: 'land', path: ['pde', 'bue'] },

  // --- Overland: Europe -----------------------------------------------------
  { name: 'UK backhaul', kind: 'land', paths: [['bude', 'lon'], ['brean', 'lon'], ['cork', 'dub']] },
  { name: 'London-Paris (Channel)', kind: 'land', path: ['lon', 'par'] },
  { name: 'London-Amsterdam', kind: 'land', path: ['lon', 'ams'] },
  { name: 'FLAP ring', kind: 'land', path: ['par', 'fra', 'ams'] },
  { name: 'Rhône corridor', kind: 'land', path: ['par', 'lyon', 'mrs'] },
  { name: 'French Atlantic backhaul', kind: 'land', paths: [['lannion', 'par'], ['sthilaire', 'par'], ['leporge', 'par']] },
  { name: 'Iberia', kind: 'land', path: ['mrs', 'bcn', 'mad', 'lis', 'sines'] },
  { name: 'Madrid-Bilbao', kind: 'land', path: ['mad', 'bio'] },
  { name: 'Alpine route', kind: 'land', path: ['fra', 'zrh', 'mil', 'gen'] },
  { name: 'Italy spine', kind: 'land', path: ['mil', 'rome', 'pmo'] },
  { name: 'Rome-Bari', kind: 'land', path: ['rome', 'bari'] },
  { name: 'Danube route', kind: 'land', path: ['fra', 'muc', 'vie', 'bud', 'buh', 'sof', 'ist'] },
  { name: 'Sofia-Athens', kind: 'land', path: ['sof', 'ath'] },
  { name: 'Nordic', kind: 'land', path: ['ams', 'ham', 'cph', 'sto', 'hel'] },
  { name: 'Danish and Norwegian backhaul', kind: 'land', paths: [['blaabjerg', 'cph'], ['krs', 'osl'], ['cph', 'osl']] },
  { name: 'Berlin-Moscow', kind: 'land', path: ['ham', 'ber', 'waw', 'mow'] },
  { name: 'Rostock-Berlin', kind: 'land', path: ['rostock', 'ber'] },
  { name: 'Frankfurt-Berlin', kind: 'land', path: ['fra', 'ber'] },
  { name: 'Warsaw-Kyiv', kind: 'land', path: ['waw', 'kyiv'] },
  { name: 'Baltic north', kind: 'land', path: ['hel', 'led', 'mow'] },

  // --- Overland: Russia and Asia ---------------------------------------------
  { name: 'Trans-Siberian', kind: 'land', path: ['mow', 'yek', 'nsk', 'irk', 'khv', 'vvo'] },
  { name: 'Trans-Eurasian (Mongolia)', kind: 'land', path: ['irk', 'pek'] },
  { name: 'China east coast', kind: 'land', path: ['pek', 'tao', 'sha', 'swa', 'can', 'hkg'] },
  { name: 'Beijing-Guangzhou', kind: 'land', path: ['pek', 'wuh', 'can'] },
  { name: 'Yangtze', kind: 'land', path: ['sha', 'wuh', 'ctu'] },
  { name: 'Beijing-Chengdu', kind: 'land', path: ['pek', 'xiy', 'ctu'] },
  { name: 'China-Vietnam', kind: 'land', path: ['can', 'han', 'dad', 'sgn', 'vungtau'] },
  { name: 'Indochina', kind: 'land', path: ['sgn', 'bkk', 'songkhla', 'kul', 'sin'] },
  { name: 'Japan backbone', kind: 'land', path: ['kitaibaraki', 'tyo', 'osa', 'fuk'] },
  { name: 'Japan landings', kind: 'land', paths: [['chikura', 'tyo'], ['shima', 'osa']] },
  { name: 'Korea backbone', kind: 'land', path: ['sel', 'pus'] },
  { name: 'Philippines', kind: 'land', path: ['mnl', 'baler'] },
  { name: 'India backbone', kind: 'land', paths: [['bom', 'del', 'ccu'], ['bom', 'blr', 'maa'], ['del', 'maa']] },

  // --- Overland: Middle East, Africa, Oceania ----------------------------------
  { name: 'Egypt crossing', kind: 'land', path: ['alx', 'cai', 'suez', 'zaf'] },
  { name: 'Arabian backbone', kind: 'land', path: ['jed', 'ruh', 'dxb', 'fuj', 'mct'] },
  { name: 'East Africa', kind: 'land', path: ['mba', 'nbo'] },
  { name: 'Southern Africa', kind: 'land', paths: [['cpt', 'jnb', 'mtz'], ['jnb', 'mpm']] },
  { name: 'West African coast', kind: 'land', path: ['abj', 'acc', 'los'] },
  { name: 'Morocco', kind: 'land', path: ['cas', 'mad'] },
  { name: 'Australia east-west', kind: 'land', path: ['bne', 'syd', 'mel', 'adl', 'per'] },
];
