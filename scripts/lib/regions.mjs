// Country groupings used by the land-mask, fetch and build scripts.
// Ids are ISO 3166-1 numeric codes as used by Natural Earth / world-atlas.

/** Ids given to Natural Earth units that have no ISO code. */
export const UNNAMED_IDS = {
  Somaliland: 901,
  Kosovo: 902,
  'N. Cyprus': 903,
  'Indian Ocean Ter.': 904,
  'Siachen Glacier': 905,
};

/** African countries and territories. */
export const AFRICA = [
  12, 24, 72, 108, 120, 132, 140, 148, 174, 175, 178, 180, 204, 226, 231, 232, 262, 266, 270, 288, 324, 384, 404, 426,
  430, 434, 450, 454, 466, 478, 480, 504, 508, 516, 562, 566, 624, 638, 646, 654, 678, 686, 690, 694, 706, 710, 716,
  728, 729, 732, 748, 768, 788, 800, 818, 834, 854, 894, 901,
];

export const REGIONS = { africa: AFRICA };
