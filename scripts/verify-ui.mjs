import { chromium } from 'playwright-core';
import path from 'node:path';
import process from 'node:process';

const baseUrl = process.env.PRACTICE_STUDIO_URL ?? 'http://localhost:5173';
const executablePath = process.env.BROWSER_PATH
  ?? (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : undefined);

const SCORE_TITLE = 'Transcendental Étude No. 2 (Molto Vivace)';
const COMPOSER = 'Franz Liszt';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function jsonBody(value) {
  return JSON.stringify(value);
}

function exerciseMusicXml(marker, exerciseNumber) {
  const pitchSets = {
    Baseline: exerciseNumber === 1 ? ['C', 'D', 'E', 'F'] : ['G', 'A', 'B', 'C'],
    Newest: exerciseNumber === 1 ? ['F', 'A', 'C', 'F'] : ['D', 'G', 'B', 'D'],
    Stale: exerciseNumber === 1 ? ['A', 'B', 'C', 'D'] : ['E', 'F', 'G', 'A'],
  };
  const pitches = pitchSets[marker] ?? ['C', 'E', 'G', 'C'];
  const singleLine = (octave, fingering) => pitches.map((step, index) => [
    '<note>',
    `<pitch><step>${step}</step><octave>${index === 3 && step === 'C' ? octave + 1 : octave}</octave></pitch>`,
    '<duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff>',
    `<notations><technical><fingering>${fingering}</fingering></technical></notations>`,
    '</note>',
  ].join('')).join('');
  const octaveLine = (octave, staff) => pitches.map((step) => [
    '<note>',
    `<pitch><step>${step}</step><octave>${octave}</octave></pitch>`,
    `<duration>4</duration><voice>${staff}</voice><type>quarter</type><staff>${staff}</staff>`,
    '</note>',
    '<note><chord/>',
    `<pitch><step>${step}</step><octave>${octave + 1}</octave></pitch>`,
    `<duration>4</duration><voice>${staff}</voice><type>quarter</type><staff>${staff}</staff>`,
    '</note>',
  ].join('')).join('');

  const measures = exerciseNumber === 1
    ? [
        '<measure number="1" implicit="yes">',
        '<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>',
        '<clef><sign>G</sign><line>2</line></clef></attributes>',
        '<direction placement="above"><direction-type><words>Finger five only</words></direction-type></direction>',
        singleLine(6, 5),
        '</measure>',
        '<measure number="2" implicit="yes"><print new-system="yes"/>',
        '<direction placement="above"><direction-type><words>Thumb only</words></direction-type></direction>',
        singleLine(5, 1),
        '</measure>',
      ].join('')
    : [
        '<measure number="1" implicit="yes">',
        '<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>',
        '<staves>2</staves>',
        '<clef number="1"><sign>G</sign><line>2</line></clef>',
        '<clef number="2"><sign>F</sign><line>4</line></clef></attributes>',
        octaveLine(5, 1),
        '<backup><duration>16</duration></backup>',
        octaveLine(2, 2),
        '</measure>',
      ].join('');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<score-partwise version="4.0">',
    `<work><work-title>${marker} exercise ${exerciseNumber}</work-title></work>`,
    '<part-list><score-part id="P1"><part-name>Practice Exercise</part-name></score-part></part-list>',
    `<part id="P1">${measures}</part></score-partwise>`,
  ].join('');
}

function analysisPayload(requestDetails, marker) {
  const exercises = [1, 2].map((number) => ({
    title: `${marker} exercise ${number}`,
    explanationSentences: [
      `${marker} target ${number} uses the selected musical material.`,
      `${marker} practice ${number} repeats the notated pattern evenly.`,
    ],
    musicXml: exerciseMusicXml(marker, number),
  }));

  return {
    requestId: requestDetails.body.requestId,
    analysis: {
      scoreId: requestDetails.scoreId,
      scoreTitle: SCORE_TITLE,
      composer: COMPOSER,
      measure: {
        index: requestDetails.measureIndex,
        label: requestDetails.responseMeasureLabel,
      },
      analysis: `${marker} technical analysis for measure ${requestDetails.responseMeasureLabel}.`,
      exercises,
      model: 'gpt-5-mini-ui-test',
      reasoningEffort: 'max',
      generatedAt: new Date(Date.UTC(2026, 9, 17, 12, 0, requestDetails.sequence)).toISOString(),
    },
  };
}

