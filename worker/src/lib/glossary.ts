import rawGlossary from "../data/glossary.json";

export interface GlossaryEntry {
  term: string;
  definition: string;
  source: string;
}

export type Glossary = Record<string, GlossaryEntry[]>;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// Sort each letter's entries by term once at module load. The Express
// version did this in fs.readFile, then served the sorted dict for the
// process lifetime. In Workers there's no module-load callback, so the
// sort just happens lazily on first import — same outcome, no async.
let cached: Glossary | null = null;

export function getGlossary(): Glossary {
  if (cached) return cached;
  const source = rawGlossary as Record<string, GlossaryEntry[] | undefined>;
  const out: Glossary = {};
  for (const letter of ALPHABET) {
    const records = source[letter];
    if (records?.length) {
      out[letter] = [...records].sort((a, b) => a.term.localeCompare(b.term));
    }
  }
  cached = out;
  return out;
}
