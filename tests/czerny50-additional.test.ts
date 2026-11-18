import { describe, it, expect } from 'vitest';
import { extractMeasureForAnalysis } from '../server/measure.js';
import { detectCzerny50Passage, generateCzerny50PracticeExercise, eligibleCzerny50Methods, materializeCzerny50PracticeAnalysis } from '../server/czerny50-practice.js';
import { CZERNY50_SCORE_FILENAME, getCzerny50PracticeRules } from '../server/czerny50-rules.js';
import type { Czerny50AnyMethodId } from '../server/czerny50-rules.js';
import { validateExerciseRhythm } from '../server/exercise-rhythm.js';
import { ruleExerciseChoice } from '../server/personalized-practice.js';
import { readBundledMusicXmlExport } from '../server/musescore.js';

function note(step: string, staff=1, octave=4, chord=false) {
  return `<note>${chord?'<chord/>':''}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>1</duration><voice>${staff}</voice><type>16th</type><staff>${staff}</staff><notations><technical><fingering>2</fingering></technical></notations></note>`;
}
function source(steps='CDEFGABC', left='') {
  const xml=`<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>${[...steps].map(s=>note(s)).join('')}${left?`<backup><duration>${steps.length}</duration></backup>${left}`:''}</measure></part></score-partwise>`;
  const measure=extractMeasureForAnalysis(xml,0);
  return {measure,context:detectCzerny50Passage(CZERNY50_SCORE_FILENAME,measure)!};
}
function generated(id:Czerny50AnyMethodId, data=source()) {
  const exercise=generateCzerny50PracticeExercise(id,data.context.passages[0],data.measure);
  validateExerciseRhythm(exercise.musicXml);
  const count=(exercise.musicXml.match(/<measure\b/g)||[]).length;
  const bars=Array.from({length:count},(_,i)=>extractMeasureForAnalysis(exercise.musicXml,i).parts[0]);
  const notes=bars.flatMap(b=>b.events.filter(e=>e.kind==='note'&&e.pitch));
  return {exercise,bars,notes};
}

