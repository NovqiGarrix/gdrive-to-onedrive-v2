import "@std/dotenv/load";

import { z } from 'zod';

const envSchema = z.object({
    GOOGLE_CLIENT_ID: z.string(),
    GOOGLE_CLIENT_SECRET: z.string(),
    GOOGLE_REDIRECT_URL: z.string().default('http://localhost:4000/auth/google/callback'),

    MICROSOFT_CLIENT_ID: z.string(),
    MICROSOFT_CLIENT_SECRET: z.string(),
    MICROSOFT_TENANT_ID: z.string(),

    ENV: z.enum(['development', 'production']).default('development'),
    BASE_URL: z.string().default('http://localhost:4000'),

    REDIS_HOSTNAME: z.string(),
    REDIS_PORT: z.string().transform((port) => Number(port)),
    REDIS_USERNAME: z.string(),
    REDIS_PASSWORD: z.string(),
});

export type Env = z.infer<typeof envSchema>;

export default envSchema.parse(Deno.env.toObject());