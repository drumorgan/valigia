export const ABROAD_ITEMS = [
  // -- SOUTH AFRICA (5h 11m / 3h 37m with airstrip) --
  { itemId: 206,  name: "Xanax",          destination: "South Africa", buyPriceFallback: 750000, flightMins: 311, type: "drug"    },
  { itemId: 197,  name: "LSD",            destination: "South Africa", buyPriceFallback: 35000,  flightMins: 311, type: "drug"    },
  { itemId: null, name: "Smoke Grenade",  destination: "South Africa", buyPriceFallback: 20000,  flightMins: 311, type: "temp"    },
  { itemId: null, name: "Elephant",       destination: "South Africa", buyPriceFallback: 500,    flightMins: 311, type: "plushie" },
  { itemId: null, name: "African Violet", destination: "South Africa", buyPriceFallback: 2000,   flightMins: 311, type: "flower"  },

  // -- UAE (4h 19m / 3h 1m with airstrip) --
  { itemId: null, name: "Camel",          destination: "UAE",          buyPriceFallback: 3000,   flightMins: 259, type: "plushie" },
  { itemId: null, name: "Lion",           destination: "UAE",          buyPriceFallback: 4000,   flightMins: 259, type: "plushie" },
  { itemId: null, name: "African Violet", destination: "UAE",          buyPriceFallback: 2000,   flightMins: 259, type: "flower"  },

  // -- CHINA (3h 39m / 2h 33m with airstrip) --
  { itemId: null, name: "Panda",          destination: "China",        buyPriceFallback: 2500,   flightMins: 219, type: "plushie" },
  { itemId: null, name: "Peony",          destination: "China",        buyPriceFallback: 1000,   flightMins: 219, type: "flower"  },
  { itemId: null, name: "Ecstasy",        destination: "China",        buyPriceFallback: 45000,  flightMins: 219, type: "drug"    },

  // -- JAPAN (3h 23m / 2h 22m with airstrip) --
  { itemId: null, name: "Koi Carp",       destination: "Japan",        buyPriceFallback: 3500,   flightMins: 203, type: "plushie" },
  { itemId: null, name: "Cherry Blossom", destination: "Japan",        buyPriceFallback: 800,    flightMins: 203, type: "flower"  },
  { itemId: 206,  name: "Xanax",          destination: "Japan",        buyPriceFallback: 750000, flightMins: 203, type: "drug"    },

  // -- ARGENTINA (3h 9m / 2h 13m with airstrip) --
  { itemId: null, name: "Monkey",         destination: "Argentina",    buyPriceFallback: 400,    flightMins: 189, type: "plushie" },
  { itemId: null, name: "Ceibo Flower",   destination: "Argentina",    buyPriceFallback: 600,    flightMins: 189, type: "flower"  },
  { itemId: null, name: "Tear Gas",       destination: "Argentina",    buyPriceFallback: 15000,  flightMins: 189, type: "temp"    },

  // -- SWITZERLAND (2h 49m / 1h 58m with airstrip) --
  { itemId: null, name: "Flash Grenade",  destination: "Switzerland",  buyPriceFallback: 12000,  flightMins: 169, type: "temp"    },

  // -- UK (2h 32m / 1h 47m with airstrip) --
  { itemId: null, name: "Nessie",         destination: "UK",           buyPriceFallback: 3000,   flightMins: 152, type: "plushie" },
  { itemId: null, name: "Peony",          destination: "UK",           buyPriceFallback: 1000,   flightMins: 152, type: "flower"  },

  // -- HAWAII (2h 1m / 1h 25m with airstrip) --
  { itemId: null, name: "Orchid",         destination: "Hawaii",       buyPriceFallback: 800,    flightMins: 121, type: "flower"  },

  // -- CAYMAN ISLANDS (57m / 40m with airstrip) --
  { itemId: null, name: "Stingray",       destination: "Caymans",      buyPriceFallback: 2000,   flightMins: 57,  type: "plushie" },
  { itemId: null, name: "Orchid",         destination: "Caymans",      buyPriceFallback: 800,    flightMins: 57,  type: "flower"  },

  // -- CANADA (37m / 26m with airstrip) --
  { itemId: null, name: "Wolverine",      destination: "Canada",       buyPriceFallback: 1500,   flightMins: 37,  type: "plushie" },
  { itemId: null, name: "Trillium",       destination: "Canada",       buyPriceFallback: 600,    flightMins: 37,  type: "flower"  },

  // -- MEXICO (20m / 14m with airstrip) --
  { itemId: null, name: "Jaguar",         destination: "Mexico",       buyPriceFallback: 1200,   flightMins: 20,  type: "plushie" },
  { itemId: null, name: "Dahlia",         destination: "Mexico",       buyPriceFallback: 500,    flightMins: 20,  type: "flower"  },
];

// Lookup by lowercase name — used when parsing log entries (data.item is a name string)
export const ABROAD_ITEM_BY_NAME = Object.fromEntries(
  ABROAD_ITEMS.map(item => [item.name.toLowerCase(), item])
);
