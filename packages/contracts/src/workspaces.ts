import { z } from "zod";
import { IdSchema, RoleSchema } from "./models";
import { DateTimeSchema } from "./values";

export const WorkspaceInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4096).default(""),
});
export const WorkspaceSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  name: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
export const WorkspaceMemberSchema = z.strictObject({
  userId: IdSchema,
  name: z.string(),
  email: z.email(),
  role: RoleSchema,
});
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;