describe('Czerny No. 50 additional teaching methods',()=>{
  it('retains original rules and appends numbered teaching references',()=>{
    const rules=getCzerny50PracticeRules();
    expect(rules.methods.map(m=>m.exerciseNumber)).toEqual([1,2,3,4,5,6]);
    expect(rules.additionalExercises.methods.map(m=>m.exerciseNumber)).toEqual([7,8,9,10,11,12]);
    // Word references are optional in CI because local teaching documents are gitignored.
  });
  it('keeps every pitch and finger in four-note groups with rests and valid 2/4 bars',()=>{
    const {exercise,notes}=generated('four-note-groups');
    expect(notes.map(n=>(n.pitch as {step:string}).step).join('')).toBe('CDEFGABC');
    expect(notes.every(n=>JSON.stringify(n.technical).includes('fingering'))).toBe(true);
    expect(exercise.musicXml).toContain('<rest/>');
    expect(exercise.musicXml).toContain('<beats>2</beats>');
  });
  it('expands through the entire nine-note passage, including its final odd remainder',()=>{
    const {notes}=generated('progressive-note-groups',source('CDEFGABCD'));
    expect(notes.map(n=>(n.pitch as {step:string}).step).join('')).toBe('CDEF'+'CDEFGA'+'CDEFGABC'+'CDEFGABCD');
  });
  it('limits eligibility by length and rejects an ineligible AI choice',()=>{
    const data=source('CDEF');
    expect(eligibleCzerny50Methods(data.context.passages[0],data.measure)).toEqual(['four-note-groups','four-note-accent-shifts','legato-and-staccato']);
    expect(()=>materializeCzerny50PracticeAnalysis({analysis:'These notes need careful control. Practice slowly with relaxed movements.',passageId:data.context.passages[0].id,methodIds:['progressive-note-groups','legato-and-staccato']},data.measure,data.context)).toThrow();
  });
  it('accents positions 1/5 and 2/6 without changing source durations',()=>{
    const {notes}=generated('four-note-accent-shifts');
    expect(notes.map((n,i)=>JSON.stringify(n.articulations??[]).includes('accent')?i:-1).filter(i=>i>=0)).toEqual([0,4,9,13]);
    expect(notes.every(n=>n.durationQuarterNotes===0.25)).toBe(true);
  });
  it('blocks only compact recognized triads, using no new pitches',()=>{
    const {exercise,notes}=generated('blocked-and-broken-chords',source('CEGCEG'));
    expect(notes.filter(n=>n.chord)).toHaveLength(4);
    expect(notes.slice(0,6).every(n=>!JSON.stringify(n.technical??[]).includes('fingering'))).toBe(true);
    expect(new Set(notes.map(n=>(n.pitch as {step:string}).step))).toEqual(new Set(['C','E','G']));
    expect(exercise.musicXml).toContain('<dot/>');
    const ambiguous=source('CDEFGABC');
    expect(eligibleCzerny50Methods(ambiguous.context.passages[0],ambiguous.measure)).not.toContain('blocked-and-broken-chords');
  });
  it('rejects a recognized chord with an uncomfortable spread',()=>{
    const data=source('CEGCEG');
    const n=data.measure.parts[0].events.find(n=>n.pitch&&(n.pitch as {step:string}).step==='G')!;
    (n.pitch as {octave:number}).octave=6;
    expect(eligibleCzerny50Methods(data.context.passages[0],data.measure)).not.toContain('blocked-and-broken-chords');
  });
  it('writes a legato slur then staccato without changing pitches or rhythms',()=>{
    const {exercise,notes}=generated('legato-and-staccato');
    expect(exercise.musicXml).toContain('<slur number="1" type="start"/>');
    expect(exercise.musicXml).toContain('<slur number="1" type="stop"/>');
    expect(notes.filter(n=>JSON.stringify(n.articulations??[]).includes('staccato'))).toHaveLength(8);
    expect(notes.every(n=>n.durationQuarterNotes===0.25)).toBe(true);
  });
  it('separates hands while preserving left-hand chords, rests and fingerings',()=>{
    const left=note('C',2,3)+note('G',2,3,true)+'<note><rest/><duration>7</duration><voice>2</voice><type>quarter</type><dot/><dot/><staff>2</staff></note>';
    const {exercise,notes}=generated('hands-separately',source('CDEFGABC',left));
    expect(notes.filter(n=>n.chord)).toHaveLength(1);
    expect(notes.map(n=>(n.pitch as {octave:number}).octave)).toEqual([...Array(8).fill(4),3,3]);
    expect(exercise.musicXml).toContain('<sign>F</sign>');
    expect(exercise.musicXml).toContain('Right hand only');
    expect(exercise.musicXml).toContain('Left hand only');
  });
  it('offers new methods for personalized analysis and retains two exercises',()=>{
    const data=source();
    const choice=ruleExerciseChoice({scoreId:'test',scoreFilename:CZERNY50_SCORE_FILENAME,scoreTitle:'Czerny',composer:'Czerny',measure:data.measure,czerny50Practice:data.context,difficulty:{category:'tempo'}});
    expect(choice?.candidates.some(c=>c.methodId==='four-note-groups')).toBe(true);
    const result=materializeCzerny50PracticeAnalysis({analysis:'These notes need careful control. Practice slowly with relaxed movements.',passageId:data.context.passages[0].id,methodIds:['four-note-groups','legato-and-staccato']},data.measure,data.context);
    expect(result.exercises).toHaveLength(2);
  });
  it('retains internal ties in a partially tied left-hand chord',()=>{
    const first=note('C',2,3).replace('<voice>','<tie type="start"/><voice>')+note('G',2,3,true);
    const second=note('C',2,3).replace('<voice>','<tie type="stop"/><voice>')+note('A',2,3,true);
    const {exercise}=generated('hands-separately',source('CDEFGABC',first+second));
    expect(exercise.musicXml.match(/<tie type="start"/g)).toHaveLength(1);
    expect(exercise.musicXml.match(/<tie type="stop"/g)).toHaveLength(1);
  });
  it('generates every eligible method from actual bundled No. 50 measure 1',async()=>{
    const asset=await readBundledMusicXmlExport('scores/Czerny_etude_50.mscz','scores/.musicxml-exports');
    const measure=extractMeasureForAnalysis(asset!.xml,0);
    const context=detectCzerny50Passage(CZERNY50_SCORE_FILENAME,measure)!;
    for(const method of eligibleCzerny50Methods(context.passages[0],measure)) {
      const result=generateCzerny50PracticeExercise(method,context.passages[0],measure);
      expect(()=>validateExerciseRhythm(result.musicXml)).not.toThrow();
    }
  });
});
