import { XMLParser } from 'fast-xml-parser';
import { AppError } from './errors.js';
import { assertMusicXml } from './xml.js';

const MAX_MEASURE_EVENTS = 1_200;
const MAX_MEASURE_JSON_BYTES = 96 * 1024;

type OrderedNode = Record<string, unknown>;

interface PartIdentity {
  id: string;
  name: string;
  abbreviation?: string;
}

interface PartState {
  divisions: number;
  context: Record<string, unknown>;
}

export interface ExtractedMeasurePart {
  id: string;
  name: string;
  abbreviation?: string;
  measureNumber: string;
  implicit?: boolean;
  nonControlling?: boolean;
  startingContext: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  durationQuarterNotes: number;
}

export interface ExtractedMeasure {
  index: number;
  label: string;
  scoreFormat: 'partwise' | 'timewise';
  parts: ExtractedMeasurePart[];
}

const orderedParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  allowBooleanAttributes: true,
});

function elementName(node: OrderedNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@' && key !== '#text' && Array.isArray(node[key]));
}

function elementChildren(node: OrderedNode): OrderedNode[] {
  const name = elementName(node);
  const value = name ? node[name] : undefined;
  return Array.isArray(value) ? value as OrderedNode[] : [];
}

function childrenNamed(node: OrderedNode, name: string): OrderedNode[] {
  return elementChildren(node).filter((child) => elementName(child) === name);
}

function firstChild(node: OrderedNode, name: string): OrderedNode | undefined {
  return childrenNamed(node, name)[0];
}

function nodeAttributes(node: OrderedNode): Record<string, unknown> {
  const attributes = node[':@'];
  return attributes && typeof attributes === 'object' && !Array.isArray(attributes)
    ? attributes as Record<string, unknown>
    : {};
}

