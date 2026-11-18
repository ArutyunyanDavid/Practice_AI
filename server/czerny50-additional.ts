import { AppError } from './errors.js';
import { escapeXml } from './xml.js';
import { exerciseMeter, EXERCISE_DIVISIONS, partitionExerciseVoice, validateExerciseRhythm } from './exercise-rhythm.js';
import type { ExerciseMeter, RhythmFragment, WrittenRhythm } from './exercise-rhythm.js';
import type { GeneratedPracticeExercise } from './exercise-musicxml.js';
import type { ExtractedMeasure } from './measure.js';
import type { Czerny50Passage } from './czerny50-practice.js';
import { getCzerny50PracticeRules } from './czerny50-rules.js';
import type { Czerny50AdditionalMethodId } from './czerny50-rules.js';

type SourceNote = Record<string, unknown>;
type Staff = 1 | 2;
type StaffXml = (staff: Staff) => string;

interface PracticeEvent {
  notes: SourceNote[];
  onsetTicks: number;
  duration: WrittenRhythm;
  rest?: boolean;
  accent?: boolean;
  staccato?: boolean;
  slur?: 'start' | 'stop';
}

interface ExerciseVersion {
  voices: PracticeEvent[][];
  staff: Staff;
  label: string;
}

const SKILL_DESCRIPTIONS: Record<Czerny50AdditionalMethodId, string> = {
  'four-note-groups': 'This exercise develops accuracy and control within short note groups.',
  'progressive-note-groups': 'This exercise develops control across progressively longer passages.',
  'four-note-accent-shifts': 'This exercise develops evenness and control of changing accents.',
  'blocked-and-broken-chords': 'This exercise develops awareness of comfortable chord positions and arpeggio movements.',
  'legato-and-staccato': 'This exercise develops controlled connections and releases between notes.',
  'hands-separately': 'This exercise develops independent control of each hand.',
};

const records = (value: unknown): SourceNote[] => Array.isArray(value) ? value as SourceNote[] : [];
const pitch = (note: SourceNote) => note.pitch as { step: string; alter?: number; octave: number };

function midi(note: SourceNote): number {
  const value = pitch(note);
  const step = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[value.step] ?? 0;
  return (value.octave + 1) * 12 + step + (value.alter ?? 0);
}

function sourceNotes(passage: Czerny50Passage, source: ExtractedMeasure): SourceNote[] {
  const orders = passage.fullSourceOrders ?? passage.sourceOrders;
  return source.parts[passage.partIndex].events.filter(note => note.kind === 'note' && orders.includes(Number(note.order)));
}

// Conservative recognition: complete major/minor/diminished/augmented triads only,
// in a single compact position spanning no more than a major sixth.
function chordGroups(notes: SourceNote[]): SourceNote[][] | null {
  const groups: SourceNote[][] = [];
  for (let start = 0; start < notes.length; start += 3) {
    const group = notes.slice(start, start + 3);
    if (group.length !== 3) return null;
    const values = group.map(midi);
    if (Math.max(...values) - Math.min(...values) > 9 || new Set(values).size !== 3) return null;
    const recognized = values.some(root => {
      const intervals = values.map(value => (value - root + 120) % 12).sort((a, b) => a - b).join(',');
      return ['0,4,7', '0,3,7', '0,3,6', '0,4,8'].includes(intervals);
    });
    if (!recognized) return null;
    groups.push(group);
  }
  return groups.length ? groups : null;
}

export function eligibleAdditionalMethods(passage: Czerny50Passage, source: ExtractedMeasure): Czerny50AdditionalMethodId[] {
  const notes = sourceNotes(passage, source);
  const part = source.parts[passage.partIndex];
  const bothHands = [1, 2].every(staff => part.events.some(note => note.kind === 'note' && note.pitch && Number(note.staff ?? 1) === staff));
  return getCzerny50PracticeRules().additionalExercises.methods.filter(method => {
    if (method.id === 'hands-separately') return bothHands;
    if (notes.length < method.minimumNotes) return false;
    if (method.id === 'blocked-and-broken-chords') return chordGroups(notes) !== null;
    return true;
  }).map(method => method.id);
}

function rhythm(note: SourceNote): WrittenRhythm {
  const modification = note.timeModification as SourceNote | undefined;
  return {
    ticks: Math.round(Number(note.durationQuarterNotes) * EXERCISE_DIVISIONS),
    type: String(note.type ?? 'quarter'),
    dots: Number(note.dots ?? 0),
    ...(modification ? { timeModification: {
      actualNotes: Number(modification.actualNotes), normalNotes: Number(modification.normalNotes),
    } } : {}),
  };
}

function sequential(notes: SourceNote[]): PracticeEvent[] {
  let cursor = 0;
  return notes.map(note => {
    const event = { notes: [note], onsetTicks: cursor, duration: rhythm(note) };
    cursor += event.duration.ticks;
    return event;
  });
}

