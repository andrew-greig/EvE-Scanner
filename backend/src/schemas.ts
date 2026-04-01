import { z } from 'zod';

export const SearchSuggestQuerySchema = z.object({
  q: z.string().min(2),
  current_id: z.coerce.number().int().optional(),
});

export const SystemIdParamSchema = z.object({
  system_id: z.coerce.number().int().positive(),
});

export const CallbackQuerySchema = z.object({
  code: z.string(),
});

export const TacticalDetailsQuerySchema = z.object({
  force: z.coerce.boolean().default(false),
});

export type SearchSuggestQuery = z.infer<typeof SearchSuggestQuerySchema>;
export type SystemIdParam = z.infer<typeof SystemIdParamSchema>;
export type CallbackQuery = z.infer<typeof CallbackQuerySchema>;
export type TacticalDetailsQuery = z.infer<typeof TacticalDetailsQuerySchema>;
