import { normalizeText } from './util.js';

export const NO_MOOD_COLOR = '#6b7280';

export const MOODS = {
  happy: { label: 'Happy', color: '#d97706' },
  energetic: { label: 'Energetic', color: '#e11d48' },
  calm: { label: 'Calm', color: '#0284c7' },
  sad: { label: 'Sad', color: '#6366f1' },
  focused: { label: 'Focused', color: '#059669' },
  romantic: { label: 'Romantic', color: '#db2777' },
  nostalgic: { label: 'Nostalgic', color: '#7c3aed' },
  aggressive: { label: 'Intense', color: '#ea580c' },
  dreamy: { label: 'Dreamy', color: '#0d9488' },
};

const RULES = [
  { re: /happy|cheerful|upbeat|feel good|feel-good|sunny|joy|fun|party|disco|funk|pop/i, weights: { happy: 3, energetic: 0.5 } },
  { re: /energetic|high energy|workout|dance|electronic|edm|house|techno|trance|dnb|drum and bass|fast/i, weights: { energetic: 3, happy: 0.5 } },
  { re: /calm|chill|relax|ambient|mellow|downtempo|acoustic|soft|easy listening|bossa|jazz|classical|lo fi|lofi|slow/i, weights: { calm: 3, focused: 1 } },
  { re: /sad|melanchol|heartbreak|blues|depress|lonely|grief|tear|slow/i, weights: { sad: 3, calm: 0.5 } },
  { re: /focus|study|instrumental|soundtrack|score|minimal|post rock|classical|jazz/i, weights: { focused: 3, calm: 1 } },
  { re: /romantic|love|soul|r n b|rnb|ballad|serenade/i, weights: { romantic: 3, sad: 0.5 } },
  { re: /nostalg|retro|80s|90s|00s|oldies|classic|vintage|throwback/i, weights: { nostalgic: 3 } },
  { re: /aggressive|angry|metal|punk|hardcore|rage|intense|heavy|screamo|grunge/i, weights: { aggressive: 3, energetic: 1 } },
  { re: /dream|shoegaze|psychedelic|ethereal|surreal|dream pop|trip hop|space|cosmic/i, weights: { dreamy: 3, calm: 1 } },
  { re: /rock|alternative|indie|garage|britpop/i, weights: { energetic: 1.5, aggressive: 0.5 } },
  { re: /hip hop|hiphop|rap|trap|grime/i, weights: { energetic: 1, focused: 0.5 } },
  { re: /country|folk|singer songwriter/i, weights: { nostalgic: 1, calm: 1 } },
  { re: /gospel|christmas|holiday/i, weights: { happy: 1.5, nostalgic: 1 } },
];

// Local metadata is noisier than curated tags, so match whole words there.
const WORD_RULES = RULES.map((rule) => ({
  ...rule,
  re: new RegExp(`(?:^|\\s)(?:${rule.re.source})(?=\\s|$)`, rule.re.flags),
}));

/** Convert tags into a normalized mood score map. */
export function scoreMood(tags = [], { wordBoundaries = false } = {}) {
  const rules = wordBoundaries ? WORD_RULES : RULES;
  const scores = Object.fromEntries(Object.keys(MOODS).map((mood) => [mood, 0]));
  for (const tag of tags) {
    const name = normalizeText(tag?.name);
    if (!name) continue;
    const weight = Number(tag.weight) || 1;
    const scale = 1 + Math.log2(1 + Math.max(0, weight)) * 0.3;
    for (const rule of rules) {
      if (!rule.re.test(name)) continue;
      for (const [mood, value] of Object.entries(rule.weights)) {
        scores[mood] += value * scale;
      }
    }
  }
  const max = Math.max(0, ...Object.values(scores));
  const ranked = Object.entries(scores)
    .map(([mood, value]) => [mood, max > 0 ? value / max : 0])
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);

  const mood = ranked[0] && ranked[0][1] >= 0.2 ? ranked[0][0] : null;
  return { mood, scores: Object.fromEntries(ranked) };
}

export function moodLabel(mood) {
  return MOODS[mood]?.label ?? (mood ? String(mood) : 'Unknown');
}

export function moodColor(mood) {
  return MOODS[mood]?.color ?? NO_MOOD_COLOR;
}

// Ordinary words such as "fast" or "sad" are too ambiguous to infer a mood
// from a title. Local inference only trusts genre-like words and known phrases.
const RELIABLE_LOCAL_WORDS = new Set([
  'calm', 'chill', 'relax', 'ambient', 'mellow', 'downtempo', 'acoustic',
  'bossa', 'jazz', 'classical', 'lofi', 'lo', 'fi',
  'melancholy', 'melancholic', 'heartbreak', 'blues', 'lonely', 'grief',
  'study', 'instrumental', 'soundtrack', 'minimal',
  'romantic', 'ballad', 'serenade', 'soul',
  'retro', 'oldies', 'vintage', 'throwback', 'nostalgic', '80s', '90s', '00s',
  'energetic', 'workout', 'dance', 'electronic', 'edm', 'house', 'techno',
  'trance', 'dnb', 'cheerful', 'upbeat', 'sunny', 'joyful', 'party', 'disco',
  'funk', 'pop', 'aggressive', 'metal', 'punk', 'hardcore', 'screamo',
  'grunge', 'rage', 'shoegaze', 'psychedelic', 'ethereal', 'surreal',
  'cosmic', 'dreamy', 'alternative', 'indie', 'britpop', 'hiphop', 'rap',
  'trap', 'grime', 'folk', 'gospel', 'christmas', 'holiday',
]);

const LOCAL_PHRASES = [
  'feel good', 'high energy', 'drum and bass', 'easy listening', 'lo fi',
  'post rock', 'dream pop', 'trip hop', 'singer songwriter', 'hip hop',
  'r n b', 'classic rock', 'psychedelic rock', 'progressive rock',
  'art rock', 'alternative rock', 'indie rock',
];

/** Build pseudo-tags from metadata so offline mood inference reuses the rules. */
export function localMoodTags(track = {}) {
  const tags = [];
  for (const field of ['title', 'artist', 'album']) {
    const text = normalizeText(track[field]);
    if (!text) continue;
    for (const phrase of LOCAL_PHRASES) {
      if (text.includes(phrase)) tags.push({ name: phrase, weight: 2 });
    }
    for (const word of text.split(' ')) {
      if (RELIABLE_LOCAL_WORDS.has(word)) tags.push({ name: word, weight: 1 });
    }
  }
  return tags.slice(0, 60);
}

/** Best-effort local mood inference; no network or API key required. */
export function localMood(track = {}) {
  return scoreMood(localMoodTags(track), { wordBoundaries: true });
}
