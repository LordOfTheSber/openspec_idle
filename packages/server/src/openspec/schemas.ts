import { z } from 'zod';

/**
 * Схемы ответов CLI OpenSpec.
 *
 * Описаны по фактическому выводу версии, зафиксированной в package.json.
 * Неизвестные поля пропускаются намеренно: добавление поля в новой версии CLI
 * не должно ронять IDE, а вот исчезновение поля, на которое мы опираемся,
 * обязано давать понятную ошибку.
 */

export const rootRefSchema = z.object({
  path: z.string(),
  source: z.string().optional(),
  role: z.string().optional(),
});

export const changeSummarySchema = z.object({
  name: z.string(),
  completedTasks: z.number().int().nonnegative(),
  totalTasks: z.number().int().nonnegative(),
  lastModified: z.string().optional(),
  status: z.string().optional(),
  schema: z.string().optional(),
});

export const listChangesSchema = z.object({
  changes: z.array(changeSummarySchema),
  root: rootRefSchema.nullable().optional(),
});

export const specSummarySchema = z.object({
  id: z.string(),
  requirementCount: z.number().int().nonnegative().optional(),
});

export const listSpecsSchema = z.object({
  specs: z.array(specSummarySchema),
  root: rootRefSchema.nullable().optional(),
});

export const artifactPathSchema = z.object({
  outputPath: z.string(),
  resolvedOutputPath: z.string(),
  existingOutputPaths: z.array(z.string()),
});

export const artifactStatusSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  description: z.string().optional(),
});

export const statusSchema = z.object({
  changeName: z.string(),
  schemaName: z.string(),
  changeRoot: z.string(),
  planningHome: z
    .object({
      kind: z.string().optional(),
      root: z.string(),
      changesDir: z.string().optional(),
      defaultSchema: z.string().optional(),
    })
    .optional(),
  artifactPaths: z.record(artifactPathSchema),
  artifacts: z.array(artifactStatusSchema),
  isPlanningComplete: z.boolean().optional(),
  isComplete: z.boolean().optional(),
  applyRequires: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional(),
});

export const validationIssueSchema = z.object({
  level: z.string(),
  path: z.string().optional(),
  message: z.string(),
});

export const validationItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  valid: z.boolean(),
  issues: z.array(validationIssueSchema),
  durationMs: z.number().optional(),
});

export const validateSchema = z.object({
  items: z.array(validationItemSchema),
  summary: z
    .object({
      totals: z.object({
        items: z.number().int(),
        passed: z.number().int(),
        failed: z.number().int(),
      }),
    })
    .optional(),
  version: z.string().optional(),
  root: rootRefSchema.nullable().optional(),
});

export const instructionsSchema = z.object({
  changeName: z.string().optional(),
  artifactId: z.string().optional(),
  schemaName: z.string().optional(),
  changeDir: z.string().optional(),
  outputPath: z.string().optional(),
  resolvedOutputPath: z.string().optional(),
  existingOutputPaths: z.array(z.string()).optional(),
  instruction: z.string().optional(),
  description: z.string().optional(),
  context: z.unknown().optional(),
  rules: z.array(z.string()).optional(),
  template: z.string().optional(),
  dependencies: z
    .array(
      z.object({
        id: z.string(),
        done: z.boolean().optional(),
        path: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  unlocks: z.array(z.string()).optional(),
  planningHome: z.object({ root: z.string() }).partial().optional(),
  root: rootRefSchema.nullable().optional(),
});

export const templatesSchema = z.record(
  z.object({ path: z.string(), source: z.string().optional() }),
);

export const schemaListEntrySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  artifacts: z.array(z.string()),
  source: z.string(),
});

export const schemasListSchema = z.array(schemaListEntrySchema);

export const schemaWhichSchema = z.object({
  name: z.string(),
  source: z.string(),
  path: z.string(),
  shadows: z
    .array(z.object({ source: z.string(), path: z.string() }).passthrough())
    .optional(),
});

export const schemaValidateSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
  valid: z.boolean(),
  issues: z.array(
    z.object({ level: z.string(), path: z.string().optional(), message: z.string() }),
  ),
});

export type RootRef = z.infer<typeof rootRefSchema>;
export type ChangeSummary = z.infer<typeof changeSummarySchema>;
export type ListChanges = z.infer<typeof listChangesSchema>;
export type SpecSummary = z.infer<typeof specSummarySchema>;
export type ListSpecs = z.infer<typeof listSpecsSchema>;
export type ChangeStatus = z.infer<typeof statusSchema>;
export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export type ValidationItem = z.infer<typeof validationItemSchema>;
export type ValidateResult = z.infer<typeof validateSchema>;
export type ArtifactInstructions = z.infer<typeof instructionsSchema>;
export type TemplatesMap = z.infer<typeof templatesSchema>;
export type SchemaListEntry = z.infer<typeof schemaListEntrySchema>;
export type SchemaWhich = z.infer<typeof schemaWhichSchema>;
export type SchemaValidate = z.infer<typeof schemaValidateSchema>;
