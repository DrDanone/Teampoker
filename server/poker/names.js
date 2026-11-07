export const MAX_NAME_LENGTH = 30;

/** Fehler im Poker-Protokoll; `message` darf dem Benutzer angezeigt werden. */
export class PokerError extends Error {
  /**
   * @param {'invalid-code' | 'invalid-name' | 'name-taken' | 'room-full' | 'locked'
   *   | 'not-joined' | 'invalid-message'} code
   */
  constructor(code, message) {
    super(message);
    this.name = 'PokerError';
    this.code = code;
  }
}

/**
 * Prüft einen Teilnehmernamen und gibt ihn bereinigt zurück:
 * Steuerzeichen entfernt, Leerraum zusammengefasst, Unicode normalisiert.
 *
 * @param {unknown} name
 */
export function cleanParticipantName(name) {
  if (typeof name !== 'string' || name.length > 200) {
    throw new PokerError('invalid-name', 'Bitte einen Namen eingeben');
  }
  const cleaned = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) throw new PokerError('invalid-name', 'Bitte einen Namen eingeben');
  if ([...cleaned].length > MAX_NAME_LENGTH) {
    throw new PokerError(
      'invalid-name',
      `Der Name darf höchstens ${MAX_NAME_LENGTH} Zeichen haben`,
    );
  }
  return cleaned;
}

/** Schlüssel für den Vergleich von Namen (Groß-/Kleinschreibung egal). */
export function nameKey(name) {
  return name.toLocaleLowerCase('de');
}
