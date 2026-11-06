import { describe, expect, it, vi } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { extractMeasureForAnalysis } from '../server/measure.js';
import { detectCzerny1Passage, generateCzerny1Exercise, getCzerny1PracticeRules } from '../server/czerny1-practice.js';
import { OpenAIService } from '../server/openai.js';
import type { AnalysisInput } from '../server/openai.js';

const filename = 'Czerny_Etude_1.mscz';
const analysis = 'This scale passage needs even finger movement and a relaxed hand. Practice the printed finger patterns slowly before increasing the speed.';
const rules = getCzerny1PracticeRules();
function source(options: { both?: boolean; fingers?: boolean; fifths?: number; sequence?: string[] } = {}) {
  const sequence = options.sequence ?? ['C', 'D', 'E', 'F', 'G', 'F', 'E', 'D'];
  const notes = (staff: number) => sequence.map(step => {
    const position = 'CDEFG'.indexOf(step);
    const finger = staff === 1 ? position + 1 : 5 - position;
    return `<note><pitch><step>${step}</step>${step === 'F' && options.fifths === 1 ? '<alter>1</alter>' : ''}<octave>${staff === 1 ? 4 : 3}</octave></pitch><duration>1</duration><voice>${staff}</voice><type>16th</type><staff>${staff}</staff>${options.fingers ? `<notations><technical><fingering>${finger}</fingering></technical></notations>` : ''}</note>`;
  }).join('');
  return `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>4</divisions><key><fifths>${options.fifths ?? 0}</fifths></key><time><beats>2</beats><beat-type>2</beat-type></time><staves>2</staves></attributes>${notes(1)}${options.both ? `<backup><duration>${sequence.length}</duration></backup>${notes(2)}` : ''}</measure></part></score-partwise>`;
}
const context = (options = {}) => detectCzerny1Passage(filename, extractMeasureForAnalysis(source(options), 0))!;
const events = (xml: string, measure: number, voice = '1') => extractMeasureForAnalysis(xml, measure).parts[0].events.filter(e => e.kind === 'note' && e.voice === voice);
const finger = (e: Record<string, unknown>) => Number((e.technical as Array<{name: string; value: string}>).find(x => x.name === 'fingering')!.value);
const marks = (e: Record<string, unknown>) => ((e.articulations ?? []) as Array<{name: string}>).map(x => x.name);
const tieTypes = (e: Record<string, unknown>) => [...new Set(((e.ties ?? []) as Array<{attributes: {type: string}}>).map(t => t.attributes.type))];
function exercise(number: number, hand: 'right' | 'left' = 'right', options = {}) {
  const passage = context({ both: true, ...options }).passages.find(p => p.hand === hand)!;
  return generateCzerny1Exercise(rules.methods[number - 1].id, passage);
}
function input(options = {}): AnalysisInput {
  return { scoreId: 'test', scoreTitle: 'Czerny No. 1', scoreFilename: filename, composer: 'Carl Czerny', measure: extractMeasureForAnalysis(source(options), 0) };
}

