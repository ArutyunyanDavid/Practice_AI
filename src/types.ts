export interface ScoreSummary {
  id: string;
  title: string;
  composer: string | null;
  filename: string;
  relativePath: string;
  format: '.mscz' | '.mscx' | '.musicxml' | '.xml' | '.mxl';
  modifiedAt: string;
  sizeBytes: number;
  requiresConversion: boolean;
  isValid: boolean;
  issue: string | null;
}

export interface SelectedMeasure {
  index: number;
  label: string;
}

export type AiConnectionState = 'connected' | 'not_verified' | 'not_configured' | 'connection_failed';

export interface AiConnectionStatus {
  status: AiConnectionState;
  model: string | null;
  reasoningEffort: 'medium';
  message: string;
}

export interface PracticeExercise {
  title: string;
  explanationSentences: [string, string];
  musicXml: string;
}

export interface MeasureAnalysis {
  analysisId: string;
  scoreId: string;
  scoreTitle: string;
  composer: string | null;
  measure: SelectedMeasure;
  analysis: string;
  exercises: [PracticeExercise, PracticeExercise];
  model: string;
  reasoningEffort: 'medium';
  generatedAt: string;
}

export interface AnalysisResponse {
  requestId?: string;
  analysis: MeasureAnalysis;
}

export interface HealthStatus {
  ok: boolean;
  scoresDirectory: string;
  museScore: {
    available: boolean;
    path: string | null;
  };
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}
