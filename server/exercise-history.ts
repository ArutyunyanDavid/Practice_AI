import { z } from 'zod';
import { AppError } from './errors.js';
import {
  AIPracticeExerciseSchema,
  materializeMeasureAnalysis,
} from './exercise-musicxml.js';
import type { GeneratedPracticeExercise } from './exercise-musicxml.js';
import type { ExtractedMeasure } from './measure.js';
import { musicalContent, similarExercises } from './exercise-similarity.js';
import type { MusicalContent } from './exercise-similarity.js';

export const AIMoreExercisesSchema = z.object({
  exercises: z.array(AIPracticeExerciseSchema.extend({
    methodId: z.string().describe('The supplied reference method this exercise follows or varies.'),
  }).strict()).length(2),
}).strict();

export interface UsedExercise {
  methodId: string;
  title: string;
  fingerprint: string;
  musicalContent: MusicalContent;
}

export function rememberExercise(exercise: GeneratedPracticeExercise, methodId: string): UsedExercise {
  const content = musicalContent(exercise.musicXml);
  return {
    methodId,
    title: exercise.title,
    fingerprint: content.fingerprint,
    musicalContent: content,
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
  if (continuation.requiredMethodIds.length > 0 && new Set(methodIds).size !== methodIds.length) {
    throw new AppError(502, 'EXERCISES_REPEATED', 'Choose two different practice methods for this exercise set.');
  }
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

export function assertFreshExercises(exercises: UsedExercise[], used: UsedExercise[]): void {
  const seen = [...used];
  for (const exercise of exercises) {
    if (seen.some((previous) => similarExercises(exercise, previous))) {
      throw new AppError(502, 'EXERCISES_REPEATED', 'These exercises are too similar to each other or an earlier exercise. Please try again for a different practice pattern.');
    }
    seen.push(exercise);
  }
}
