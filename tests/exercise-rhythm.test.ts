import { describe, expect, it } from 'vitest';
import { extractMeasureForAnalysis } from '../server/measure.js';
import { AIExerciseNotationSchema, generateExerciseMusicXml, validateGeneratedExerciseMusicXml } from '../server/exercise-musicxml.js';
import type { AIExerciseNotation } from '../server/exercise-musicxml.js';
import { exerciseMeter, validateExerciseRhythm } from '../server/exercise-rhythm.js';
import { detectOctavePassage, eligibleOctaveMethods, generateOctavePracticeExercise } from '../server/octave-practice.js';
import { getOctavePracticeRules } from '../server/octave-rules.js';
import { detectCzerny1Passage, generateCzerny1Exercise, getCzerny1PracticeRules } from '../server/czerny1-practice.js';
import { detectCzerny50Passage, generateCzerny50PracticeExercise, getCzerny50PracticeRules } from '../server/czerny50-practice.js';

function source(beats = '2', beatType = '4', options: { octaves?: boolean; both?: boolean; chromatic?: boolean } = {}) {
  const steps = options.chromatic ? ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G'] : ['C', 'D', 'E', 'F', 'G', 'F', 'E', 'D'];
  const hand = (staff: number) => steps.map((step, index) => {
    const finger = staff === 1 ? 'CDEFG'.indexOf(step) + 1 : 5 - 'CDEFG'.indexOf(step);
    const alter = options.chromatic && [1, 3, 6].includes(index) ? 1 : 0;
    return Array.from({ length: options.octaves ? 2 : 1 }, (_, chord) => (
      `<note>${chord ? '<chord/>' : ''}<pitch><step>${step}</step><alter>${alter}</alter><octave>${(staff === 1 ? 4 : 2) + chord}</octave></pitch>`
      + `<duration>1</duration><voice>${staff}</voice><type>16th</type><staff>${staff}</staff><notations><technical><fingering>${finger}</fingering></technical></notations></note>`
    )).join('');
  }).join('');
  return extractMeasureForAnalysis(`<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>4</divisions><key><fifths>-2</fifths></key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>${hand(1)}${options.both ? `<backup><duration>8</duration></backup>${hand(2)}` : ''}</measure></part></score-partwise>`, 0);
}

function bars(xml: string) {
  return Array.from({ length: (xml.match(/<measure\b/g) ?? []).length }, (_, index) => extractMeasureForAnalysis(xml, index).parts[0]);
}
const notes = (xml: string) => bars(xml).flatMap(bar => bar.events.filter(event => event.kind === 'note'));
const tieTypes = (note: Record<string, unknown>) => [...new Set((note.ties as Array<{ attributes: { type: string } }> | undefined)?.map(tie => tie.attributes.type) ?? [])];
const pitchedAttacks = (xml: string) => notes(xml).filter(note => note.pitch && !tieTypes(note).includes('stop'));
const event = (duration: AIExerciseNotation['staves'][number]['events'][number]['duration'], kind: 'notes' | 'rest' = 'notes') => ({
  kind, duration, pitches: kind === 'notes' ? [{ step: 'C' as const, alter: 0, octave: 4 }, { step: 'C' as const, alter: 0, octave: 5 }] : [],
  articulation: 'none' as const,
});

