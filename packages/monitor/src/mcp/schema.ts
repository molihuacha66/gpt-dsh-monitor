import {z} from 'zod';
export const readSchema=z.object({
  action:z.enum(['health','conversation','overview','preview','export','tasks','task','agents','agent-events']).optional(),
  collab:z.string().max(200).optional(),includeTests:z.boolean().optional(),q:z.string().max(200).optional(),
  direction:z.enum(['all','gpt-dsh','dsh-gpt','broadcast']).optional(),from:z.number().int().nonnegative().optional(),to:z.number().int().nonnegative().optional(),
  before:z.number().int().nonnegative().optional(),after:z.number().int().nonnegative().optional(),anchor:z.string().max(128).optional(),limit:z.number().int().min(1).max(100).optional(),
  id:z.string().max(128).optional(),file:z.string().max(64).optional(),generation:z.number().int().min(1).optional(),
}).strict();
