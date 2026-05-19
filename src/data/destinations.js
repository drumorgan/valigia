// Static destination metadata — flight times are game constants.
// Item lists are now auto-discovered from player purchase logs.
//
// `flag` + `code` drive the compact display in the table's Dest column.
// Hawaii has no country-flag emoji (it's a US state, not a nation) so we
// use the island emoji as a visually distinct substitute. Code is a
// 3-letter mnemonic — not strict ISO in every case but consistent enough
// for seasoned Torn players to recognize at a glance.

// Canonical list of Torn travel destinations, shortest flight first.
// The live data pipeline (YATA fetcher, PDA scraper, abroad-items.js)
// emits the short forms 'UK' and 'Caymans', so those are canonical here
// too. DESTINATIONS still carries the long forms as lookup aliases so
// parsing code can match whatever a legacy row or external feed happens
// to spell. Anything that surfaces destinations to the UI should run
// names through normalizeDestination() first so duplicates collapse.
export const CANONICAL_DESTINATIONS = [
  'Mexico',
  'Canada',
  'Caymans',
  'Hawaii',
  'UK',
  'Switzerland',
  'Argentina',
  'Japan',
  'China',
  'UAE',
  'South Africa',
];

export const DESTINATIONS = {
  'South Africa':     { flightMins: 311, flag: '🇿🇦', code: 'ZAF' },
  'UAE':              { flightMins: 259, flag: '🇦🇪', code: 'UAE' },
  'China':            { flightMins: 219, flag: '🇨🇳', code: 'CHN' },
  'Japan':            { flightMins: 203, flag: '🇯🇵', code: 'JPN' },
  'Argentina':        { flightMins: 189, flag: '🇦🇷', code: 'ARG' },
  'Switzerland':      { flightMins: 169, flag: '🇨🇭', code: 'SWI' },
  'UK':               { flightMins: 152, flag: '🇬🇧', code: 'UK'  },
  'United Kingdom':   { flightMins: 152, flag: '🇬🇧', code: 'UK'  },
  'Hawaii':           { flightMins: 121, flag: '🏝️', code: 'HAW' },
  'Caymans':          { flightMins: 57,  flag: '🇰🇾', code: 'CAY' },
  'Cayman Islands':   { flightMins: 57,  flag: '🇰🇾', code: 'CAY' },
  'Canada':           { flightMins: 37,  flag: '🇨🇦', code: 'CAN' },
  'Mexico':           { flightMins: 20,  flag: '🇲🇽', code: 'MEX' },
};

// Long-form → canonical short-form. Anything not in the map is returned
// unchanged so unknown destinations still surface (just not deduped).
const DESTINATION_ALIASES = {
  'United Kingdom': 'UK',
  'Cayman Islands': 'Caymans',
};

/**
 * Fold long-form destination names ('United Kingdom', 'Cayman Islands')
 * into the canonical short forms the rest of the app uses. Pass-through
 * for already-canonical names and for anything we don't recognise.
 */
export function normalizeDestination(destination) {
  if (typeof destination !== 'string') return destination;
  return DESTINATION_ALIASES[destination] || destination;
}

/**
 * Get one-way flight time in minutes for a destination.
 * Falls back to 0 if unknown (shouldn't happen for valid Torn destinations).
 */
export function getFlightMins(destination) {
  return DESTINATIONS[destination]?.flightMins || 0;
}

/**
 * Get the compact display pieces for a destination: flag emoji + 3-letter
 * code. Returns empty strings for unknown destinations so the caller can
 * still render the raw name as a graceful fallback.
 */
export function getDestinationBadge(destination) {
  const d = DESTINATIONS[destination];
  if (!d) return { flag: '', code: '' };
  return { flag: d.flag || '', code: d.code || '' };
}
