#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { report } from '../lib/report.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
process.stdout.write(`${report(pkg).join('\n')}\n`);
