// Student names are typed by hand on phones, so one person can show up as
// "Kovács Péter", "kovacs  peter" or "Péter Kovács". nameKey() folds these
// into one key so the rules can recognise the same student everywhere
// (Rulebook §3.3: one person belongs to one class).

export const MAX_NAME_LENGTH = 80;

/** The name as displayed: normalized Unicode, single spaces, trimmed. */
export function cleanName(input) {
  return String(input ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Matching key: no accents, lowercase, no punctuation, word order ignored. */
export function nameKey(input) {
  return cleanName(input)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** A usable name has at least one letter and fits the length limit. */
export function isPlausibleName(name) {
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && /\p{L}/u.test(name);
}
