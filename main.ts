import { Hono } from '@hono/hono';
import { cors } from '@hono/hono/cors';
import { logger } from '@hono/hono/logger';
import authRoutes from "./routes/auth.routes.ts";
import { Bindings } from "./types.ts";
import { getRedisClient, oauth } from "./utils.ts";
import env from "./config/env.ts";

function getGoogleCallbackURL() {

    return oauth.generateAuthUrl({
        access_type: 'offline',
        response_type: 'code',
        scope: [
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/drive',
        ],
    });

}

const redis = await getRedisClient();

function main() {

    const app = new Hono<{ Bindings: Bindings }>();
    app.use(logger());
    app.use(cors());

    app.get('/', (c) => {
        return c.json({ message: 'Hello World' }, 200);
    });

    app.get('/health_check', (c) => {
        return c.json({ status: 'OK' }, 200);
    });

    app.use(async (c, next) => {
        c.env.oauth = oauth;
        c.env.redis = redis;
        c.env.vars = env;
        await next();
    });

    app.route('/auth', authRoutes);

    console.log(`Google OAuth URL: ${getGoogleCallbackURL()}`);
    Deno.serve({
        port: 4000,
        onListen({ port }) {
            console.log(`Listening on http://localhost:${port}`);
        }
    }, app.fetch);

}

Deno.addSignalListener('SIGINT', async () => {
    console.log('SIGINT received');
    await redis.quit();
    Deno.exit(0);
});

main();