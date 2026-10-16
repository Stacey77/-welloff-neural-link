import type { Request, Response, NextFunction } from 'express';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const requiredKey = process.env.NEURAL_API_KEY;
  if (!requiredKey) { next(); return; }  // dev mode: no key set = open
  const provided =
    (req.headers['x-api-key'] as string | undefined) ??
    (req.query['api_key'] as string | undefined);
  if (!provided || provided !== requiredKey) {
    res.status(401).json({ error: 'unauthorized', hint: 'Provide x-api-key header or api_key query param' });
    return;
  }
  next();
}

export function auditLog(req: Request, _res: Response, next: NextFunction): void {
  const keyHint = (req.headers['x-api-key'] as string | undefined)?.slice(0, 8) ?? 'anon';
  console.log(`[audit] ${new Date().toISOString()} ${req.method} ${req.path} key=${keyHint}`);
  next();
}