describe('Czerny No. 1 exact teaching rules', () => {
  it('detects both hands, preserves printed fingers, and derives missing five-finger positions', () => {
    const detected = context({ both: true, fingers: true });
    expect(detected.passages.map(p => p.hand)).toEqual(['right', 'left']);
    expect(detected.passages[0].notes.map(n => n.finger)).toEqual([1, 2, 3, 4, 5, 4, 3, 2]);
    expect(detected.passages[1].notes.map(n => n.finger)).toEqual([5, 4, 3, 2, 1, 2, 3, 4]);
    expect(detected.passages.every(p => !p.fingeringsDerived)).toBe(true);
    expect(context().passages[0].fingeringsDerived).toBe(true);
    expect(detectCzerny1Passage('Other.mscz', input().measure)).toBeNull();
  });

  it('does not bridge a rest to invent a scale passage', () => {
    const xml = source({ sequence: ['C', 'D', 'E'] }).replace('<pitch><step>D</step><octave>4</octave></pitch>', '<rest/>');
    expect(detectCzerny1Passage(filename, extractMeasureForAnalysis(xml, 0))).toBeNull();
  });

  it.each([1, 2, 3, 4, 5, 6])('writes method %i in 4/4 with original key and visible fingers', number => {
    const xml = exercise(number, 'right', { fifths: 1, fingers: true }).musicXml;
    const doc = new XMLParser({ ignoreAttributes: false }).parse(xml)['score-partwise'];
    const bars = doc.part.measure;
    expect(bars).toHaveLength(number === 5 ? 3 : 2);
    bars.forEach((bar: any, i: number) => {
      expect((bar.attributes ?? bars[0].attributes).time).toEqual({ beats: 4, 'beat-type': 4 });
      expect((bar.attributes ?? bars[0].attributes).key.fifths).toBe(1);
      const notes = events(xml, i);
      expect(notes).toHaveLength(number === 5 ? 12 : 8);
      expect(notes.every(n => n.type === 'eighth' && finger(n) >= 1 && finger(n) <= 5)).toBe(true);
      expect(notes.reduce((sum, n) => sum + Number(n.durationQuarterNotes), 0)).toBeCloseTo(4, 4);
      expect(notes[0].onsetQuarterNotes).toBe(0);
    });
  });

  it('repeats or truncates the original notes and applies accents, staccato and tenuto only to finger 4', () => {
    for (const sequence of [['E', 'F', 'G'], ['C','D','E','F','G','F','E','D','C','D']]) {
      for (const number of [1, 2]) {
        const xml = exercise(number, 'right', { sequence, fingers: true }).musicXml;
        for (let bar = 0; bar < 2; bar++) {
          const notes = events(xml, bar);
          expect(notes.map(n => (n.pitch as any).step)).toEqual(Array.from({length: 8}, (_, i) => sequence[i % sequence.length]));
          notes.forEach(n => expect(marks(n)).toEqual(finger(n) === 4 ? (number === 1 ? (bar === 0 ? ['accent'] : []) : [bar === 0 ? 'staccato' : 'tenuto']) : []));
        }
      }
    }
    const xml = exercise(1).musicXml;
    expect(xml).toContain('Lift finger 4 higher than usual before playing.');
    expect(xml).toContain('Return to natural finger movement.');
  });

  it.each([3, 4, 5])('method %i holds its note with one attack and simultaneous tied voices across every bar', number => {
    const xml = exercise(number).musicXml;
    const bars = number === 5 ? 3 : 2;
    const held = Array.from({length: bars}, (_, i) => events(xml, i, '2')).flat();
    expect(held).toHaveLength(bars * 8);
    expect(held.filter(n => !tieTypes(n).includes('stop'))).toHaveLength(1);
    held.forEach((n, i) => {
      expect(tieTypes(n).sort()).toEqual((i === 0 ? ['start'] : i === held.length - 1 ? ['stop'] : ['start', 'stop']).sort());
      expect(finger(n)).toBe(number === 4 ? 3 : 5);
      expect(n.pitch).toEqual(held[0].pitch);
    });
    for (let bar = 0; bar < bars; bar++) {
      expect(Number(events(xml, bar, '2')[0].onsetQuarterNotes)).toBeCloseTo(0, 4);
      expect(events(xml, bar, '2').reduce((sum, n) => sum + Number(n.durationQuarterNotes), 0)).toBe(4);
      expect(events(xml, bar).every(n => JSON.stringify(n.pitch) !== JSON.stringify(held[0].pitch))).toBe(true);
    }
  });

  it('method 4 always derives a complete natural position and reverses the left-hand finger assignment', () => {
    for (const hand of ['right', 'left'] as const) {
      const xml = exercise(4, hand, { sequence: ['C', 'D', 'E'] }).musicXml;
      expect(events(xml, 0).map(finger)).toEqual([1,2,4,5,4,2,1,2]);
      expect(events(xml, 1).map(finger)).toEqual([5,4,2,1,2,4,5,4]);
      expect(events(xml, 0).map(n => (n.pitch as any).step)).toEqual(hand === 'right' ? ['C','D','F','G','F','D','C','D'] : ['G','F','D','C','D','F','G','F']);
      expect((events(xml, 0, '2')[0].pitch as any).step).toBe('E');
    }
    const xml = exercise(4, 'right', { sequence: ['C','D','E'], fifths: 1 }).musicXml;
    expect(events(xml, 0).find(n => (n.pitch as any).step === 'F')!.pitch).toMatchObject({ alter: 1 });
  });

  it('uses the specified patterns and accent shifting in methods 3, 5 and 6', () => {
    const third = exercise(3).musicXml;
    for (let bar = 0; bar < 2; bar++) {
      expect(events(third, bar).map(finger)).toEqual([3,4,3,4,3,4,3,4]);
      events(third, bar).forEach(n => expect(marks(n)).toEqual(finger(n) === bar + 3 ? ['accent'] : []));
    }
    const fifth = exercise(5).musicXml;
    for (let bar = 0; bar < 3; bar++) {
      expect(events(fifth, bar).map(finger)).toEqual([3,4,3,4,3,4,3,4,3,4,3,4]);
      events(fifth, bar).forEach((n, i) => {
        expect(marks(n)).toEqual(i % 3 === bar ? ['accent'] : []);
        expect(n.durationQuarterNotes).toBeCloseTo(1 / 3, 5);
      });
    }
    expect((fifth.match(/<actual-notes>3<\/actual-notes>/g) ?? [])).toHaveLength(36);
    const sixth = exercise(6).musicXml;
    expect(events(sixth, 0).map(finger)).toEqual([3,4,5,4,3,4,5,4]);
    expect(events(sixth, 1).map(finger)).toEqual([5,4,3,4,5,4,3,4]);
    [0,1].flatMap(bar => events(sixth, bar)).forEach(n => expect(marks(n)).toEqual(finger(n) === 4 ? ['accent'] : []));
  });

  it.each([false, true])('routes the rules to AI, includes method 4 first, and exhausts all hand-specific methods (both=%s)', async both => {
    const analyze = vi.fn(async () => ({ analysis }));
    const service = new OpenAIService({ apiKey: 'test', model: 'test', transport: { probe: async () => {}, analyze } });
    const request = input({ both, fingers: true });
    let result = await service.analyze(request);
    expect(result.exercises[0].title).toContain('Holding Finger 3');
    if (both) expect(result.exercises[1].title).toContain('Left Hand: Holding Finger 3');
    const prepared = (analyze.mock.calls as unknown as Array<[string, AnalysisInput]>)[0][1];
    expect(prepared.czerny1Practice!.rules).toBe(rules);
    expect(prepared.octavePractice).toBeNull();
    const pairs = both ? 6 : 3;
    for (let i = 1; i < pairs; i++) {
      const previousAnalysisId = result.analysisId;
      result = await service.analyze({ ...request, previousAnalysisId });
      expect(await service.analyze({ ...request, previousAnalysisId })).toEqual(result);
    }
    expect(result.exerciseSets).toHaveLength(pairs);
    expect(new Set(result.exerciseSets.flatMap(s => s.exercises.map(e => e.title))).size).toBe(pairs * 2);
    expect(analyze).toHaveBeenCalledTimes(1);
    await expect(service.analyze({ ...request, previousAnalysisId: result.analysisId })).rejects.toMatchObject({ code: 'PRACTICE_METHODS_EXHAUSTED' });
    expect(result.exerciseSets).toHaveLength(pairs);
  });

  it('rejects unrelated AI notation rather than silently falling back to generic exercises', async () => {
    const service = new OpenAIService({ apiKey: 'test', model: 'test', transport: { probe: async () => {}, analyze: async () => ({ analysis, exercises: [] }) } });
    await expect(service.analyze(input())).rejects.toMatchObject({ code: 'OPENAI_INVALID_RESPONSE' });
  });
});
