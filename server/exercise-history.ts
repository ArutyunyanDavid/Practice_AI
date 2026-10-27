import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import {
  AIPracticeExerciseSchema,
  materializeMeasureAnalysis,
} from './exercise-musicxml.js';
import type { GeneratedPracticeExercise } from './exercise-musicxml.js';
import { extractMeasureForAnalysis } from './measure.js';
import type { ExtractedMeasure } from './measure.js';

export const AIMoreExercisesSchema = z.object({
  exercises: z.array(AIPracticeExerciseSchema.extend({
    methodId: z.string().describe('The supplied reference method this exercise follows or varies.'),
  }).strict()).length(2),
}).strict();

/** Compare musical content, ignoring titles, prose, engraving, and XML formatting. */
export function exerciseNotationSummary(exercise: GeneratedPracticeExercise): unknown[] {
  const count = (exercise.musicXml.match(/<measure\b/g) ?? []).length;
  return Array.from({ length: count }, (_, index) => (
    extractMeasureForAnalysis(exercise.musicXml, index).parts.map((part) => (
      part.events.filter((event) => event.kind === 'note').map((event) => ({
        staff: event.staff ?? 1,
        onset: event.onsetQuarterNotes,
        duration: event.durationQuarterNotes,
        pitch: event.pitch ?? null,
        chord: Boolean(event.chord),
        articulations: event.articulations ?? [],
      }))
    ))
  ));
}

export interface UsedExercise {
  methodId: string;
  title: string;
  notation: unknown[];
  fingerprint: string;
}

export function rememberExercise(exercise: GeneratedPracticeExercise, methodId: string): UsedExercise {
  const notation = exerciseNotationSummary(exercise);
  return {
    methodId,
    title: exercise.title,
    notation,
    fingerprint: createHash('sha256').update(JSON.stringify(notation)).digest('hex'),
  };
}

export interface ExerciseContinuation {
  techniqueId: string;
  reference: unknown;
  allowedMethodIds: string[];
  requiredMethodIds: string[];
  variations: boolean;
  previousExercises: UsedExercise[];
}

export function materializeMoreExercises(
  raw: unknown,
  analysis: string,
  source: ExtractedMeasure,
  continuation: ExerciseContinuation,
): { exercises: [GeneratedPracticeExercise, GeneratedPracticeExercise]; methodIds: string[] } {
  const parsed = AIMoreExercisesSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(502, 'OPENAI_INVALID_RESPONSE', 'The new exercises were incomplete. Please try again.');
  const methodIds = parsed.data.exercises.map((exercise) => exercise.methodId);
  if (
    methodIds.some((id) => !continuation.allowedMethodIds.includes(id))
    || continuation.requiredMethodIds.some((id) => !methodIds.includes(id))
  ) {
    throw new AppError(502, 'OPENAI_INVALID_RESPONSE', 'The new exercises did not follow the practice rules. Please try again.');
  }

  const pitchKey = (pitch: Record<string, unknown>) => `${pitch.step}:${pitch.alter ?? 0}:${pitch.octave}`;
  const sourcePitches = new Set(source.parts.flatMap((part) => part.events.flatMap((event) => (
    event.kind === 'note' && event.pitch && typeof event.pitch === 'object'
      ? [pitchKey(event.pitch as Record<string, unknown>)] : []
  ))));
  for (const exercise of parsed.data.exercises) {
    for (const staff of exercise.notation.staves) {
      for (const event of staff.events) {
        if (event.pitches.some((pitch) => !sourcePitches.has(pitchKey(pitch)))) {
          throw new AppError(502, 'OPENAI_INVALID_RESPONSE', 'The new exercises changed the source pitches. Please try again.');
        }
      }
    }
  }
  const generated = materializeMeasureAnalysis({
    analysis,
    exercises: parsed.data.exercises.map(({ methodId: _methodId, ...exercise }) => exercise),
  }, source);
  return { exercises: generated.exercises, methodIds };
}

export function assertFreshExercises(exercises: GeneratedPracticeExercise[], used: UsedExercise[]): void {
  const seen = new Set(used.map((exercise) => exercise.fingerprint));
  for (const exercise of exercises) {
    const { fingerprint } = rememberExercise(exercise, '');
    if (seen.has(fingerprint)) {
      throw new AppError(502, 'EXERCISES_REPEATED', 'The AI repeated an earlier exercise. Your current exercises are still here; please try again.');
    }
    seen.add(fingerprint);
  }
}
