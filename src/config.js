// Process configuration from environment variables. Everything that the
// superadmin should be able to change at runtime lives in the database
// (see domain/settings.js), not here. This file only holds deployment facts.

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  return {
    production,
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3000),
    dbPath: env.DB_PATH || 'data/szigzug.db',
    // Secure cookies need HTTPS; on by default in production.
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : production,
    // Only trust X-Forwarded-For when nginx (on the same machine) is in front.
    trustProxy: env.TRUST_PROXY === '1',
  };
}
