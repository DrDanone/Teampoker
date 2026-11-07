import { randomInt } from 'node:crypto';

/**
 * Erlaubte Zeichen für Raum-Codes: Großbuchstaben und Ziffern ohne
 * verwechselbare Zeichen (0/O, 1/I/L). 31 Zeichen, 8 Stellen
 * ergeben rund 8,5 · 10^11 mögliche Codes.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** Erzeugt einen zufälligen Raum-Code mit kryptografisch sicherem Zufall. */
export function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Bringt eine Benutzereingabe in die kanonische Form: Großbuchstaben,
 * ohne Leerzeichen und Bindestriche. Gibt `null` zurück, wenn die Eingabe
 * kein gültiger Code sein kann.
 *
 * @param {unknown} input
 */
export function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 32) return null;
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}
