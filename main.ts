// Driver for the marked-faster entry. The harness runs `node /bot/main.ts`
// (Node 22, types stripped natively). It reads every case from
// /input/cases.json (or $MAKEFUN_INPUT_DIR), renders each one alone with
// parse() from parse.js, and writes /output/html.json (or
// $MAKEFUN_OUTPUT_DIR): a JSON array of the HTML strings, one per case, in
// the cases' order.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases: Case[] = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
