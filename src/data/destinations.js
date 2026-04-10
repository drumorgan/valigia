// Static destination metadata — flight times are game constants.
// Item lists are now auto-discovered from player purchase logs.

export const DESTINATIONS = {
  'South Africa':     { flightMins: 311 },
  'UAE':              { flightMins: 259 },
  'China':            { flightMins: 219 },
  'Japan':            { flightMins: 203 },
  'Argentina':        { flightMins: 189 },
  'Switzerland':      { flightMins: 169 },
  'United Kingdom':   { flightMins: 152 },
  'UK':               { flightMins: 152 },
  'Hawaii':           { flightMins: 121 },
  'Cayman Islands':   { flightMins: 57 },
  'Canada':           { flightMins: 37 },
  'Mexico':           { flightMins: 20 },
};

/**
 * Get one-way flight time in minutes for a destination.
 * Falls back to 0 if unknown (shouldn't happen for valid Torn destinations).
 */
export function getFlightMins(destination) {
  return DESTINATIONS[destination]?.flightMins || 0;
}