describe('serialized exercise rhythm', () => {
  it.each(['2/4', '3/4', '4/4', '6/8', '3+2/8'])('balances every eligible octave method in %s for both hands', meter => {
    const [beats, beatType] = meter.split('/');
    const measure = source(beats, beatType, { octaves: true, both: true, chromatic: true });
    const context = detectOctavePassage(measure)!;
    const methods = eligibleOctaveMethods(context);
    expect(methods).toHaveLength(getOctavePracticeRules().methods.length);
    for (const method of methods) {
      const xml = generateOctavePracticeExercise(method, measure, context).musicXml;
      expect(() => validateExerciseRhythm(xml), method).not.toThrow();
      expect(xml).not.toContain('implicit="yes"');
      expect(xml).toContain('<fifths>-2</fifths>');
      const expectedMeter = method === 'octave-chromatic-key-transitions'
        ? '<time><beats>4</beats><beat-type>4</beat-type></time>'
        : `<time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`;
      expect(xml).toContain(expectedMeter);
      expect(pitchedAttacks(xml).every(note => (note.technical as Array<unknown>)?.length > 0)).toBe(true);
    }
  });

  it('keeps all eight-note octave patterns and their fingerings when dividing 2/4 bars', () => {
    const measure = source('2', '4', { octaves: true });
    const context = detectOctavePassage(measure)!;
    for (const method of eligibleOctaveMethods(context)) {
      const originalMeter = source('4', '4', { octaves: true });
      const reference = generateOctavePracticeExercise(method, originalMeter, context).musicXml;
      const xml = generateOctavePracticeExercise(method, measure, context).musicXml;
      const musicalNotes = (value: string) => pitchedAttacks(value).map(note => ({
        pitch: note.pitch, technical: note.technical, articulations: note.articulations,
      }));
      expect(musicalNotes(xml), method).toEqual(musicalNotes(reference));
      expect(() => validateExerciseRhythm(xml)).not.toThrow();
      if (method === 'octave-five-note-alternating-accents' || method === 'octave-repeated-pairs-alternating-accents') {
        expect(bars(xml)).toHaveLength(4);
        expect(bars(xml).every(bar => bar.events.filter(note => note.kind === 'note' && !note.chord).length === 4)).toBe(true);
      }
      if (method === 'octave-repeated-pairs-alternating-accents') {
        expect(generateOctavePracticeExercise(method, measure, context).explanationSentences[1]).toContain('the second pass');
        expect(generateOctavePracticeExercise(method, originalMeter, context).explanationSentences[1]).toContain('measure two');
      }
    }
  });

  it('writes eight eighth notes as two 2/4 bars, counting octave chords only once', () => {
    const notation = AIExerciseNotationSchema.parse({ staves: [{ clef: 'treble', events: Array.from({ length: 8 }, () => event('eighth')) }] });
    const xml = generateExerciseMusicXml('Octave loop', notation, source());
    expect(bars(xml)).toHaveLength(2);
    expect(bars(xml).every(bar => bar.durationQuarterNotes === 2)).toBe(true);
    expect(pitchedAttacks(xml)).toHaveLength(16);
    expect(xml).toContain('<time><beats>2</beats><beat-type>4</beat-type></time>');
    expect(() => validateExerciseRhythm(xml)).not.toThrow();
    expect(() => validateGeneratedExerciseMusicXml(xml, notation)).not.toThrow();
  });

  it.each(['whole', 'dotted-half', 'half', 'dotted-quarter', 'quarter', 'dotted-eighth', 'eighth', 'dotted-16th', '16th', 'dotted-32nd', '32nd', '64th', 'half-triplet', 'quarter-triplet', 'eighth-triplet', '16th-triplet', '32nd-triplet'] as const)(
    'preserves the sounding duration of %s notes, rests and chords across barlines', duration => {
      for (const meter of ['2/4', '3/4', '6/8', '3+2/8']) {
        const [beats, beatType] = meter.split('/');
        const notation = { staves: [{ clef: 'treble' as const, events: [event('eighth'), event(duration), event(duration, 'rest'), event('eighth')] }] };
        const xml = generateExerciseMusicXml('Mixed duration', notation, source(beats, beatType));
        expect(() => validateExerciseRhythm(xml), `${duration} in ${meter}`).not.toThrow();
        expect(() => validateGeneratedExerciseMusicXml(xml, notation)).not.toThrow();
        expect(pitchedAttacks(xml)).toHaveLength(6);
        const reference = generateExerciseMusicXml('Reference duration', notation, source('16', '4'));
        const soundingDuration = (value: string) => notes(value).filter(note => note.pitch).reduce((sum, note) => sum + Number(note.durationDivisions) / Number(note.divisions), 0);
        expect(soundingDuration(xml)).toBeCloseTo(soundingDuration(reference), 8);
      }
    },
  );

  it('aligns unequal hands and ties every pitch of a sustained chord without new attacks', () => {
    const notation: AIExerciseNotation = { staves: [
      { clef: 'treble', events: Array.from({ length: 8 }, () => event('eighth')) },
      { clef: 'bass', events: [event('dotted-half')] },
    ] };
    const xml = generateExerciseMusicXml('Two hands', notation, source());
    expect(() => validateExerciseRhythm(xml)).not.toThrow();
    const bass = notes(xml).filter(note => note.staff === 2);
    expect(bass.filter(note => note.pitch && !tieTypes(note).includes('stop'))).toHaveLength(2);
    expect(bass.filter(note => note.pitch && tieTypes(note).includes('stop'))).toHaveLength(2);
    expect(bass.filter(note => note.rest).reduce((sum, note) => sum + Number(note.durationQuarterNotes), 0)).toBe(1);
    expect(bars(xml).every(bar => bar.durationQuarterNotes === 2)).toBe(true);
  });

  it('preserves composite meters instead of truncating them to the first beat group', () => {
    const measure = source();
    const attributes = measure.parts[0].events.find(event => event.kind === 'attributes')!;
    attributes.times = [{ beats: ['3', '2'], beatTypes: ['8', '4'] }];
    const notation: AIExerciseNotation = { staves: [{ clef: 'treble', events: Array.from({ length: 14 }, () => event('eighth')) }] };
    const xml = generateExerciseMusicXml('Composite meter', notation, measure);
    expect(xml).toContain('<time><beats>3</beats><beat-type>8</beat-type><beats>2</beats><beat-type>4</beat-type></time>');
    expect(bars(xml)).toHaveLength(2);
    expect(() => validateExerciseRhythm(xml)).not.toThrow();
    expect(exerciseMeter({ beats: ['3+2'], beatTypes: ['8'] }).ticks).toBe(120);
  });

  it('validates all six Czerny No. 1 methods in both hands, including triplets and held voices', () => {
    const context = detectCzerny1Passage('Czerny_Etude_1.mscz', source('2', '4', { both: true }))!;
    expect(context.passages).toHaveLength(2);
    for (const method of getCzerny1PracticeRules().methods) {
      for (const passage of context.passages) {
        const xml = generateCzerny1Exercise(method.id, passage).musicXml;
        expect(() => validateExerciseRhythm(xml), `${method.id} ${passage.hand}`).not.toThrow();
        if (method.sustainedVoice) {
          expect(pitchedAttacks(xml).filter(note => note.voice === '2')).toHaveLength(1);
        }
      }
    }
  });

  it('validates all six Czerny No. 50 rhythm methods in both hands', () => {
    const measure = source('4', '4', { both: true });
    const context = detectCzerny50Passage('Czerny_etude_50.mscz', measure)!;
    expect(context.passages).toHaveLength(2);
    for (const method of getCzerny50PracticeRules().methods) {
      for (const passage of context.passages) {
        const xml = generateCzerny50PracticeExercise(method.id, passage, measure).musicXml;
        expect(() => validateExerciseRhythm(xml), `${method.id} ${passage.hand}`).not.toThrow();
      }
    }
  });

  it('rejects overfilled bars, short voices, mismatched dots, broken ties and wrong backups', () => {
    const notation: AIExerciseNotation = { staves: [
      { clef: 'treble', events: [event('dotted-half')] },
      { clef: 'bass', events: [event('dotted-half')] },
    ] };
    const xml = generateExerciseMusicXml('Validation fixture', notation, source());
    expect(() => validateExerciseRhythm(xml)).not.toThrow();
    const mutations = [
      xml.replace('<beats>2</beats>', '<beats>1</beats>'),
      xml.replace('<duration>96</duration>', '<duration>48</duration>'),
      xml.replace('<type>half</type>', '<type>half</type><dot/>'),
      xml.replace('<tie type="start"/>', ''),
      xml.replace('<backup><duration>96</duration>', '<backup><duration>48</duration>'),
      xml.replace(/<note><rest\/>[\s\S]*?<\/note>/, ''),
    ];
    mutations.forEach(broken => expect(() => validateExerciseRhythm(broken)).toThrow(/rhythm is invalid/));
  });
});
