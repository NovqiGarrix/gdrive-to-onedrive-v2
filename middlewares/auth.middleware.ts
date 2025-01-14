import { createMiddleware } from "@hono/hono/factory";
import { REDIS_GOOGLE_TOKEN_KEY } from "../constant.ts";
import { MyError } from "../exceptions/MyError.ts";
import { googleTokenSchema } from "../schema.ts";

// Middleware to make sure
// the google access token always fresh

// will require a lot of read and write to redis
// so its better to use this middleware only when needed
export const ensureGoogleTokenMiddleware = createMiddleware(async (c, next) => {
    try {

        // Get token from redis
        const token = await c.env.redis.get(REDIS_GOOGLE_TOKEN_KEY);
        if (!token) {
            return c.json({ message: 'Google access token not found. Please sign in again' }, 401);
        }

        const parsedToken = googleTokenSchema.parse(JSON.parse(token));

        // Check if the expiry date is passed
        if (parsedToken.expiryDate < Date.now()) {
            // Get new token
            c.env.oauth.setCredentials({
                access_token: parsedToken.accessToken,
                refresh_token: parsedToken.refreshToken,
                expiry_date: parsedToken.expiryDate,
                token_type: 'Bearer',
            });

            const { res: { data: { access_token, expiry_date } } } = await c.env.oauth.getAccessToken();
            if (!access_token) {
                return new MyError()
                    .internalServerError('Failed to get access token')
                    .toJSON(c.json);
            }

            // Save the new token to redis
            await c.env.redis.set(REDIS_GOOGLE_TOKEN_KEY, JSON.stringify({
                ...parsedToken,
                accessToken: access_token,
                expiryDate: expiry_date
            }));

            c.env.oauth.setCredentials({
                access_token: access_token,
                refresh_token: parsedToken.refreshToken,
                expiry_date: expiry_date,
                token_type: 'Bearer',
            });
        } else {
            c.env.oauth.setCredentials({
                access_token: parsedToken.accessToken,
                refresh_token: parsedToken.refreshToken,
                expiry_date: parsedToken.expiryDate,
                token_type: 'Bearer',
            });
        }

        await next();
    } catch (error) {
        console.error("Error in ensureGoogleTokenMiddleware", error);
        return new MyError()
            .internalServerError('Internal Server Error')
            .toJSON(c.json);
    }
});