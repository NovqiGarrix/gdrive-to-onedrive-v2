import { createMiddleware } from "@hono/hono/factory";
import { MyError } from "../exceptions/MyError.ts";
import google from "../lib/google.ts";

// Middleware to make sure
// the google access token always fresh

// will require a lot of read and write to redis
// so its better to use this middleware only when needed
export const ensureGoogleTokenMiddleware = createMiddleware(async (c, next) => {
    try {

        // Get token from redis
        await google.ensureToken();
        await next();

    } catch (error) {
        console.error("Error in ensureGoogleTokenMiddleware", error);
        return new MyError()
            .internalServerError('Internal Server Error')
            .toJSON(c.json);
    }
});