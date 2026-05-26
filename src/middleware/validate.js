// validate — express middleware factory for Zod schemas.
//
// In Express 5, req.query is a read-only getter, so for query/params we expose
// the parsed values via req.validatedQuery / req.validatedParams instead of
// mutating req.query. req.body is still writable.
//
// Usage:
//   import { z } from 'zod';
//   router.post('/', validate({ body: z.object({ name: z.string() }) }), handler);
//   // controller can read req.body (parsed), req.validatedQuery, req.validatedParams
//   // For backwards compatibility, req.query is still readable as-is.

import { ZodError } from 'zod';

function buildIssues(err) {
  return err.issues.map(i => ({
    path: i.path.join('.') || '(root)',
    message: i.message,
    code: i.code,
  }));
}

export function validate({ body, query, params } = {}) {
  return (req, res, next) => {
    try {
      if (body)   req.body = body.parse(req.body ?? {});
      if (query) {
        const parsed = query.parse(req.query ?? {});
        req.validatedQuery = parsed;
        // Also try to mutate req.query for handlers that still read it.
        // Express 5 wraps query in a getter; defineProperty bypasses that.
        try { Object.defineProperty(req, 'query', { value: parsed, configurable: true, writable: true }); }
        catch { /* read-only in some configs — handler should use req.validatedQuery */ }
      }
      if (params) {
        const parsed = params.parse(req.params ?? {});
        req.validatedParams = parsed;
        Object.assign(req.params, parsed);
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          code: 'ERR_VALIDATION',
          issues: buildIssues(err),
        });
      }
      next(err);
    }
  };
}
