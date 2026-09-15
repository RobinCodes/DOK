// Language handling. The site is Hungarian; English is offered too, and is the
// default for visitors whose browser prefers any other language.

import en from './en.js';
import hu from './hu.js';

export const DICTIONARIES = { hu, en };
export const LANGUAGES = Object.keys(DICTIONARIES);

/**
 * An explicit choice (cookie) wins. Otherwise the browser's most preferred
 * language decides: Hungarian → hu, anything else → en. Without any
 * Accept-Language header (bots, scripts) the site's own language is used.
 */
export function detectLanguage(cookieValue, acceptLanguage) {
  if (LANGUAGES.includes(cookieValue)) return cookieValue;
  if (!acceptLanguage) return 'hu';
  const preferences = String(acceptLanguage)
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1, index };
    })
    .filter((p) => /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/.test(p.tag) && Number.isFinite(p.q) && p.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  if (preferences.length === 0) return 'hu';
  return preferences[0].tag.split('-')[0] === 'hu' ? 'hu' : 'en';
}

/** t('key', { name: 'x' }) → translated text with {name} placeholders filled in. */
export function translator(lang) {
  const dictionary = DICTIONARIES[lang] ?? hu;
  const t = (key, vars = {}) => {
    const template = dictionary[key] ?? hu[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
  };
  t.has = (key) => Object.hasOwn(dictionary, key);
  t.lang = lang;
  return t;
}
