// Engine contract: shared config. DOM-free. Importable in Node for headless tests.

export const RATE_CARD = {
  usdInr: 95.78,
  usdInrAsOf: '2026-09-26', // spot rate checked this date; buyer can override in settings
  gstRate: 0.18,
};

export const VENDORS = [
  { id: 'vijay-corrugators',      name: 'Vijay Corrugators',      file: 'quote-email.txt', kind: 'txt'  },
  { id: 'national-packaging',     name: 'National Packaging',     file: 'quote.docx',      kind: 'docx' },
  { id: 'shakti-packers',          name: 'Shakti Packers',         file: 'quote.xlsx',      kind: 'xlsx' },
  { id: 'sri-lakshmi-enterprises', name: 'Sri Lakshmi Enterprises', file: 'quote-photo.jpg', kind: 'jpg'  },
  { id: 'gujarat-paper-mills',     name: 'Gujarat Paper Mills',     file: 'quote.pdf',       kind: 'pdf'  },
];

export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',          // runtime paste-in only; never persisted to repo
  usdInr: RATE_CARD.usdInr,
  usdInrAsOf: RATE_CARD.usdInrAsOf,
  gstRate: RATE_CARD.gstRate,
};

// Demo subset: 16 catalog questions + the buyer-authored PSU question (Q-X1).
export const DEMO_QUESTION_COUNT = 17;
