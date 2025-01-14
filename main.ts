import { Hono } from '@hono/hono';
import { cors } from '@hono/hono/cors';
import { logger } from '@hono/hono/logger';
import env from "./config/env.ts";
import authRoutes from "./routes/auth.routes.ts";
import { Bindings } from "./types.ts";
import { getRedisClient, oauth } from "./utils.ts";

function getGoogleCallbackURL() {

    return oauth.generateAuthUrl({
        access_type: 'offline',
        response_type: 'code',
        scope: [
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/drive',
        ],
        redirect_uri: `${env.BASE_URL}/auth/google/callback`
    });

}

function getMicrosoftCallbackURL() {
    const url = new URL(`https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize`);

    url.searchParams.set('client_id', env.MICROSOFT_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', `${env.BASE_URL}/auth/microsoft/callback`);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', 'openid offline_access profile User.Read Files.ReadWrite');

    return url.toString();
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
    console.log('-----------------------------------');
    console.log(`Microsoft OAuth URL: ${getMicrosoftCallbackURL()}`);
    console.log('-----------------------------------');

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