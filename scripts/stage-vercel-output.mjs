import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appRoot = path.join(repoRoot, 'FULL UI DESIGN');
const sourceNext = path.join(appRoot, '.next');
const stagedNext = path.join(repoRoot, '.next');
const sourceVercelOutput = path.join(appRoot, '.vercel', 'output');
const stagedVercelOutput = path.join(repoRoot, '.vercel', 'output');
const sourcePublic = path.join(appRoot, 'public');
const stagedPublic = path.join(repoRoot, 'public');

if (!fs.existsSync(sourceNext)) {
  throw new Error(`Missing Next.js build output: ${sourceNext}`);
}

fs.rmSync(stagedNext, { recursive: true, force: true });
fs.cpSync(sourceNext, stagedNext, { recursive: true });

if (fs.existsSync(sourceVercelOutput)) {
  fs.rmSync(stagedVercelOutput, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(stagedVercelOutput), { recursive: true });
  fs.cpSync(sourceVercelOutput, stagedVercelOutput, { recursive: true });
  console.log('Staged Vercel Build Output API artifacts to root .vercel/output.');
}

if (fs.existsSync(sourcePublic)) {
  fs.mkdirSync(stagedPublic, { recursive: true });
  fs.cpSync(sourcePublic, stagedPublic, { recursive: true, force: true });
}

console.log('Staged Full UI build output to root .next for Vercel.');
