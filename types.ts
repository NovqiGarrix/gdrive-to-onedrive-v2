import { Env } from "./config/env.ts";
import type { oauth } from './utils.ts';
import type { Redis } from 'ioredis';

export interface Bindings {
    oauth: typeof oauth;
    redis: Redis;
    vars: Env;
};

export interface MicrosoftToken {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
}