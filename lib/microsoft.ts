import { AuthenticationProvider, AuthenticationProviderOptions, Client, ClientOptions } from "@microsoft/microsoft-graph-client";
import type { Redis } from "ioredis";
import { z } from "zod";
import env from "../config/env.ts";
import { REDIS_MICROSOFT_TOKEN_KEY } from "../constant.ts";
import { MyError } from "../exceptions/MyError.ts";
import { getRedisClient } from "../utils.ts";

interface MicrosoftResponseTokenType {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope: string;
}

export async function getMicrosoftToken(codeOrRefreshToken: string, isRefreshToken = false): Promise<MicrosoftResponseTokenType> {

    try {

        const params = new URLSearchParams();
        params.append('client_id', env.MICROSOFT_CLIENT_ID);
        params.append('scope', 'openid offline_access profile User.Read Files.ReadWrite');
        params.append('redirect_uri', `${env.BASE_URL}/auth/microsoft/callback`);
        params.append('client_secret', env.MICROSOFT_CLIENT_SECRET);

        if (isRefreshToken) {
            params.append('grant_type', 'refresh_token');
            params.append('refresh_token', codeOrRefreshToken);
        } else {
            params.append('code', codeOrRefreshToken);
            params.append('grant_type', 'authorization_code');
        }

        const resp = await fetch(`https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
        });

        const data = await resp.json();

        if (!resp.ok) {
            console.error(data);
            throw new MyError()
                .badRequest(`Failed to get token: ${data?.error_description ?? resp.statusText}`);
        }

        return data;

    } catch (error) {
        if (error instanceof MyError) {
            throw error;
        }
        console.error(`Failed to get Microsoft token:`, error);
        throw new MyError()
            .internalServerError('Failed to get Microsoft token');
    }

}

const microsoftTokenSchema = z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.number(),
    scope: z.string(),
    tokenType: z.string()
});

export class MicrosoftAuthenticationProvider implements AuthenticationProvider {

    // @ts-expect-error - Not assigned yet
    redisClient: Redis = null;

    accessToken: string = '';
    expiryDate: number = 0;

    constructor(redis?: Redis) {
        if (redis) {
            this.redisClient = redis;
        }
    }

    private async ensureRedisClient() {
        if (!this.redisClient) {
            this.redisClient = await getRedisClient();
        }
    }

    async getAccessToken(_?: AuthenticationProviderOptions): Promise<string> {
        await this.ensureRedisClient();

        if (!this.accessToken || this.expiryDate < Date.now()) {
            const token = await this.redisClient.get(REDIS_MICROSOFT_TOKEN_KEY);
            if (!token) {
                throw new Error('Microsoft token not found in redis');
            }

            // expiresIn is in seconds
            const parsedToken = microsoftTokenSchema.parse(JSON.parse(token));
            const { accessToken, expiresIn, refreshToken } = parsedToken;

            const expiresTime = expiresIn * 1000;

            // expired token
            if (expiresTime < Date.now()) {
                // Get a new one
                const { access_token, expires_in } = await getMicrosoftToken(refreshToken, true);

                await this.redisClient.set(REDIS_MICROSOFT_TOKEN_KEY, JSON.stringify({
                    ...parsedToken,
                    accessToken: access_token,
                    expiresIn: expires_in,
                }));

                this.accessToken = access_token;
                this.expiryDate = new Date().getTime() + (expires_in * 1000);
            } else {
                this.accessToken = accessToken;
                this.expiryDate = new Date().getTime() + (expiresIn * 1000);
            }
        }

        return this.accessToken;
    }

}

const clientOptions: ClientOptions = {
    authProvider: new MicrosoftAuthenticationProvider()
}

export const microsoftClient = Client.initWithMiddleware(clientOptions);