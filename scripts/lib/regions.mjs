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

/** ISO 3166-1 alpha-2 codes (as used by OpenStreetMap country boundaries). */
export const ISO2 = {
  12: 'DZ', 24: 'AO', 72: 'BW', 108: 'BI', 120: 'CM', 132: 'CV', 140: 'CF', 148: 'TD', 174: 'KM', 175: 'YT', 178: 'CG',
  180: 'CD', 204: 'BJ', 226: 'GQ', 231: 'ET', 232: 'ER', 262: 'DJ', 266: 'GA', 270: 'GM', 288: 'GH', 324: 'GN', 384: 'CI',
  404: 'KE', 426: 'LS', 430: 'LR', 434: 'LY', 450: 'MG', 454: 'MW', 466: 'ML', 478: 'MR', 480: 'MU', 504: 'MA', 508: 'MZ',
  516: 'NA', 562: 'NE', 566: 'NG', 624: 'GW', 638: 'RE', 646: 'RW', 654: 'SH', 678: 'ST', 686: 'SN', 690: 'SC', 694: 'SL',
  706: 'SO', 710: 'ZA', 716: 'ZW', 728: 'SS', 729: 'SD', 732: 'EH', 748: 'SZ', 768: 'TG', 788: 'TN', 800: 'UG', 818: 'EG',
  834: 'TZ', 854: 'BF', 894: 'ZM',
  // Somaliland is mapped inside Somalia's boundary in OpenStreetMap.
  901: 'SO',
};
