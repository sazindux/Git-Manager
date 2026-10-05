import { Hono } from 'hono';

export const app = new Hono().basePath('/api');

// Every API response is uncacheable.
app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

app.get('/health', (c) => c.json({ ok: true }));

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((_err, c) => c.json({ error: 'internal_error' }, 500));
