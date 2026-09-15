// Minimal router: literal segments and ":param" segments, matched in order.
// Each route has a chain of handlers; a handler may throw an HttpError
// (e.g. a permission guard) to stop the chain.

function split(path) {
  return path.split('/').filter(Boolean);
}

function matchParts(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(':')) {
      let value;
      try {
        value = decodeURIComponent(segments[i]);
      } catch {
        return null;
      }
      params[pattern[i].slice(1)] = value;
    } else if (pattern[i] !== segments[i]) {
      return null;
    }
  }
  return params;
}

export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, ...handlers) => {
    routes.push({ method, pattern: split(pattern), handlers });
  };

  function match(method, pathname) {
    let pathExists = false;
    for (const route of routes) {
      const params = matchParts(route.pattern, split(pathname));
      if (!params) continue;
      pathExists = true;
      const methodOk = route.method === method || (method === 'HEAD' && route.method === 'GET');
      if (methodOk) return { handlers: route.handlers, params };
    }
    return pathExists ? { methodNotAllowed: true } : null;
  }

  return { get: add('GET'), post: add('POST'), match };
}
