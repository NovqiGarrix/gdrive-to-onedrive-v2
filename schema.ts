import { z } from "zod";

export const googleTokenSchema = z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiryDate: z.number(),
});