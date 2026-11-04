#!/usr/bin/env node
/**
 * Pakowacz paczki próbnej: `node scripts/package.mjs [--out <katalog>] [--version <wersja>] [--name <nazwa>]`.
 * Kopia plików paczki do katalogu tymczasowego, `npm pack --json --ignore-scripts`, manifest budowania
 * `<tarball bez .tgz>.build.json` w kształcie, którego oczekuje `scripts/package-audit.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['bin/publish-trial.mjs', 'lib/report.mjs', 'LICENSE', 'README.md'];
const FIELDS = ['description', 'license', 'type', 'bin', 'engines', 'repository'];

const { values } = parseArgs({
  options: { out: { type: 'string' }, version: { type: 'string' }, name: { type: 'string' } },
  strict: true,
});
const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = { name: values.name ?? root.name, version: values.version ?? root.version };
for (const field of FIELDS) manifest[field] = root[field];
manifest.publishConfig = { access: 'public' };

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-trial-'));
try {
  const stage = path.join(work, 'stage');
  for (const rel of FILES) {
    fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(stage, rel));
  }
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const out = path.resolve(values.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'publish-trial-out-')));
  fs.mkdirSync(out, { recursive: true });
  const empty = path.join(work, 'empty-npmrc');
  fs.writeFileSync(empty, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/iu.test(key)));
  const result = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], {
    cwd: stage,
    encoding: 'utf8',
    env: { ...env, npm_config_userconfig: empty, npm_config_cache: path.join(work, 'cache'),
      npm_config_update_notifier: 'false' },
  });
  if (result.status !== 0) throw new Error(`npm pack: ${result.stderr}`);
  const [packed] = JSON.parse(result.stdout);
  const listed = packed.files.map((file) => file.path).sort();
  const expected = [...FILES, 'package.json'].sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) throw new Error(`npm pack wziął ${listed.join(', ')}`);
  const tarball = path.join(out, packed.filename);
  const record = {
    name: manifest.name,
    version: manifest.version,
    tarball: packed.filename,
    sha256: sha256(tarball),
    integrity: packed.integrity,
    size: packed.size,
    unpackedSize: packed.unpackedSize,
    entryCount: packed.entryCount,
    tools: { node: process.version, npm: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim() },
    files: listed.map((rel) => ({
      path: rel,
      size: fs.statSync(path.join(stage, rel)).size,
      sha256: sha256(path.join(stage, rel)),
    })),
  };
  const recordPath = path.join(out, packed.filename.replace(/\.tgz$/u, '.build.json'));
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`tarball:  ${tarball}\nsha256:   ${record.sha256}\nmanifest: ${recordPath}\n`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
