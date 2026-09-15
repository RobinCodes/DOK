// Strict parsing of form input. Anything that is not exactly the expected
// shape is rejected, e.g. "1e6", "12.0", " 5 5" or "0x10" are not integers.

import { ValidationError } from '../http/errors.js';

export function parseInteger(value, { min = -1e15, max = 1e15 } = {}) {
  const text = String(value ?? '').trim();
  if (!/^[+-]?\d{1,16}$/.test(text)) throw new ValidationError('error.notInteger');
  const number = Number(text) + 0;
  if (number < min || number > max) throw new ValidationError('error.outOfRange', { min, max });
  return number;
}

export function parseDecimal(value, { min = -1e12, max = 1e12 } = {}) {
  const text = String(value ?? '').trim();
  if (!/^[+-]?\d{1,12}(\.\d{1,6})?$/.test(text)) throw new ValidationError('error.notNumber');
  const number = Number(text) + 0;
  if (number < min || number > max) throw new ValidationError('error.outOfRange', { min, max });
  return number;
}

export function parseId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,15}$/.test(text) || Number(text) < 1) throw new ValidationError('error.notFound');
  return Number(text);
}

export function parseText(value, { max = 200, required = false } = {}) {
  const text = String(value ?? '').normalize('NFC').trim();
  if (required && !text) throw new ValidationError('error.required');
  if (text.length > max) throw new ValidationError('error.tooLong', { max });
  return text;
}

/** Accepts exactly 1/true/on and 0/false/off; returns null for anything else. */
export function parseBool(value) {
  const text = String(value ?? '').trim();
  if (['1', 'true', 'on'].includes(text)) return true;
  if (['0', 'false', 'off'].includes(text)) return false;
  return null;
}

export function parseChoice(value, options) {
  if (!options.includes(value)) throw new ValidationError('error.invalidChoice');
  return value;
}
