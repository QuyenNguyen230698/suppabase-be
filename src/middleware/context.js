import crypto from 'crypto';

/** Attach req.id (request id) + req.locale ('en' | 'vi') to every request. */
export function contextMiddleware(req, res, next) {
  // request id
  const incoming = req.headers['x-request-id'];
  req.id = (typeof incoming === 'string' && incoming.length <= 64 && /^[\w-]+$/.test(incoming))
    ? incoming
    : crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);

  // locale resolution: explicit ?lang → user pref (later, after auth) → Accept-Language → en
  const q = (req.query.lang || '').toString().toLowerCase().slice(0, 2);
  if (q === 'vi' || q === 'en') {
    req.locale = q;
  } else {
    const accept = (req.headers['accept-language'] || '').toLowerCase();
    req.locale = /vi/.test(accept) ? 'vi' : 'en';
  }

  next();
}

/** Run AFTER authMiddleware: prefer the authenticated user's stored language. */
export function applyUserLocale(req, _res, next) {
  if (req.user?.language && /^(en|vi)/i.test(req.user.language)) {
    req.locale = req.user.language.toLowerCase().slice(0, 2);
  }
  next();
}