async function installAiMocks(targetPage) {
  const queuedAnalyses = [];
  const unexpectedRequests = [];
  let connectionTestRequests = 0;
  let analysisRequestCount = 0;

  await targetPage.route('**/api/ai/status', async (route) => {
    if (route.request().method() !== 'GET') {
      unexpectedRequests.push(`${route.request().method()} ${route.request().url()}`);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: jsonBody({
        status: 'not_configured',
        model: null,
        reasoningEffort: 'max',
        message: 'Add OPENAI_API_KEY and OPENAI_MODEL to the private .env file, then restart the server.',
      }),
    });
  });

  await targetPage.route('**/api/ai/test', async (route) => {
    connectionTestRequests += 1;
    const failed = connectionTestRequests === 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: jsonBody(failed
        ? {
            status: 'connection_failed',
            model: 'gpt-5-mini-ui-test',
            reasoningEffort: 'max',
            message: 'The mocked OpenAI connection test failed safely.',
          }
        : {
            status: 'connected',
            model: 'gpt-5-mini-ui-test',
            reasoningEffort: 'max',
            message: 'The mocked server connection is healthy.',
          }),
    });
  });

  await targetPage.route('**/api/scores/*/measures/*/analyze', async (route) => {
    analysisRequestCount += 1;
    const request = route.request();
    const match = new URL(request.url()).pathname.match(
      /^\/api\/scores\/([^/]+)\/measures\/(\d+)\/analyze$/,
    );
    let body = {};
    try {
      const postData = request.postData();
      body = postData ? JSON.parse(postData) : {};
    } catch {
      // The assertion below will provide a focused error for malformed JSON.
    }

    const details = {
      sequence: analysisRequestCount,
      method: request.method(),
      scoreId: match ? decodeURIComponent(match[1]) : '',
      measureIndex: match ? Number(match[2]) : Number.NaN,
      body,
    };
    const plan = queuedAnalyses.shift();

    if (!plan) {
      unexpectedRequests.push(`Unplanned analysis request: ${request.method()} ${request.url()}`);
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: jsonBody({ error: { code: 'UNPLANNED_TEST_REQUEST', message: 'No mocked response was queued.' } }),
      });
      return;
    }

    details.responseMeasureLabel = body.measureLabel ?? plan.measure?.label ?? String(details.measureIndex + 1);
    plan.startedDeferred.resolve(details);
    const outcome = await plan.outcomeDeferred.promise;
    if (outcome.kind === 'success') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: jsonBody(analysisPayload(details, outcome.marker)),
      });
    } else {
      await route.fulfill({
        status: outcome.status,
        contentType: 'application/json',
        headers: outcome.retryAfter ? { 'Retry-After': outcome.retryAfter } : {},
        body: jsonBody({ error: { code: outcome.code, message: outcome.message } }),
      });
    }
    plan.completedDeferred.resolve();
  });

  return {
    queueAnalysis(measure) {
      const startedDeferred = deferred();
      const outcomeDeferred = deferred();
      const completedDeferred = deferred();
      queuedAnalyses.push({ measure, startedDeferred, outcomeDeferred, completedDeferred });
      return {
        started: startedDeferred.promise,
        completed: completedDeferred.promise,
        succeed(marker) {
          outcomeDeferred.resolve({ kind: 'success', marker });
        },
        fail(status, code, message, retryAfter) {
          outcomeDeferred.resolve({ kind: 'failure', status, code, message, retryAfter });
        },
      };
    },
    get analysisRequestCount() {
      return analysisRequestCount;
    },
    get connectionTestRequests() {
      return connectionTestRequests;
    },
    get queuedAnalysisCount() {
      return queuedAnalyses.length;
    },
    unexpectedRequests,
  };
}

