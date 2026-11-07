/**
 * Kartenset (erweitertes Fibonacci). Werte werden als Zeichenketten
 * übertragen; `?` und `coffee` zählen nicht in die Statistik.
 */
export const CARDS = ['0', '0.5', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', 'coffee'];

const CARD_SET = new Set(CARDS);

export function isCard(value) {
  return typeof value === 'string' && CARD_SET.has(value);
}

/** Zahlenwert einer Karte oder `null` für `?` und `coffee`. */
export function numericValue(card) {
  if (card === '?' || card === 'coffee') return null;
  return Number(card);
}

/**
 * Auswertung nach dem Aufdecken.
 *
 * @param {{ id: string, vote: string | null }[]} votes
 */
export function evaluate(votes) {
  const numeric = votes
    .filter((v) => v.vote !== null && numericValue(v.vote) !== null)
    .map((v) => ({ id: v.id, value: numericValue(v.vote) }));
  const unsure = votes.filter((v) => v.vote === '?').length;
  const coffee = votes.filter((v) => v.vote === 'coffee').length;

  if (numeric.length === 0) {
    return {
      count: 0,
      average: null,
      median: null,
      min: null,
      max: null,
      consensus: false,
      highIds: [],
      lowIds: [],
      unsure,
      coffee,
    };
  }

  const values = numeric.map((n) => n.value).sort((a, b) => a - b);
  const min = values[0];
  const max = values.at(-1);
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  const average = values.reduce((sum, v) => sum + v, 0) / values.length;
  const spread = min !== max;

  return {
    count: numeric.length,
    average: round(average),
    median: round(median),
    min,
    max,
    // Einigkeit: mindestens zwei gleiche Zahlen und niemand ist unsicher.
    consensus: numeric.length >= 2 && !spread && unsure === 0,
    highIds: spread ? numeric.filter((n) => n.value === max).map((n) => n.id) : [],
    lowIds: spread ? numeric.filter((n) => n.value === min).map((n) => n.id) : [],
    unsure,
    coffee,
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}