function retainInternalTies(events: PracticeEvent[]): void {
  const hasTie = (note: SourceNote, type: string) => records(note.ties).some(tie => (tie.attributes as SourceNote | undefined)?.type === type);
  events.forEach((event, index) => {
    event.notes = event.notes.map(note => {
      const adjacent = (offset: 1 | -1, type: string) => {
        const other = events[index + offset];
        if (!other) return false;
        const touches = offset === 1
          ? event.onsetTicks + event.duration.ticks === other.onsetTicks
          : other.onsetTicks + other.duration.ticks === event.onsetTicks;
        return touches && other.notes.some(candidate => JSON.stringify(pitch(candidate)) === JSON.stringify(pitch(note)) && hasTie(candidate, type));
      };
      return {
        ...note,
        sourceTieStart: hasTie(note, 'start') && adjacent(1, 'stop'),
        sourceTieStop: hasTie(note, 'stop') && adjacent(-1, 'start'),
      };
    });
  });
}

function handVoices(source: ExtractedMeasure, partIndex: number, staff: Staff): PracticeEvent[][] {
  const streams = new Map<string, PracticeEvent[]>();
  for (const note of source.parts[partIndex].events) {
    if (note.kind !== 'note' || Number(note.staff ?? 1) !== staff || note.grace !== undefined) continue;
    const voice = String(note.voice ?? '1');
    const events = streams.get(voice) ?? [];
    const onsetTicks = Math.round(Number(note.onsetQuarterNotes) * EXERCISE_DIVISIONS);
    const previous = events.at(-1);
    if (note.chord && previous && previous.onsetTicks === onsetTicks) previous.notes.push(note);
    else events.push({ notes: note.pitch ? [note] : [], onsetTicks, duration: rhythm(note), rest: !note.pitch });
    streams.set(voice, events);
  }
  // Keep internal source ties (including partially tied chords). Ties to notes
  // outside this isolated measure are closed at the exercise boundary.
  for (const events of streams.values()) retainInternalTies(events);
  return [...streams.values()];
}

function groupsWithRests(groups: SourceNote[][]): PracticeEvent[] {
  const events: PracticeEvent[] = [];
  let cursor = 0;
  for (const group of groups) {
    for (const event of sequential(group)) events.push({ ...event, onsetTicks: event.onsetTicks + cursor });
    cursor += group.reduce((sum, note) => sum + rhythm(note).ticks, 0);
    events.push({ notes: [], rest: true, onsetTicks: cursor, duration: { ticks: 24, type: 'eighth' } });
    cursor += 24;
  }
  return events;
}

function blockedChords(groups: SourceNote[][]): PracticeEvent[] {
  let cursor = 0;
  return groups.map(group => {
    // Empty type asks the partitioner to decompose the combined duration.
    const duration = { ticks: group.reduce((sum, note) => sum + rhythm(note).ticks, 0), type: '' };
    const fingers = group.map(note => records(note.technical).find(mark => mark.name === 'fingering')?.value).filter(Boolean);
    // A repeated arpeggio finger cannot play several simultaneous keys.
    const notes = new Set(fingers).size === fingers.length
      ? group : group.map(note => ({ ...note, technical: records(note.technical).filter(mark => mark.name !== 'fingering') }));
    const event = { notes, onsetTicks: cursor, duration };
    cursor += duration.ticks;
    return event;
  });
}

function buildVersions(
  id: Czerny50AdditionalMethodId, title: string, notes: SourceNote[], passage: Czerny50Passage, source: ExtractedMeasure,
): ExerciseVersion[] {
  const versions: ExerciseVersion[] = [];
  const add = (events: PracticeEvent[], label: string) => versions.push({ voices: [events], staff: passage.sourceStaff, label });
  if (id === 'four-note-groups' || id === 'progressive-note-groups') {
    const groups: SourceNote[][] = [];
    if (id === 'four-note-groups') {
      for (let start = 0; start < notes.length; start += 4) groups.push(notes.slice(start, start + 4));
    } else {
      for (let size = 4; size < notes.length; size += 2) groups.push(notes.slice(0, size));
      groups.push(notes);
    }
    add(groupsWithRests(groups), title);
  } else if (id === 'four-note-accent-shifts') {
    for (const offset of [0, 1]) {
      add(sequential(notes).map((event, index) => ({ ...event, accent: index % 4 === offset })), `Accent notes ${offset + 1}, ${offset + 5}, …`);
    }
  } else if (id === 'blocked-and-broken-chords') {
    add(blockedChords(chordGroups(notes)!), 'Play the comfortable chord positions');
    add(sequential(notes), 'Play the original notes separately');
  } else if (id === 'legato-and-staccato') {
    add(sequential(notes).map((event, index) => ({
      ...event,
      ...(index === 0 ? { slur: 'start' as const } : index === notes.length - 1 ? { slur: 'stop' as const } : {}),
    })), 'Legato');
    add(sequential(notes).map(event => ({ ...event, staccato: true })), 'Staccato');
  } else {
    for (const staff of [1, 2] as const) {
      versions.push({ voices: handVoices(source, passage.partIndex, staff), staff, label: staff === 1 ? 'Right hand only' : 'Left hand only' });
    }
  }
  return versions;
}

