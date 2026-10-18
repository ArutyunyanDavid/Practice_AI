import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(currentDirectory, '..');
const scoresDirectory = path.resolve(process.env.SCORES_DIR ?? path.join(projectDirectory, 'scores'));
const cacheDirectory = path.resolve(process.env.SCORE_CACHE_DIR ?? path.join(projectDirectory, '.cache', 'scores'));
const distDirectory = path.resolve(projectDirectory, 'dist');
const port = Number(process.env.PORT ?? 8787);

const { app } = createApp({
  scoresDirectory,
  cacheDirectory,
  distDirectory,
  museScorePath: process.env.MUSESCORE_PATH,
});

app.listen(port, () => {
  console.log(`Practice Studio API: http://localhost:${port}`);
  console.log(`Watching scores: ${scoresDirectory}`);
});
