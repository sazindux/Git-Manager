import { handle } from 'hono/vercel';
import { app } from '../lib/app.js';

export const config = { runtime: 'edge' };

export default handle(app);