async function waitForCount(locator, expected, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let actual = await locator.count();
  while (actual !== expected && Date.now() < deadline) {
    await locator.page().waitForTimeout(50);
    actual = await locator.count();
  }
  assert(actual === expected, `${message} Expected ${expected}, found ${actual}.`);
}

async function assertSelectedMeasure(assistant, expectedIndex) {
  const chips = assistant.locator('[data-selected-measure]');
  await waitForCount(chips, 1, 'Exactly one measure should be selected.');
  const index = Number(await chips.first().getAttribute('data-selected-measure'));
  const label = (await chips.first().innerText()).trim();
  if (expectedIndex !== undefined) {
    assert(index === expectedIndex, `Expected selected measure index ${expectedIndex}, found ${index}.`);
  }
  return { index, label };
}

async function assertNoSelection(page, assistant) {
  await waitForCount(assistant.locator('[data-selected-measure]'), 0, 'The measure selection was not cleared.');
  await waitForCount(
    page.locator('[data-score-page]:visible img[id^="cursorImg"]:visible'),
    0,
    'The visual measure highlight was not cleared.',
  );
}

async function assertOneHighlight(page, pageNumber) {
  await waitForCount(
    page.locator(`[data-score-page="${pageNumber}"] img[id^="cursorImg"]:visible`),
    1,
    `Expected one highlighted measure on score page ${pageNumber}.`,
  );
}

async function assertAnalysis(assistant, marker, measure) {
  const panel = assistant.getByTestId('measure-analysis');
  await waitForCount(panel, 1, 'The Practice Assistant must show one analysis panel.');
  await panel.getByText(`${marker} technical analysis for measure ${measure.label}.`, { exact: true }).waitFor();
  await panel.getByText(`Measure ${measure.label}`, { exact: true }).waitFor();
  await panel.getByText(SCORE_TITLE, { exact: true }).waitFor();

  const exercises = panel.getByTestId('practice-exercise');
  await waitForCount(exercises, 2, 'AI analysis must contain exactly two exercises.');
  for (let index = 0; index < 2; index += 1) {
    const exerciseNumber = index + 1;
    const exercise = exercises.nth(index);
    await exercise.getByText(`${marker} exercise ${exerciseNumber}`, { exact: true }).waitFor();
    const sentences = exercise.getByTestId('exercise-explanation-sentence');
    await waitForCount(sentences, 2, `Exercise ${exerciseNumber} must show exactly two sentences.`);
    await exercise.getByText(`${marker} target ${exerciseNumber} uses the selected musical material.`, { exact: true }).waitFor();
    await exercise.getByText(`${marker} practice ${exerciseNumber} repeats the notated pattern evenly.`, { exact: true }).waitFor();
  }

  const notationRoots = panel.getByTestId('exercise-notation');
  await waitForCount(notationRoots, 2, 'Exactly two exercise notation viewers must be present.');
  await waitForCount(panel.getByTestId('exercise-notation-error'), 0, 'An exercise notation viewer failed.');
  for (let index = 0; index < 2; index += 1) {
    const notation = notationRoots.nth(index);
    await notation.locator('svg').waitFor({ state: 'visible', timeout: 20_000 });
    assert(await notation.locator('g.vf-measure').count() > 0, `Exercise ${index + 1} has no rendered measure.`);
    assert(await notation.locator('path').count() > 0, `Exercise ${index + 1} has no rendered notation paths.`);
    assert(!(await notation.innerText()).includes('<score-partwise'), 'Raw MusicXML was displayed to the user.');
  }
  return notationRoots.evaluateAll((nodes) => nodes.map((node) => node.querySelector('svg')?.innerHTML ?? ''));
}