function attribute(node: OrderedNode, name: string): string | undefined {
  const value = nodeAttributes(node)[`@_${name}`];
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function nodeText(node: OrderedNode | undefined): string | undefined {
  if (!node) return undefined;
  const pieces: string[] = [];
  const visit = (candidate: OrderedNode) => {
    const text = candidate['#text'];
    if (typeof text === 'string' || typeof text === 'number') pieces.push(String(text));
    for (const child of elementChildren(candidate)) visit(child);
  };
  visit(node);
  const normalized = pieces.join(' ').replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function childText(node: OrderedNode, name: string): string | undefined {
  return nodeText(firstChild(node, name));
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function childNumber(node: OrderedNode, name: string): number | undefined {
  return finiteNumber(childText(node, name));
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function cleanObject(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function cleanAttributes(node: OrderedNode): Record<string, string> | undefined {
  const values = Object.fromEntries(
    Object.entries(nodeAttributes(node))
      .filter(([key, value]) => {
        if (typeof value !== 'string' && typeof value !== 'number') return false;
        const name = key.replace(/^@_/, '');
        return !/^(default-[xy]|relative-[xy]|color|font-(family|size|style|weight)|halign|valign|rotation)$/.test(name);
      })
      .map(([key, value]) => [key.replace(/^@_/, ''), String(value)]),
  );
  return Object.keys(values).length > 0 ? values : undefined;
}

function selectedAttributes(node: OrderedNode, names: string[]): Record<string, string> | undefined {
  const allowed = new Set(names);
  const values = Object.fromEntries(
    Object.entries(nodeAttributes(node))
      .map(([key, value]) => [key.replace(/^@_/, ''), value] as const)
      .filter(([key, value]) => allowed.has(key) && (typeof value === 'string' || typeof value === 'number'))
      .map(([key, value]) => [key, String(value)]),
  );
  return Object.keys(values).length > 0 ? values : undefined;
}

function descriptor(node: OrderedNode): Record<string, unknown> {
  const nested = elementChildren(node)
    .filter((child) => elementName(child) !== undefined)
    .map(descriptor);
  return cleanObject({
    name: elementName(node),
    value: nodeText(node),
    attributes: cleanAttributes(node),
    children: nested.length > 0 ? nested : undefined,
  });
}

function descriptors(node: OrderedNode | undefined): Array<Record<string, unknown>> {
  return node ? elementChildren(node).map(descriptor) : [];
}

function parseKey(node: OrderedNode): Record<string, unknown> {
  return cleanObject({
    staff: finiteNumber(attribute(node, 'number')),
    cancel: childNumber(node, 'cancel'),
    fifths: childNumber(node, 'fifths'),
    mode: childText(node, 'mode'),
    keySteps: childrenNamed(node, 'key-step').map((step) => nodeText(step)),
    keyAlters: childrenNamed(node, 'key-alter').map((alter) => finiteNumber(nodeText(alter))),
  });
}

function parseTime(node: OrderedNode): Record<string, unknown> {
  return cleanObject({
    staff: finiteNumber(attribute(node, 'number')),
    symbol: attribute(node, 'symbol'),
    senzaMisura: childText(node, 'senza-misura'),
    beats: childrenNamed(node, 'beats').map((beats) => nodeText(beats)),
    beatTypes: childrenNamed(node, 'beat-type').map((beatType) => nodeText(beatType)),
  });
}

function parseClef(node: OrderedNode): Record<string, unknown> {
  return cleanObject({
    staff: finiteNumber(attribute(node, 'number')),
    sign: childText(node, 'sign'),
    line: childNumber(node, 'line'),
    octaveChange: childNumber(node, 'clef-octave-change'),
  });
}

function parseTranspose(node: OrderedNode): Record<string, unknown> {
  return cleanObject({
    staff: finiteNumber(attribute(node, 'number')),
    diatonic: childNumber(node, 'diatonic'),
    chromatic: childNumber(node, 'chromatic'),
    octaveChange: childNumber(node, 'octave-change'),
    doubled: firstChild(node, 'double') ? true : undefined,
  });
}

function parseStaffDetails(node: OrderedNode): Record<string, unknown> {
  return cleanObject({
    staff: finiteNumber(attribute(node, 'number')),
    staffType: childText(node, 'staff-type'),
    staffLines: childNumber(node, 'staff-lines'),
    capo: childNumber(node, 'capo'),
    tunings: childrenNamed(node, 'staff-tuning').map((tuning) => cleanObject({
      line: finiteNumber(attribute(tuning, 'line')),
      step: childText(tuning, 'tuning-step'),
      alter: childNumber(tuning, 'tuning-alter'),
      octave: childNumber(tuning, 'tuning-octave'),
    })),
  });
}

function parseAttributes(node: OrderedNode): Record<string, unknown> {
  const keys = childrenNamed(node, 'key').map(parseKey);
  const times = childrenNamed(node, 'time').map(parseTime);
  const clefs = childrenNamed(node, 'clef').map(parseClef);
  const transpositions = childrenNamed(node, 'transpose').map(parseTranspose);
  const staffDetails = childrenNamed(node, 'staff-details').map(parseStaffDetails);
  const measureStyles = childrenNamed(node, 'measure-style').flatMap(descriptors);
  return cleanObject({
    divisions: childNumber(node, 'divisions'),
    staves: childNumber(node, 'staves'),
    keys: keys.length > 0 ? keys : undefined,
    times: times.length > 0 ? times : undefined,
    clefs: clefs.length > 0 ? clefs : undefined,
    transpositions: transpositions.length > 0 ? transpositions : undefined,
    staffDetails: staffDetails.length > 0 ? staffDetails : undefined,
    measureStyles: measureStyles.length > 0 ? measureStyles : undefined,
  });
}

function mergeStaffScopedContext(current: unknown, incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return incoming;
  const incomingRecords = incoming.filter((value): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  ));
  if (incomingRecords.some((value) => value.staff === undefined)) return incoming;

  const merged = Array.isArray(current)
    ? current.filter((value): value is Record<string, unknown> => (
      Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ))
    : [];
  for (const update of incomingRecords) {
    const existingIndex = merged.findIndex((value) => value.staff === update.staff);
    if (existingIndex >= 0) merged[existingIndex] = update;
    else merged.push(update);
  }
  return merged;
}

function applyAttributes(state: PartState, parsed: Record<string, unknown>) {
  const divisions = parsed.divisions;
  if (typeof divisions === 'number' && Number.isFinite(divisions) && divisions > 0) {
    state.divisions = divisions;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    state.context[key] = ['keys', 'times', 'clefs', 'transpositions', 'staffDetails'].includes(key)
      ? mergeStaffScopedContext(state.context[key], value)
      : value;
  }
  state.context.divisions = state.divisions;
}

function pitchFrom(node: OrderedNode | undefined): Record<string, unknown> | undefined {
  if (!node) return undefined;
  return cleanObject({
    step: childText(node, 'step'),
    alter: childNumber(node, 'alter'),
    octave: childNumber(node, 'octave'),
  });
}

function displayPitchFrom(node: OrderedNode | undefined): Record<string, unknown> | undefined {
  if (!node) return undefined;
  return cleanObject({
    step: childText(node, 'display-step'),
    octave: childNumber(node, 'display-octave'),
  });
}

function notationMarks(notations: OrderedNode | undefined, container: string): Array<Record<string, unknown>> | undefined {
  const marks = childrenNamed(notations ?? {}, container).flatMap(descriptors);
  return marks.length > 0 ? marks : undefined;
}

function directNotationMarks(notations: OrderedNode | undefined, name: string): Array<Record<string, unknown>> | undefined {
  const marks = childrenNamed(notations ?? {}, name).map(descriptor);
  return marks.length > 0 ? marks : undefined;
}

function parseNote(
  node: OrderedNode,
  state: PartState,
  order: number,
  onsetQuarterNotes: number,
): Record<string, unknown> {
  const notations = firstChild(node, 'notations');
  const pitch = pitchFrom(firstChild(node, 'pitch'));
  const unpitched = displayPitchFrom(firstChild(node, 'unpitched'));
  const restNode = firstChild(node, 'rest');
  const graceNode = firstChild(node, 'grace');
  const durationDivisions = childNumber(node, 'duration') ?? 0;
  const durationQuarterNotes = durationDivisions / state.divisions;
  const timeModification = firstChild(node, 'time-modification');
  const notehead = firstChild(node, 'notehead');
  const performanceAttributes = selectedAttributes(node, [
    'dynamics',
    'end-dynamics',
    'attack',
    'release',
    'time-only',
    'pizzicato',
    'print-object',
  ]);
  const ties = [
    ...childrenNamed(node, 'tie').map(descriptor),
    ...childrenNamed(notations ?? {}, 'tied').map(descriptor),
  ];

  return cleanObject({
    kind: 'note',
    order,
    onsetQuarterNotes: rounded(onsetQuarterNotes),
    durationQuarterNotes: rounded(durationQuarterNotes),
    durationDivisions,
    divisions: state.divisions,
    voice: childText(node, 'voice') ?? '1',
    staff: childNumber(node, 'staff') ?? 1,
    chord: Boolean(firstChild(node, 'chord')),
    cue: Boolean(firstChild(node, 'cue')),
    grace: graceNode ? cleanObject({
      slash: attribute(graceNode, 'slash'),
      stealTimePrevious: finiteNumber(attribute(graceNode, 'steal-time-previous')),
      stealTimeFollowing: finiteNumber(attribute(graceNode, 'steal-time-following')),
      makeTime: finiteNumber(attribute(graceNode, 'make-time')),
    }) : undefined,
    rest: restNode ? cleanObject({
      measure: attribute(restNode, 'measure') === 'yes',
      displayPitch: displayPitchFrom(restNode),
    }) : undefined,
    pitch,
    unpitched,
    type: childText(node, 'type'),
    dots: childrenNamed(node, 'dot').length,
    accidental: childText(node, 'accidental'),
    stem: childText(node, 'stem'),
    notehead: notehead ? cleanObject({
      value: nodeText(notehead),
      attributes: cleanAttributes(notehead),
    }) : undefined,
    beams: childrenNamed(node, 'beam').map((beam) => cleanObject({
      number: finiteNumber(attribute(beam, 'number')),
      value: nodeText(beam),
    })),
    timeModification: timeModification ? cleanObject({
      actualNotes: childNumber(timeModification, 'actual-notes'),
      normalNotes: childNumber(timeModification, 'normal-notes'),
      normalType: childText(timeModification, 'normal-type'),
      normalDots: childrenNamed(timeModification, 'normal-dot').length,
    }) : undefined,
    ties: ties.length > 0 ? ties : undefined,
    articulations: notationMarks(notations, 'articulations'),
    ornaments: notationMarks(notations, 'ornaments'),
    technical: notationMarks(notations, 'technical'),
    dynamics: notationMarks(notations, 'dynamics'),
    slurs: directNotationMarks(notations, 'slur'),
    tuplets: directNotationMarks(notations, 'tuplet'),
    fermatas: directNotationMarks(notations, 'fermata'),
    arpeggiates: directNotationMarks(notations, 'arpeggiate'),
    glissandi: [
      ...childrenNamed(notations ?? {}, 'glissando').map(descriptor),
      ...childrenNamed(notations ?? {}, 'slide').map(descriptor),
    ],
    instrument: attribute(firstChild(node, 'instrument') ?? {}, 'id'),
    performance: performanceAttributes,
  });
}

function parseDirection(node: OrderedNode, order: number, onset: number): Record<string, unknown> {
  const directionTypes = childrenNamed(node, 'direction-type').flatMap(descriptors);
  const sound = firstChild(node, 'sound');
  return cleanObject({
    kind: 'direction',
    order,
    onsetQuarterNotes: rounded(onset),
    placement: attribute(node, 'placement'),
    voice: childText(node, 'voice'),
    staff: childNumber(node, 'staff'),
    types: directionTypes,
    sound: sound ? cleanAttributes(sound) : undefined,
  });
}

function parseHarmony(node: OrderedNode, order: number, onset: number): Record<string, unknown> {
  const root = firstChild(node, 'root');
  const bass = firstChild(node, 'bass');
  return cleanObject({
    kind: 'harmony',
    order,
    onsetQuarterNotes: rounded(onset),
    staff: childNumber(node, 'staff'),
    root: root ? cleanObject({ step: childText(root, 'root-step'), alter: childNumber(root, 'root-alter') }) : undefined,
    harmonyKind: childText(node, 'kind'),
    inversion: childNumber(node, 'inversion'),
    bass: bass ? cleanObject({ step: childText(bass, 'bass-step'), alter: childNumber(bass, 'bass-alter') }) : undefined,
    degrees: childrenNamed(node, 'degree').map((degree) => cleanObject({
      value: childNumber(degree, 'degree-value'),
      alter: childNumber(degree, 'degree-alter'),
      type: childText(degree, 'degree-type'),
    })),
  });
}

function parseBarline(node: OrderedNode, order: number, onset: number): Record<string, unknown> {
  const repeat = firstChild(node, 'repeat');
  const ending = firstChild(node, 'ending');
  return cleanObject({
    kind: 'barline',
    order,
    onsetQuarterNotes: rounded(onset),
    location: attribute(node, 'location'),
    style: childText(node, 'bar-style'),
    repeat: repeat ? cleanAttributes(repeat) : undefined,
    ending: ending ? cleanObject({ value: nodeText(ending), attributes: cleanAttributes(ending) }) : undefined,
    fermatas: childrenNamed(node, 'fermata').map(descriptor),
  });
}

function updateStateFromMeasure(state: PartState, measure: OrderedNode) {
  for (const child of elementChildren(measure)) {
    if (elementName(child) === 'attributes') applyAttributes(state, parseAttributes(child));
  }
}

function extractPartMeasure(
  measure: OrderedNode,
  identity: PartIdentity,
  state: PartState,
  fallbackLabel: string,
): ExtractedMeasurePart {
  const startingContext = { ...state.context, divisions: state.divisions };
  const events: Array<Record<string, unknown>> = [];
  let cursorQuarterNotes = 0;
  let lastNonChordOnset = 0;
  let furthestQuarterNote = 0;
  let order = 0;

  for (const child of elementChildren(measure)) {
    const name = elementName(child);
    if (!name) continue;
    order += 1;

    if (name === 'attributes') {
      const parsed = parseAttributes(child);
      applyAttributes(state, parsed);
      events.push(cleanObject({
        kind: 'attributes',
        order,
        onsetQuarterNotes: rounded(cursorQuarterNotes),
        ...parsed,
      }));
      continue;
    }

    if (name === 'backup' || name === 'forward') {
      const durationDivisions = childNumber(child, 'duration') ?? 0;
      const durationQuarterNotes = durationDivisions / state.divisions;
      const from = cursorQuarterNotes;
      cursorQuarterNotes += name === 'backup' ? -durationQuarterNotes : durationQuarterNotes;
      events.push({
        kind: name,
        order,
        voice: childText(child, 'voice'),
        staff: childNumber(child, 'staff'),
        durationDivisions,
        durationQuarterNotes: rounded(durationQuarterNotes),
        fromQuarterNotes: rounded(from),
        toQuarterNotes: rounded(cursorQuarterNotes),
      });
      furthestQuarterNote = Math.max(furthestQuarterNote, cursorQuarterNotes);
      continue;
    }

    if (name === 'note') {
      const isChord = Boolean(firstChild(child, 'chord'));
      const onset = isChord ? lastNonChordOnset : cursorQuarterNotes;
      const note = parseNote(child, state, order, onset);
      events.push(note);
      if (!isChord) {
        lastNonChordOnset = onset;
        const duration = typeof note.durationQuarterNotes === 'number' ? note.durationQuarterNotes : 0;
        cursorQuarterNotes += duration;
      }
      furthestQuarterNote = Math.max(furthestQuarterNote, onset + (
        typeof note.durationQuarterNotes === 'number' ? note.durationQuarterNotes : 0
      ));
      continue;
    }

    if (name === 'direction') {
      const offset = (childNumber(child, 'offset') ?? 0) / state.divisions;
      events.push(parseDirection(child, order, cursorQuarterNotes + offset));
      continue;
    }

    if (name === 'harmony') {
      const offset = (childNumber(child, 'offset') ?? 0) / state.divisions;
      events.push(parseHarmony(child, order, cursorQuarterNotes + offset));
      continue;
    }

    if (name === 'barline') {
      events.push(parseBarline(child, order, cursorQuarterNotes));
      continue;
    }

    if (name === 'sound') {
      events.push(cleanObject({
        kind: 'sound',
        order,
        onsetQuarterNotes: rounded(cursorQuarterNotes),
        attributes: cleanAttributes(child),
      }));
    }
  }

  return cleanObject({
    id: identity.id,
    name: identity.name,
    abbreviation: identity.abbreviation,
    measureNumber: attribute(measure, 'number') ?? fallbackLabel,
    implicit: attribute(measure, 'implicit') === 'yes' ? true : undefined,
    nonControlling: attribute(measure, 'non-controlling') === 'yes' ? true : undefined,
    startingContext,
    events,
    durationQuarterNotes: rounded(furthestQuarterNote),
  }) as unknown as ExtractedMeasurePart;
}

function partIdentities(root: OrderedNode): Map<string, PartIdentity> {
  const result = new Map<string, PartIdentity>();
  const partList = firstChild(root, 'part-list');
  for (const scorePart of childrenNamed(partList ?? {}, 'score-part')) {
    const id = attribute(scorePart, 'id');
    if (!id) continue;
    result.set(id, cleanObject({
      id,
      name: childText(scorePart, 'part-name') ?? id,
      abbreviation: childText(scorePart, 'part-abbreviation'),
    }) as unknown as PartIdentity);
  }
  return result;
}

function identityFor(id: string, identities: Map<string, PartIdentity>): PartIdentity {
  return identities.get(id) ?? { id, name: id };
}

function parseOrderedRoot(xml: string): { root: OrderedNode; format: 'partwise' | 'timewise' } {
  assertMusicXml(xml);
  let document: unknown;
  try {
    document = orderedParser.parse(xml);
  } catch (error) {
    throw new AppError(422, 'INVALID_MUSICXML', 'The score could not be prepared for analysis.', { cause: error });
  }
  const nodes = Array.isArray(document) ? document as OrderedNode[] : [];
  const root = nodes.find((node) => ['score-partwise', 'score-timewise'].includes(elementName(node) ?? ''));
  if (!root) {
    throw new AppError(422, 'INVALID_MUSICXML', 'The score does not contain an analyzable MusicXML document.');
  }
  return { root, format: elementName(root) === 'score-timewise' ? 'timewise' : 'partwise' };
}

function extractPartwise(root: OrderedNode, index: number): ExtractedMeasure {
  const identities = partIdentities(root);
  const extracted: ExtractedMeasurePart[] = [];

  for (const part of childrenNamed(root, 'part')) {
    const id = attribute(part, 'id') ?? `part-${extracted.length + 1}`;
    const measures = childrenNamed(part, 'measure');
    const selected = measures[index];
    if (!selected) continue;
    const state: PartState = { divisions: 1, context: { divisions: 1 } };
    for (let measureIndex = 0; measureIndex < index; measureIndex += 1) {
      updateStateFromMeasure(state, measures[measureIndex]);
    }
    extracted.push(extractPartMeasure(selected, identityFor(id, identities), state, String(index + 1)));
  }

  if (extracted.length === 0) {
    throw new AppError(404, 'MEASURE_NOT_FOUND', 'That measure is not present in this score. Reselect it and try again.');
  }
  return {
    index,
    label: extracted[0].measureNumber,
    scoreFormat: 'partwise',
    parts: extracted,
  };
}

function extractTimewise(root: OrderedNode, index: number): ExtractedMeasure {
  const measures = childrenNamed(root, 'measure');
  const selected = measures[index];
  if (!selected) {
    throw new AppError(404, 'MEASURE_NOT_FOUND', 'That measure is not present in this score. Reselect it and try again.');
  }
  const identities = partIdentities(root);
  const states = new Map<string, PartState>();
  for (let measureIndex = 0; measureIndex < index; measureIndex += 1) {
    for (const part of childrenNamed(measures[measureIndex], 'part')) {
      const id = attribute(part, 'id') ?? 'unknown-part';
      const state = states.get(id) ?? { divisions: 1, context: { divisions: 1 } };
      updateStateFromMeasure(state, part);
      states.set(id, state);
    }
  }

  const fallbackLabel = attribute(selected, 'number') ?? String(index + 1);
  const parts = childrenNamed(selected, 'part').map((part, partIndex) => {
    const id = attribute(part, 'id') ?? `part-${partIndex + 1}`;
    const state = states.get(id) ?? { divisions: 1, context: { divisions: 1 } };
    return extractPartMeasure(part, identityFor(id, identities), state, fallbackLabel);
  });
  if (parts.length === 0) {
    throw new AppError(422, 'EMPTY_MEASURE', 'That measure does not contain any score parts to analyze.');
  }
  return { index, label: fallbackLabel, scoreFormat: 'timewise', parts };
}

export function extractMeasureForAnalysis(
  xml: string,
  index: number,
  expectedLabel?: string,
): ExtractedMeasure {
  if (!Number.isSafeInteger(index) || index < 0 || index > 100_000) {
    throw new AppError(400, 'INVALID_MEASURE', 'The measure reference must be a non-negative whole number.');
  }
  const { root, format } = parseOrderedRoot(xml);
  const measure = format === 'partwise' ? extractPartwise(root, index) : extractTimewise(root, index);

  if (expectedLabel !== undefined) {
    const normalizedExpected = expectedLabel.trim();
    if (!normalizedExpected || normalizedExpected.length > 40) {
      throw new AppError(400, 'INVALID_MEASURE_LABEL', 'The measure label is invalid.');
    }
    // Printed labels can differ from MusicXML @number (pickups, repeats, suffixes).
    // The validated zero-based index remains authoritative; this display value is never used for lookup.
  }

  const eventCount = measure.parts.reduce((total, part) => total + part.events.length, 0);
  const serializedBytes = Buffer.byteLength(JSON.stringify(measure), 'utf8');
  if (eventCount > MAX_MEASURE_EVENTS || serializedBytes > MAX_MEASURE_JSON_BYTES) {
    throw new AppError(413, 'MEASURE_TOO_COMPLEX', 'This measure is too complex to analyze in one request.');
  }
  return measure;
}