function renderVersions(versions: ExerciseVersion[], meter: ExerciseMeter, keyXml: StaffXml, clefXml: StaffXml): string {
  let measureNumber = 0;
  return versions.flatMap(version => {
    const end = Math.max(...version.voices.flatMap(voice => voice.map(event => event.onsetTicks + event.duration.ticks)));
    const count = Math.ceil(end / meter.ticks);
    const voices = version.voices.map(voice => partitionExerciseVoice(voice, meter.ticks, count));
    return Array.from({ length: count }, (_, bar) => {
      const body = voices.map((bars, voice) => {
        const content = bars[bar].map(fragment => renderFragment(fragment, voice + 1)).join('');
        return (voice ? `<backup><duration>${meter.ticks}</duration></backup>` : '') + content;
      }).join('');
      const attributes = bar === 0 ? [
        '<print new-system="yes"/><attributes><divisions>48</divisions>',
        keyXml(version.staff), meter.xml, clefXml(version.staff), '</attributes>',
        `<direction placement="above"><direction-type><words>${escapeXml(version.label)}</words></direction-type></direction>`,
      ].join('') : '';
      return `<measure number="${++measureNumber}">${attributes}${body}</measure>`;
    });
  }).join('');
}

function renderFragment(fragment: RhythmFragment<PracticeEvent>, voice: number): string {
  const event = fragment.source;
  const duration = fragment.duration;
  const notes = event?.notes.length ? event.notes : [null];
  return notes.map((note, index) => {
    const value = note ? pitch(note) : null;
    const fingers = note ? records(note.technical).filter(mark => mark.name === 'fingering')
      .map(mark => `<fingering>${escapeXml(String(mark.value))}</fingering>`).join('') : '';
    const tieStop = fragment.tieStop || Boolean(note?.sourceTieStop);
    const tieStart = fragment.tieStart || Boolean(note?.sourceTieStart);
    const ties = value ? `${tieStop ? '<tie type="stop"/>' : ''}${tieStart ? '<tie type="start"/>' : ''}` : '';
    const showSlur = event?.slur && ((event.slur === 'start' && !fragment.tieStop) || (event.slur === 'stop' && !fragment.tieStart));
    const notation = [
      tieStop ? '<tied type="stop"/>' : '',
      tieStart ? '<tied type="start"/>' : '',
      fingers ? `<technical>${fingers}</technical>` : '',
      !fragment.tieStop && event?.accent ? '<articulations><accent/></articulations>' : '',
      !fragment.tieStop && event?.staccato ? '<articulations><staccato/></articulations>' : '',
      showSlur ? `<slur number="1" type="${event.slur}"/>` : '',
    ].join('');
    return [
      '<note>', index ? '<chord/>' : '',
      value ? `<pitch><step>${value.step}</step><alter>${value.alter ?? 0}</alter><octave>${value.octave}</octave></pitch>` : '<rest/>',
      `<duration>${duration.ticks}</duration>`, ties, `<voice>${voice}</voice><type>${duration.type}</type>`,
      '<dot/>'.repeat(duration.dots ?? 0),
      duration.timeModification ? `<time-modification><actual-notes>${duration.timeModification.actualNotes}</actual-notes><normal-notes>${duration.timeModification.normalNotes}</normal-notes></time-modification>` : '',
      '<staff>1</staff>', notation ? `<notations>${notation}</notations>` : '', '</note>',
    ].join('');
  }).join('');
}

export function generateAdditionalExercise(
  id: Czerny50AdditionalMethodId, passage: Czerny50Passage, source: ExtractedMeasure,
  keyXml: StaffXml, clefXml: StaffXml,
): GeneratedPracticeExercise {
  if (!eligibleAdditionalMethods(passage, source).includes(id)) {
    throw new AppError(422, 'INELIGIBLE_PRACTICE_METHOD', 'This passage does not support the selected practice exercise.');
  }
  const method = getCzerny50PracticeRules().additionalExercises.methods.find(candidate => candidate.id === id)!;
  const part = source.parts[passage.partIndex];
  const initialAttributes = part.events.find(event => event.kind === 'attributes');
  const time = records(initialAttributes?.times)[0] ?? records(part.startingContext.times)[0];
  const versions = buildVersions(id, method.title, sourceNotes(passage, source), passage, source);
  const measures = renderVersions(versions, exerciseMeter(time), keyXml, clefXml);
  const title = `Exercise ${method.exerciseNumber}: ${method.title}`;
  const musicXml = [
    '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">',
    `<work><work-title>${escapeXml(title)}</work-title></work>`,
    '<part-list><score-part id="P1"><part-name>Practice</part-name></score-part></part-list>',
    `<part id="P1">${measures}</part></score-partwise>`,
  ].join('');
  validateExerciseRhythm(musicXml);
  return { title, musicXml, explanationSentences: [SKILL_DESCRIPTIONS[id], method.howToPractice] };
}