function assertRequestMatchesSelection(details, selection) {
  assert(details.method === 'POST', `Expected an analysis POST, received ${details.method}.`);
  assert(
    details.measureIndex === selection.index,
    `Analyze captured measure index ${details.measureIndex}; expected ${selection.index}.`,
  );
  if (details.body.measureLabel !== undefined) {
    assert(
      details.body.measureLabel === selection.label,
      `Analyze captured measure label ${details.body.measureLabel}; expected ${selection.label}.`,
    );
  }
  assert(
    typeof details.body.requestId === 'string' && /^request-\d+$/.test(details.body.requestId),
    'The analysis request did not include a valid client request identifier.',
  );
  assert(details.scoreId.length > 0, 'The analysis request did not include a score ID.');
}

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const browserErrors = [];
let expectedRateLimitConsoleErrors = 0;

page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (message.text().includes('status of 429 (Too Many Requests)')) {
    // Chromium reports intentionally mocked non-2xx fetches in the console.
    expectedRateLimitConsoleErrors += 1;
    return;
  }
  browserErrors.push(`console: ${message.text()}`);
});

try {
  const aiMocks = await installAiMocks(page);

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: SCORE_TITLE, exact: true }).first().waitFor({ timeout: 120_000 });
  await page.locator('[data-score-page="1"] svg').waitFor({ state: 'visible', timeout: 120_000 });
  await page.getByText('Click a measure to begin').waitFor({ state: 'visible', timeout: 120_000 });

  const desktopAssistant = page.getByTestId('desktop-assistant');
  await desktopAssistant.getByText('Not Configured', { exact: true }).waitFor();
  await desktopAssistant.getByText('OPENAI_API_KEY', { exact: true }).waitFor();
  await desktopAssistant.getByText('.env', { exact: true }).waitFor();

  const testConnectionButton = desktopAssistant.getByRole('button', { name: 'Test AI Connection' });
  await testConnectionButton.click();
  await desktopAssistant.getByText('Connection Failed', { exact: true }).waitFor();
  await testConnectionButton.click();
  await desktopAssistant.getByText('Connected', { exact: true }).waitFor();
  assert(aiMocks.connectionTestRequests === 2, 'The connection-test button did not issue exactly one request per click.');

  const measures = page.locator('.score-canvas g.vf-measure');
  const measureCount = await measures.count();
  assert(
    measureCount >= 50,
    `Expected a complex piano score with at least 50 rendered staff-measures, found ${measureCount}.`,
  );

  const indicator = page.getByTestId('page-indicator');
  const indicatorText = (await indicator.innerText()).replace(/\s+/g, ' ').trim();
  const pageCountMatch = indicatorText.match(/^Page 1 of (\d+)$/);
  assert(pageCountMatch && Number(pageCountMatch[1]) >= 2, `Expected a multi-page score, found "${indicatorText}".`);
  const pageCount = Number(pageCountMatch[1]);

  const previousPage = page.getByRole('button', { name: 'Previous page' });
  const nextPage = page.getByRole('button', { name: 'Next page' });
  assert(await previousPage.isDisabled(), 'Previous-page navigation should be disabled on page 1.');
  assert(!(await nextPage.isDisabled()), 'Next-page navigation should be enabled on page 1.');

  const visiblePages = page.locator('[data-score-page]:visible');
  await waitForCount(visiblePages, 1, 'Exactly one score page should be visible.');
  const firstPageBounds = await page.locator('[data-score-page="1"]').boundingBox();
  assert(
    firstPageBounds && firstPageBounds.width <= 900 && firstPageBounds.height <= 1250,
    `The desktop score page is larger than the compact layout allows: ${JSON.stringify(firstPageBounds)}.`,
  );

  const layout = await page.evaluate(() => {
    const score = document.querySelector('main');
    const assistant = document.querySelector('[data-testid="desktop-assistant"]');
    const scoreWidth = score?.getBoundingClientRect().width ?? 0;
    const assistantWidth = assistant?.getBoundingClientRect().width ?? 0;
    return {
      scoreWidth,
      assistantWidth,
      scoreFraction: scoreWidth / (scoreWidth + assistantWidth),
      assistantFraction: assistantWidth / (scoreWidth + assistantWidth),
    };
  });
  assert(
    layout.scoreFraction >= 0.57 && layout.scoreFraction <= 0.63
      && layout.assistantFraction >= 0.37 && layout.assistantFraction <= 0.43,
    `Expected an approximately 60/40 score-to-assistant layout, found ${JSON.stringify(layout)}.`,
  );

  const zoomLabel = page.locator('header span').filter({ hasText: /%$/ });
  const initialZoom = Number.parseInt((await zoomLabel.innerText()).trim(), 10);
  assert(initialZoom >= 55 && initialZoom <= 70, `Expected a compact default zoom, found ${initialZoom}%.`);

  const firstPageMeasureIds = await page.locator('[data-score-page="1"] g.vf-measure').evaluateAll((nodes) => [
    ...new Set(nodes.map((node) => node.id).filter(Boolean)),
  ]);

  await nextPage.click();
  await page.getByText(`Page 2 of ${pageCount}`, { exact: false }).waitFor();
  await page.locator('[data-score-page="2"] svg').waitFor({ state: 'visible' });
  await waitForCount(visiblePages, 1, 'Page 2 did not become the sole visible score page.');
  assert(!(await previousPage.isDisabled()), 'Previous-page navigation should be enabled on page 2.');

  const secondPageMeasureIds = await page.locator('[data-score-page="2"] g.vf-measure').evaluateAll((nodes) => [
    ...new Set(nodes.map((node) => node.id).filter(Boolean)),
  ]);
  assert(secondPageMeasureIds.length >= 3, 'Could not identify enough rendered measures on page 2.');
  assert(secondPageMeasureIds[0] !== firstPageMeasureIds[0], 'Page 2 repeated the first page of music.');

  async function clickMeasure(id) {
    const pageMeasures = page.locator('[data-score-page="2"] g.vf-measure');
    const targetIndex = await pageMeasures.evaluateAll(
      (nodes, expectedId) => nodes.findIndex((node) => node.id === expectedId),
      id,
    );
    assert(targetIndex >= 0, `Could not find rendered measure ${id}.`);
    const target = pageMeasures.nth(targetIndex);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert(box, `Rendered measure ${id} has no clickable bounds.`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }

  async function clearFromOutside() {
    await desktopAssistant.getByRole('heading', { name: 'Practice Assistant' }).click();
    await assertNoSelection(page, desktopAssistant);
  }

  // Resolve three different source measures even when a piano score renders
  // multiple staff-level SVG groups for the same musical measure.
  const distinctMeasures = [];
  const sourceIndexes = new Set();
  for (const id of secondPageMeasureIds) {
    if (distinctMeasures.length >= 3) break;
    if (await desktopAssistant.locator('[data-selected-measure]').count()) await clearFromOutside();
    await clickMeasure(id);
    const selected = await assertSelectedMeasure(desktopAssistant);
    if (!sourceIndexes.has(selected.index)) {
      sourceIndexes.add(selected.index);
      distinctMeasures.push({ ...selected, id });
    }
  }
  assert(distinctMeasures.length === 3, 'Could not resolve three distinct source measures on page 2.');
  await clearFromOutside();
  const [measureA, measureB, measureC] = distinctMeasures;

  // A new measure replaces the old selection; clicking it again toggles it off.
  await clickMeasure(measureA.id);
  await assertSelectedMeasure(desktopAssistant, measureA.index);
  await assertOneHighlight(page, 2);
  await clickMeasure(measureB.id);
  await assertSelectedMeasure(desktopAssistant, measureB.index);
  await assertOneHighlight(page, 2);
  await clickMeasure(measureB.id);
  await assertNoSelection(page, desktopAssistant);

  // Any non-measure click clears selection.
  await clickMeasure(measureA.id);
  await assertSelectedMeasure(desktopAssistant, measureA.index);
  await clearFromOutside();

  // Zooming, scrolling, and page navigation preserve the single logical selection.
  await clickMeasure(measureA.id);
  await assertSelectedMeasure(desktopAssistant, measureA.index);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByText(`${initialZoom + 10}%`, { exact: true }).waitFor();
  await assertSelectedMeasure(desktopAssistant, measureA.index);
  await assertOneHighlight(page, 2);

  const scoreViewport = page.locator('main');
  const scrollState = await scoreViewport.evaluate((element) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.min(100, maxScrollTop);
    return {
      overflowY: getComputedStyle(element).overflowY,
      scrollTop: element.scrollTop,
      maxScrollTop,
    };
  });
  assert(scrollState.overflowY === 'auto', `The score viewport is not scrollable: ${JSON.stringify(scrollState)}.`);
  await assertSelectedMeasure(desktopAssistant, measureA.index);
  await assertOneHighlight(page, 2);

  await page.getByRole('button', { name: 'Reset zoom' }).click();
  await page.getByText(`${initialZoom}%`, { exact: true }).waitFor();
  await assertSelectedMeasure(desktopAssistant, measureA.index);
  await assertOneHighlight(page, 2);

  await previousPage.click();
  await page.locator('[data-score-page="1"] svg').waitFor({ state: 'visible' });
  await assertSelectedMeasure(desktopAssistant, measureA.index);
  await nextPage.click();
  await page.locator('[data-score-page="2"] svg').waitFor({ state: 'visible' });
  await assertSelectedMeasure(desktopAssistant, measureA.index);
  await assertOneHighlight(page, 2);
  assert(aiMocks.analysisRequestCount === 0, 'Selecting, zooming, or navigating triggered AI analysis implicitly.');

  // Pointer-down captures the intended measure before the Analyze button's
  // document-level click clears the visual selection.
  const baselinePlan = aiMocks.queueAnalysis(measureA);
  await desktopAssistant.getByRole('button', { name: 'Analyze Measure' }).click();
  const baselineRequest = await baselinePlan.started;
  assertRequestMatchesSelection(baselineRequest, measureA);
  await assertNoSelection(page, desktopAssistant);
  await desktopAssistant.getByText(`Analyzing measure ${measureA.label}`, { exact: true }).waitFor();

  // Re-selecting the same in-flight measure disables duplicate submission;
  // deselecting it does not cancel the request.
  await clickMeasure(measureA.id);
  await assertSelectedMeasure(desktopAssistant, measureA.index);
  const duplicateButton = desktopAssistant.getByRole('button', { name: /Analysis in progress/ });
  assert(await duplicateButton.isDisabled(), 'An in-flight measure could be submitted twice.');
  assert(aiMocks.analysisRequestCount === 1, 'A duplicate analysis request was sent.');
  await clearFromOutside();

  baselinePlan.succeed('Baseline');
  await baselinePlan.completed;
  const baselineNotation = await assertAnalysis(desktopAssistant, 'Baseline', measureA);
  await waitForCount(page.locator('[data-testid="measure-analysis"]:visible'), 1, 'Only one analysis panel should be visible.');

  // A completed analysis remains after a later selection and outside-click deselection.
  await clickMeasure(measureA.id);
  await assertSelectedMeasure(desktopAssistant, measureA.index);
  await assertAnalysis(desktopAssistant, 'Baseline', measureA);
  await clearFromOutside();
  await assertAnalysis(desktopAssistant, 'Baseline', measureA);

  // A failed replacement keeps the successful analysis and presents a useful error.
  await clickMeasure(measureB.id);
  await assertSelectedMeasure(desktopAssistant, measureB.index);
  await assertAnalysis(desktopAssistant, 'Baseline', measureA);
  const failurePlan = aiMocks.queueAnalysis(measureB);
  await desktopAssistant.getByRole('button', { name: 'Analyze Measure' }).click();
  const failureRequest = await failurePlan.started;
  assertRequestMatchesSelection(failureRequest, measureB);
  await desktopAssistant.getByText(`Analyzing measure ${measureB.label}`, { exact: true }).waitFor();
  await assertAnalysis(desktopAssistant, 'Baseline', measureA);
  failurePlan.fail(429, 'OPENAI_RATE_LIMITED', 'Mocked rate limit.', '17');
  await failurePlan.completed;
  const failureAlert = desktopAssistant.getByRole('alert');
  await failureAlert.getByText('Analysis was not replaced', { exact: true }).waitFor();
  await failureAlert.getByText(/request limit was reached.*17 seconds/i).waitFor();
  await assertAnalysis(desktopAssistant, 'Baseline', measureA);

  // Keep the prior result during overlapping requests, let the newest request
  // replace it, then prove the older response cannot overwrite the new result.
  await clickMeasure(measureB.id);
  const stalePlan = aiMocks.queueAnalysis(measureB);
  await desktopAssistant.getByRole('button', { name: 'Analyze Measure' }).click();
  const staleRequest = await stalePlan.started;
  assertRequestMatchesSelection(staleRequest, measureB);
  await desktopAssistant.getByText(`Analyzing measure ${measureB.label}`, { exact: true }).waitFor();
  await assertAnalysis(desktopAssistant, 'Baseline', measureA);

  await clickMeasure(measureC.id);
  await assertSelectedMeasure(desktopAssistant, measureC.index);
  const newestPlan = aiMocks.queueAnalysis(measureC);
  await desktopAssistant.getByRole('button', { name: 'Analyze Measure' }).click();
  const newestRequest = await newestPlan.started;
  assertRequestMatchesSelection(newestRequest, measureC);
  await assertNoSelection(page, desktopAssistant);
  await desktopAssistant.getByText(`Analyzing measure ${measureC.label}`, { exact: true }).waitFor();
  await assertAnalysis(desktopAssistant, 'Baseline', measureA);

  newestPlan.succeed('Newest');
  await newestPlan.completed;
  const newestNotation = await assertAnalysis(desktopAssistant, 'Newest', measureC);
  assert(
    JSON.stringify(newestNotation) !== JSON.stringify(baselineNotation),
    'The new analysis did not replace the previous exercise notation.',
  );
  await waitForCount(desktopAssistant.getByText('Baseline technical analysis', { exact: false }), 0, 'The old analysis was not replaced.');
  await waitForCount(desktopAssistant.getByRole('alert'), 0, 'A successful request did not clear the prior error.');

  stalePlan.succeed('Stale');
  await stalePlan.completed;
  await page.waitForTimeout(150);
  const notationAfterStaleResponse = await assertAnalysis(desktopAssistant, 'Newest', measureC);
  assert(
    JSON.stringify(notationAfterStaleResponse) === JSON.stringify(newestNotation),
    'A stale response replaced the newest exercise notation.',
  );
  await waitForCount(desktopAssistant.getByText('Stale technical analysis', { exact: false }), 0, 'A stale response overwrote the newest analysis.');
  assert(aiMocks.analysisRequestCount === 4, `Expected four controlled analysis requests, found ${aiMocks.analysisRequestCount}.`);
  assert(aiMocks.queuedAnalysisCount === 0, 'A mocked analysis response was queued but never requested.');
  assert(aiMocks.unexpectedRequests.length === 0, aiMocks.unexpectedRequests.join('\n'));
  assert(expectedRateLimitConsoleErrors <= 1, 'More than one rate-limited resource request reached the browser.');

  await page.screenshot({ path: path.resolve('.cache/viewer.png'), fullPage: false });

  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.getByRole('heading', { name: 'Liszt, ready for focused work.' }).waitFor();
  await page.getByRole('heading', { name: SCORE_TITLE, exact: true }).waitFor();
  const libraryCards = page.locator('main article');
  await waitForCount(libraryCards, 1, 'The library must show only the featured Liszt score.');
  await page.screenshot({ path: path.resolve('.cache/library.png'), fullPage: true });

  const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  mobilePage.on('pageerror', (mobileError) => browserErrors.push(`mobile pageerror: ${mobileError.message}`));
  mobilePage.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`mobile console: ${message.text()}`);
  });
  const mobileAiMocks = await installAiMocks(mobilePage);
  await mobilePage.goto(baseUrl, { waitUntil: 'networkidle' });
  await mobilePage.locator('[data-score-page="1"] svg').waitFor({ state: 'visible', timeout: 120_000 });
  const mobileLayout = await mobilePage.evaluate(() => {
    const header = document.querySelector('header');
    const main = document.querySelector('main');
    const scorePage = document.querySelector('[data-score-page="1"]');
    return {
      headerFits: Boolean(header && header.scrollWidth <= header.clientWidth),
      mainFits: Boolean(main && main.scrollWidth <= main.clientWidth),
      pageWidth: scorePage?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY,
      viewportWidth: main?.clientWidth ?? 0,
    };
  });
  assert(
    mobileLayout.headerFits && mobileLayout.mainFits && mobileLayout.pageWidth <= mobileLayout.viewportWidth,
    `The compact mobile reader overflows: ${JSON.stringify(mobileLayout)}.`,
  );
  await mobilePage.getByRole('button', { name: 'Next page' }).click();
  await mobilePage.locator('[data-score-page="2"] svg').waitFor({ state: 'visible' });
  await mobilePage.waitForFunction(() => (
    document.querySelector('[data-testid="page-indicator"]')?.textContent?.includes('2 of')
  ));
  await mobilePage.getByRole('button', { name: 'Show practice assistant' }).waitFor();
  await mobilePage.screenshot({ path: path.resolve('.cache/viewer-mobile.png'), fullPage: false });
  await mobilePage.getByRole('button', { name: 'Show practice assistant' }).click();
  const mobileAssistant = mobilePage.getByTestId('mobile-assistant');
  await mobileAssistant.getByRole('heading', { name: 'Practice Assistant' }).waitFor();
  await mobileAssistant.getByText('Not Configured', { exact: true }).waitFor();
  const mobileAssistantBounds = await mobileAssistant.boundingBox();
  assert(
    mobileAssistantBounds && mobileAssistantBounds.width <= 390,
    `The mobile assistant exceeds the viewport: ${JSON.stringify(mobileAssistantBounds)}.`,
  );
  assert(mobileAiMocks.unexpectedRequests.length === 0, mobileAiMocks.unexpectedRequests.join('\n'));
  await mobilePage.close();

  if (browserErrors.length > 0) {
    throw new Error(`Browser errors detected:\n${browserErrors.join('\n')}`);
  }

  console.log(JSON.stringify({
    ok: true,
    score: SCORE_TITLE,
    renderedStaffMeasures: measureCount,
    pages: pageCount,
    layout: {
      scorePercent: Math.round(layout.scoreFraction * 100),
      assistantPercent: Math.round(layout.assistantFraction * 100),
    },
    analyzedMeasures: [measureA.label, measureB.label, measureC.label],
    mockedAnalysisRequests: aiMocks.analysisRequestCount,
    verified: [
      'connection states',
      'single-measure selection',
      'outside-click deselection',
      'zoom and navigation preservation',
      'analyze intent capture',
      'analysis persistence',
      'failure preservation',
      'newest-response replacement',
      'stale-response suppression',
      'exactly two complete exercises',
      'two OSMD-rendered exercise scores',
      'responsive mobile layout',
    ],
    screenshots: ['.cache/library.png', '.cache/viewer.png', '.cache/viewer-mobile.png'],
  }, null, 2));
} finally {
  await browser.close();
}
