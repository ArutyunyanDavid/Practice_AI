import { z } from 'zod';
import { AppError } from './errors.js';
import { AIAnalysisTextSchema, ExerciseExplanationsSchema } from './exercise-musicxml.js';
import type { GeneratedMeasureAnalysis, GeneratedPracticeExercise } from './exercise-musicxml.js';
import type { AnalysisInput } from './openai.js';
import type { UsedExercise } from './exercise-history.js';
import { rememberExercise } from './exercise-history.js';
import { similarExercises } from './exercise-similarity.js';
import { czerny1ExerciseCandidates } from './czerny1-practice.js';
import { generateOctavePracticeExercise, octavePracticePromptSummary } from './octave-practice.js';
import { eligibleOctaveMethodIds, getOctaveMethod } from './octave-rules.js';
import { generateCzerny50PracticeExercise } from './czerny50-practice.js';
import { CZERNY50_METHOD_IDS, getCzerny50PracticeRules } from './czerny50-rules.js';
import { reportsDiscomfort } from './student-difficulty.js';
import type { StudentDifficulty } from './student-difficulty.js';

export function suitableForDifficulty(exercise: GeneratedPracticeExercise, difficulty?: StudentDifficulty): boolean {
  return !reportsDiscomfort(difficulty)
    || !/high lift|higher than usual|as fast (?:and correctly |and accurately )?as possible/i.test(exercise.title + exercise.musicXml);
}

interface RuleCandidate {
  id: string;
  methodId: string;
  passageId?: string;
  exercise: GeneratedPracticeExercise;
}

export interface RuleExerciseChoice {
  techniqueId: 'czerny1' | 'octaves' | 'czerny50';
  candidates: RuleCandidate[];
  requiredCandidateIds: string[];
  reference: unknown;
}

export const AIRuleExerciseChoiceSchema = z.object({
  analysis: AIAnalysisTextSchema,
  exercises: z.array(z.object({
    candidateId: z.string(),
    explanationSentences: ExerciseExplanationsSchema,
  }).strict()).length(2),
}).strict();

/** Personalization selects existing rule methods; it never rewrites their MusicXML. */
export function ruleExerciseChoice(
  input: AnalysisInput,
  previous?: { used: UsedExercise[]; passageId?: string },
): RuleExerciseChoice | null {
  if (!input.difficulty) return null;
  let choice: RuleExerciseChoice;
  if (input.czerny1Practice) {
    const context = input.czerny1Practice;
    const fourth = context.rules.methods.find(method => method.exerciseNumber === 4)!;
    const candidates = czerny1ExerciseCandidates(context).map(candidate => ({ ...candidate, id: candidate.methodId }));
    choice = {
      techniqueId: 'czerny1', candidates, reference: context,
      requiredCandidateIds: previous ? [] : candidates.filter(c => c.methodId.startsWith(`${fourth.id}:`)).map(c => c.id),
    };
  } else if (input.octavePractice) {
    const context = input.octavePractice;
    const methods = eligibleOctaveMethodIds(context.pattern, Math.min(...context.sequences.map(s => s.attacks.length)));
    choice = {
      techniqueId: 'octaves', requiredCandidateIds: [],
      reference: { context: octavePracticePromptSummary(context), methods: methods.map(getOctaveMethod) },
      candidates: methods.map(methodId => ({
        id: methodId, methodId, exercise: generateOctavePracticeExercise(methodId, input.measure, context),
      })),
    };
  } else if (input.czerny50Practice) {
    const passages = input.czerny50Practice.passages.filter(p => !previous || p.id === previous.passageId);
    choice = {
      techniqueId: 'czerny50', requiredCandidateIds: [],
      reference: { passages, rules: getCzerny50PracticeRules() },
      candidates: passages.flatMap(passage => CZERNY50_METHOD_IDS.map(methodId => ({
        id: `${passage.id}:${methodId}`, methodId, passageId: passage.id,
        exercise: generateCzerny50PracticeExercise(methodId, passage, input.measure),
      }))),
    };
  } else {
    return null;
  }
  const used = previous?.used ?? [];
  choice.candidates = choice.candidates.filter(candidate => {
    if (used.some(earlier => earlier.methodId === candidate.methodId)) return false;
    // High lifts and maximum-speed drills are unsuitable when discomfort is reported.
    if (!suitableForDifficulty(candidate.exercise, input.difficulty)) return false;
    return choice.techniqueId === 'czerny1'
      || !used.some(earlier => similarExercises(rememberExercise(candidate.exercise, candidate.methodId), earlier));
  });
  if (choice.candidates.length < 2) {
    if (choice.techniqueId === 'czerny1') {
      throw new AppError(422, 'PRACTICE_METHODS_EXHAUSTED', 'Fewer than two unused exercises remain for this difficulty. Select another scale passage to continue.');
    }
    return null; // Existing octave/No. 50 continuation supports fresh rule-based variations.
  }
  return choice;
}

export function ruleChoicePrompt(choice: RuleExerciseChoice) {
  return {
    techniqueId: choice.techniqueId,
    reference: choice.reference,
    requiredCandidateIds: choice.requiredCandidateIds,
    candidates: choice.candidates.map(({ id, passageId, exercise }) => ({
      id, passageId, title: exercise.title, instructions: exercise.explanationSentences,
    })),
  };
}

export function materializeRuleChoice(raw: unknown, choice: RuleExerciseChoice) {
  const parsed = AIRuleExerciseChoiceSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(502, 'OPENAI_INVALID_RESPONSE', 'The personalized exercises were incomplete. Please try again.');
  const ids = parsed.data.exercises.map(exercise => exercise.candidateId);
  const selected = ids.map(id => choice.candidates.find(candidate => candidate.id === id));
  if (new Set(ids).size !== 2 || selected.some(candidate => !candidate)
    || choice.requiredCandidateIds.some((id, index) => ids[index] !== id)
    || (choice.techniqueId === 'czerny50' && selected[0]?.passageId !== selected[1]?.passageId)) {
    throw new AppError(502, 'OPENAI_INVALID_RESPONSE', 'The selected exercises did not follow the practice rules. Please try again.');
  }
  const candidates = selected as RuleCandidate[];
  const generated: GeneratedMeasureAnalysis = {
    analysis: parsed.data.analysis,
    exercises: candidates.map((candidate, index) => ({
      ...candidate.exercise,
      explanationSentences: parsed.data.exercises[index].explanationSentences as [string, string],
    })) as GeneratedMeasureAnalysis['exercises'],
  };
  return { generated, methodIds: candidates.map(candidate => candidate.methodId), passageId: candidates[0].passageId };
}
