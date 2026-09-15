// Time helpers. The database stores UTC ISO strings; people read and type
// Budapest local time.

export const TIME_ZONE = 'Europe/Budapest';

/** Offset of Budapest from UTC at the given instant, in milliseconds. */
function zoneOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** "2026-09-18T14:00" (Budapest wall clock, as sent by <input type=datetime-local>) → UTC ISO string. */
export function budapestLocalToIso(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local).trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(wall).getUTCMonth() !== month - 1 || hour > 23 || minute > 59) return null;
  // Two passes settle the offset correctly even right next to a DST change.
  let utc = wall - zoneOffsetMs(wall);
  utc = wall - zoneOffsetMs(utc);
  return new Date(utc).toISOString();
}

/** UTC ISO → "2026-09-18T14:00" in Budapest time, for datetime-local inputs. */
export function isoToBudapestLocal(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  return new Date(ms + zoneOffsetMs(ms)).toISOString().slice(0, 16);
}

export function formatDateTime(iso, lang) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(lang === 'hu' ? 'hu-HU' : 'en-GB', {
    timeZone: TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

export function formatTime(iso, lang) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(lang === 'hu' ? 'hu-HU' : 'en-GB', { timeZone: TIME_ZONE, timeStyle: 'short' }).format(new Date(iso));
}

export const minutesBetween = (fromIso, toIso) => Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
