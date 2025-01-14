import { Hono } from "@hono/hono";
import { googleTokenSchema } from '../schema.ts';
import { Bindings } from "../types.ts";
import { REDIS_GOOGLE_TOKEN_KEY } from "../constant.ts";
import { MyError } from "../exceptions/MyError.ts";
import { google } from "googleapis";
import { ensureGoogleTokenMiddleware } from "../middlewares/auth.middleware.ts";

const auth = new Hono<{ Bindings: Bindings }>();

auth.get('/google/me', ensureGoogleTokenMiddleware, async (c) => {

    if (c.env.vars.ENV === 'production') {
        return new MyError()
            .forbidden('This endpoint is only for development')
            .toJSON(c.json);
    }

    if (!c.env.oauth.credentials.access_token) {
        return new MyError()
            .unauthorized('Access token not found')
            .toJSON(c.json);
    }

    try {
        const profile = await google.oauth2("v2")
            .userinfo.get({ auth: c.env.oauth });

        return c.json({ status: "OK", data: profile.data.family_name }, 200);
    } catch (error) {
        console.error(`Failed to get profile:`, error);
        return new MyError()
            .internalServerError('Failed to get profile')
            .toJSON(c.json);
    }

});

auth.get('/google/callback', async (c) => {

    const code = c.req.query('code');

    if (!code) {
        return c.json({ error: 'Missing code' }, 400);
    }

    const tokens = await c.env.oauth.getToken(code);
    const { access_token, refresh_token, expiry_date } = tokens.tokens;

    // Save to redis
    // check if previous token exists
    const previousToken = await c.env.redis.get(REDIS_GOOGLE_TOKEN_KEY);
    if (previousToken) {
        const previousTokenParsed = googleTokenSchema.parse(JSON.parse(previousToken));
        await c.env.redis.set(REDIS_GOOGLE_TOKEN_KEY, JSON.stringify({
            ...previousTokenParsed,
            accessToken: access_token,
            expiryDate: expiry_date,
            ...(refresh_token ? { refreshToken: refresh_token } : {})
        }));
    } else {
        await c.env.redis.set(REDIS_GOOGLE_TOKEN_KEY, JSON.stringify({
            accessToken: access_token,
            refreshToken: refresh_token,
            expiryDate: expiry_date,
        }));
    }

    return c.json({ status: "OK" }, 200);
});

export default auth;