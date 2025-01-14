import { google } from "googleapis";
import env from "./config/env.ts";
import { Redis } from "ioredis";

export const oauth = new google.auth.OAuth2({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.BASE_URL}/auth/google/callback`,
});

export async function getRedisClient() {
    const redis = new Redis(`rediss://${env.REDIS_USERNAME}:${env.REDIS_PASSWORD}@${env.REDIS_HOSTNAME}:${env.REDIS_PORT}`);
    await new Promise((resolve) => redis.on('connect', resolve));

    console.log('Connected to Redis');
    return redis;
}