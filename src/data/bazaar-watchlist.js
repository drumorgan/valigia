// Curated list of high-value items worth scanning for bazaar deals.
// Names must match exact Torn API item names — resolved to IDs at runtime
// via the cached item catalog (valigia_item_id_map in localStorage).
// Items that don't resolve are silently skipped.

export const BAZAAR_WATCHLIST = [
  // ── Drugs (high value, always in demand) ──
  'Xanax',
  'Cannabis',
  'Ecstasy',
  'Ketamine',
  'LSD',
  'Opium',
  'PCP',
  'Shrooms',
  'Speed',
  'Vicodin',

  // ── Temporary (combat items) ──
  'Smoke Grenade',
  'Tear Gas',
  'Flash Grenade',
  'Pepper Spray',
  'Claymore Mine',
  'Throwing Star',

  // ── Medical ──
  'Blood Bag',
  'Morphine',
  'First Aid Kit',
  'Small First Aid Kit',

  // ── Boosters & Energy ──
  'Feathery Hotel Coupon',
  'Erotic DVD',
  'Can of Munster',
  'Can of Red Cow',
  'Bottle of Beer',

  // ── Artifacts (museum sets) ──
  'Patagonian Fossil',
  'Meteorite Fragment',
  'Chert Point',
  'Quartzite Point',
  'Basalt Point',
  'Obsidian Point',
  'Quartz Point',
  'Chalcedony Point',
];
