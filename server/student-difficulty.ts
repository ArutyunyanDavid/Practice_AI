import { z } from 'zod';
import { AppError } from './errors.js';

const DifficultyKindSchema = z.enum([
  'wrong-notes', 'tempo', 'uneven-rhythm', 'fingering', 'tension', 'other', 'not-sure',
]);

export const StudentDifficultySchema = z.object({
  kind: DifficultyKindSchema,
  details: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'other' ? !value.details : value.details !== undefined) {
    context.addIssue({ code: 'custom', message: 'Provide a short description only when choosing Other.' });
  }
});

export type StudentDifficulty = z.infer<typeof StudentDifficultySchema>;

export function parseStudentDifficulty(value: unknown): StudentDifficulty | undefined {
  if (value === undefined) return undefined;
  const parsed = StudentDifficultySchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, 'INVALID_DIFFICULTY', 'Choose a difficulty, or describe Other using 1 to 500 characters.');
  }
  return parsed.data;
}

export function reportsDiscomfort(difficulty?: StudentDifficulty): boolean {
  return difficulty?.kind === 'tension'
    || (difficulty?.kind === 'other' && /\b(pain\w*|hurt\w*|tension|discomfort|strain\w*|ache\w*)\b/i.test(difficulty.details ?? ''));
}

// Defense in depth for direct unsafe advice; the prompt also requires comfortable movement.
export function validateComfortableAdvice(text: string): void {
  const unsafe = text.split(/[.!?;\n]+/).some(sentence => {
    const hazardous = /\b(?:play|push|work|practi[cs]e|continue)\w*\s+(?:on\s+)?through\s+(?:the\s+)?pain\b|\b(?:ignore|disregard)\s+(?:the\s+)?pain\b|\b(?:force\w*|forcibl\w*)\b.{0,40}\b(?:stretch\w*|finger\w*|hand\w*)\b|\bstretch\w*\b.{0,40}\b(?:force\w*|as far as possible|maximum)\b/i;
    const match = hazardous.exec(sentence);
    return match && !/\b(?:not|never|avoid|stop|without|don't)\b/i.test(sentence.slice(0, match.index));
  });
  if (unsafe) throw new AppError(502, 'OPENAI_INVALID_RESPONSE', 'The practice advice did not meet the comfort guidelines. Please try again.');
}
