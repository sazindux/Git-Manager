import { app } from '../lib/app.js';

export const config = { runtime: 'nodejs' };

// Vercel's Web Standard handler passes the original /api/... Request to Hono.
export default {
  fetch(request) {
    return app.fetch(request);
  },
};
