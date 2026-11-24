import { normalizeText } from './util.js';

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

/** Convert Last.fm tags into a normalized mood score map. */
export function scoreMood(tags = []) {
  const scores = Object.fromEntries(Object.keys(MOODS).map((mood) => [mood, 0]));
  for (const tag of tags) {
    const name = normalizeText(tag?.name);
    if (!name) continue;
    const weight = Number(tag.weight) || 1;
    const scale = 1 + Math.log2(1 + Math.max(0, weight)) * 0.3;
    for (const rule of RULES) {
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
  return MOODS[mood]?.color ?? '#6b7280';
}
