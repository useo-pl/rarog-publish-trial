#!/usr/bin/env node
/**
 * Audyt tarballa paczki npm wobec manifestu budowania pakowacza (`scripts/package.mjs`):
 * `node scripts/package-audit.mjs [--files-only] [--name <nazwa>] [--version <wersja>] <tarball> <manifest>`.
 *
 * Kroki:
 * 1. manifest budowania: pola `name`, `version`, `sha256`, `integrity`, `files[]` (`path`, `size`, `sha256`);
 * 2. `--name` i `--version` wobec manifestu;
 * 3. sha256 tarballa i jego nazwa pliku = manifest;
 * 4. wpisy tarballa czytane wprost (gzip, nagłówki tar ustar i pax): tylko pliki zwykłe pod `package/` (tak zapisuje
 *    `npm pack`; katalog, dowiązanie i każdy inny typ to różnica), bez `..`, bez powtórzeń, suma kontrolna
 *    nagłówka; sha256 każdego pliku = manifest; `package/package.json` ma nazwę i wersję manifestu i nie wymienia
 *    SDK Anthropic w polach zależności;
 * 5. żadna ścieżka nie leży w `node_modules/@anthropic-ai/`;
 * 6. `npm pack --dry-run --json` czyta tarball: nazwa, wersja, `integrity`, liczba wpisów, rozmiar po rozpakowaniu,
 *    ścieżki i rozmiary plików = manifest.
 *
 * Wszystkie różnice idą na stderr naraz; uszkodzony gzip albo nagłówek tar przerywa audyt od razu.
 *
 * `--files-only` porównuje treść dwóch budowań tego samego drzewa (paczka pobrana z rejestru wobec budowania
 * lokalnego), w których bajty gzipa mogą się różnić: pomija sha256 i nazwę pliku tarballa oraz `integrity`.
 *
 * npm dostaje środowisko bez zmiennych `npm_*` wołającego, puste pliki w miejscu `~/.npmrc` i globalnego
 * `npmrc`, własny cache i pusty katalog roboczy. Kody wyjścia: 0 = zgodne, 1 = różnica albo błąd narzędzia
 * (lista różnic na stderr), 64 = złe wywołanie. Importy wyłącznie `node:*`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 64;
const SHA256 = /^[0-9a-f]{64}$/u;
const SDK_SCOPE = '@anthropic-ai/';
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies',
  'bundleDependencies'];
const MAX_UNPACKED = 1024 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024 * 1024;
const MAX_LISTED = 40;

const USAGE = `Użycie: node scripts/package-audit.mjs [--files-only] [--name <nazwa>] [--version <wersja>]
                                      <tarball> <manifest budowania>
  --files-only       tylko treść: bez sha256 i nazwy pliku tarballa oraz integrity
                     (inne budowanie tego samego drzewa)
  --name <nazwa>     oczekiwana nazwa paczki
  --version <wersja> oczekiwana wersja paczki
`;

/** Różnica albo błąd narzędzia (kod 1). */
class Refusal extends Error {}
/** Złe wywołanie (kod 64). */
class UsageError extends Error {}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'files-only': { type: 'boolean' },
        name: { type: 'string' },
        version: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (failure) {
    throw new UsageError(failure instanceof Error ? failure.message : String(failure));
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { help: true };
  if (positionals.length !== 2) throw new UsageError('oczekiwane dwa argumenty: tarball i manifest budowania');
  return {
    help: false,
    tarball: path.resolve(positionals[0]),
    manifest: path.resolve(positionals[1]),
    filesOnly: values['files-only'] === true,
    name: values.name,
    version: values.version,
  };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readFile(file, label) {
  try {
    return fs.readFileSync(file);
  } catch (failure) {
    throw new Refusal(`${label} ${file}: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
}

/** Krok 1: kształt manifestu budowania. */
function readManifest(file, filesOnly) {
  let manifest;
  try {
    manifest = JSON.parse(readFile(file, 'manifest').toString('utf8'));
  } catch (failure) {
    if (failure instanceof Refusal) throw failure;
    throw new Refusal(`manifest ${file}: to nie jest JSON`);
  }
  const problems = [];
  if (typeof manifest?.name !== 'string' || manifest.name === '') problems.push('brak pola name');
  if (typeof manifest?.version !== 'string' || manifest.version === '') problems.push('brak pola version');
  if (!filesOnly) {
    if (typeof manifest?.sha256 !== 'string' || !SHA256.test(manifest.sha256)) problems.push('pole sha256 złe');
    if (typeof manifest?.integrity !== 'string' || manifest.integrity === '') problems.push('brak pola integrity');
    if (typeof manifest?.tarball !== 'string' || manifest.tarball === '') problems.push('brak pola tarball');
  }
  if (!Array.isArray(manifest?.files) || manifest.files.length === 0) {
    problems.push('brak listy files');
  } else {
    manifest.files.forEach((entry, index) => {
      if (typeof entry?.path !== 'string' || entry.path === '' || !Number.isInteger(entry?.size) || entry.size < 0
        || typeof entry?.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
        problems.push(`files[${String(index)}]: oczekiwane path, size i sha256`);
      }
    });
  }
  if (problems.length > 0) throw new Refusal(`manifest ${file}:\n  ${problems.join('\n  ')}`);
  return manifest;
}

function cString(header, start, length) {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function octal(header, start, length, label) {
  const text = header.subarray(start, start + length).toString('latin1').replace(/[\0 ]+$/u, '').trim();
  if (!/^[0-7]+$/u.test(text)) throw new Refusal(`tarball: pole ${label} nagłówka tar to nie liczba ósemkowa`);
  return Number.parseInt(text, 8);
}

function checksumOk(header) {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
  return sum === octal(header, 148, 8, 'chksum');
}

/** Rekordy rozszerzonego nagłówka pax: `<długość> <klucz>=<wartość>\n`. */
function paxRecords(data) {
  const records = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = Number.parseInt(data.subarray(offset, space).toString('latin1'), 10);
    if (space === -1 || !Number.isInteger(length) || length <= 0 || offset + length > data.length) {
      throw new Refusal('tarball: uszkodzony nagłówek pax');
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals === -1) throw new Refusal('tarball: uszkodzony nagłówek pax');
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** Krok 5: wpisy tarballa (gzip + tar) bez rozpakowywania na dysk. */
function tarEntries(tarball) {
  let tar;
  try {
    tar = gunzipSync(tarball, { maxOutputLength: MAX_UNPACKED });
  } catch (failure) {
    throw new Refusal(`tarball: gunzip: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
  const entries = [];
  let pax = null;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      // Koniec archiwum to dwa zerowe bloki, a parser npm czyta dalej po pojedynczym: za pierwszym ma nie być nic.
      const tail = tar.subarray(offset);
      const extra = tail.findIndex((byte) => byte !== 0);
      if (extra !== -1) throw new Refusal(`tarball: dane za końcem archiwum (bajt ${String(offset + extra)})`);
      break;
    }
    if (!checksumOk(header)) throw new Refusal(`tarball: zła suma kontrolna nagłówka na bajcie ${String(offset)}`);
    const flag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = pax?.size === undefined ? octal(header, 124, 12, 'size') : Number(pax.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Refusal('tarball: zły rozmiar wpisu');
    const start = offset + 512;
    const data = tar.subarray(start, start + size);
    if (data.length !== size) throw new Refusal('tarball: wpis ucięty');
    offset = start + Math.ceil(size / 512) * 512;
    if (flag === 'x') {
      if (pax !== null) throw new Refusal('tarball: dwa nagłówki pax pod rząd');
      pax = paxRecords(data);
      continue;
    }
    // Pole prefix (bajty 345–499) ma tylko format POSIX ustar (`ustar\0` + `00`); GNU tar trzyma tam co innego.
    const posix = header.subarray(257, 265).toString('latin1') === 'ustar\u000000';
    const prefix = posix ? cString(header, 345, 155) : '';
    const name = cString(header, 0, 100);
    const entryPath = pax?.path ?? (prefix === '' ? name : `${prefix}/${name}`);
    const linkname = pax?.linkpath ?? cString(header, 157, 100);
    pax = null;
    entries.push({ flag, path: entryPath, linkname, data });
  }
  if (pax !== null) throw new Refusal('tarball: nagłówek pax bez wpisu');
  return entries;
}

/** Ścieżka wpisu względem `package/`, albo opis problemu. */
function packagePath(entryPath) {
  if (!entryPath.startsWith('package/')) return { problem: `${entryPath}: poza katalogiem package/` };
  const rel = entryPath.slice('package/'.length);
  if (rel === '' || rel.split('/').some((part) => part === '' || part === '.' || part === '..')
    || rel.includes('\\')) {
    return { problem: `${entryPath}: niedozwolona ścieżka` };
  }
  return { rel };
}

/** Środowisko npm: bez `npm_*` wołającego, z pustymi plikami konfiguracji i własnym cache. */
function npmEnv(work) {
  const user = path.join(work, 'empty-npmrc');
  const global = path.join(work, 'empty-global-npmrc');
  fs.writeFileSync(user, '');
  fs.writeFileSync(global, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/iu.test(name)));
  return {
    ...env,
    npm_config_userconfig: user,
    npm_config_globalconfig: global,
    npm_config_cache: path.join(work, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}

/** Krok 4: `npm pack --dry-run --json` na tarballu. */
function npmListing(tarballPath, work) {
  const cwd = path.join(work, 'cwd');
  fs.mkdirSync(cwd);
  const args = ['pack', '--dry-run', '--json', '--ignore-scripts', tarballPath];
  const result = spawnSync('npm', args, { cwd, env: npmEnv(work), encoding: 'utf8', maxBuffer: MAX_OUTPUT });
  if (result.error !== undefined) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    throw new Refusal(code === 'ENOENT' ? 'brak programu npm w PATH' : `npm: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim().split('\n').slice(-20).join('\n');
    throw new Refusal(`npm ${args.join(' ')} zakończył się kodem ${String(result.status)}:\n${output}`);
  }
  let listing;
  try {
    [listing] = JSON.parse(result.stdout);
  } catch {
    throw new Refusal('npm pack --dry-run --json nie dał JSON-a');
  }
  if (!Array.isArray(listing?.files)) throw new Refusal('npm pack --dry-run --json bez listy files');
  return listing;
}

function compareLists(label, expected, actual, problems) {
  const missing = [...expected.keys()].filter((file) => !actual.has(file)).sort();
  const extra = [...actual.keys()].filter((file) => !expected.has(file)).sort();
  const changed = [...expected].filter(([file, value]) => actual.has(file) && actual.get(file) !== value)
    .map(([file, value]) => `${file} (manifest ${String(value)}, ${label} ${String(actual.get(file))})`).sort();
  const show = (items) => (items.length > MAX_LISTED
    ? [...items.slice(0, MAX_LISTED), `… i ${String(items.length - MAX_LISTED)} więcej`]
    : items).join(', ');
  if (missing.length > 0) problems.push(`${label}: brak plików z manifestu: ${show(missing)}`);
  if (extra.length > 0) problems.push(`${label}: pliki spoza manifestu: ${show(extra)}`);
  if (changed.length > 0) problems.push(`${label}: inne wartości: ${show(changed)}`);
}

function audit(options) {
  const manifest = readManifest(options.manifest, options.filesOnly);
  const tarball = readFile(options.tarball, 'tarball');
  const problems = [];
  const id = `${manifest.name}@${manifest.version}`;
  if (options.name !== undefined && options.name !== manifest.name) {
    problems.push(`nazwa: oczekiwana ${options.name}, manifest ${manifest.name}`);
  }
  if (options.version !== undefined && options.version !== manifest.version) {
    problems.push(`wersja: oczekiwana ${options.version}, manifest ${manifest.version}`);
  }
  const tarballSha = sha256(tarball);
  if (!options.filesOnly) {
    if (tarballSha !== manifest.sha256) problems.push(`sha256 tarballa ${tarballSha}, manifest ${manifest.sha256}`);
    if (path.basename(options.tarball) !== manifest.tarball) {
      problems.push(`plik ${path.basename(options.tarball)}, manifest ${manifest.tarball}`);
    }
  }
  const expectedSizes = new Map(manifest.files.map((entry) => [entry.path, entry.size]));
  const expectedSha = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  if (expectedSizes.size !== manifest.files.length) problems.push('manifest: powtórzona ścieżka w files');

  const contents = new Map();
  let packageJson = null;
  for (const entry of tarEntries(tarball)) {
    if (entry.flag !== '0') {
      problems.push(`tarball: ${entry.path}: wpis typu ${entry.flag} (npm pack zapisuje tylko pliki zwykłe)`);
      continue;
    }
    // Rozpakowanie npm pomija plik zwykły z linkname, więc audyt liczyłby treść, której instalacja nie położy.
    if (entry.linkname !== '') {
      problems.push(`tarball: ${entry.path}: plik zwykły z linkname ${entry.linkname}`);
      continue;
    }
    const where = packagePath(entry.path);
    if (where.problem !== undefined) {
      problems.push(`tarball: ${where.problem}`);
      continue;
    }
    if (contents.has(where.rel)) {
      problems.push(`tarball: ${where.rel} powtórzony`);
      continue;
    }
    contents.set(where.rel, sha256(entry.data));
    if (where.rel === 'package.json') packageJson = entry.data;
  }
  compareLists('tarball sha256', expectedSha, contents, problems);
  const sdkPaths = [...contents.keys(), ...expectedSha.keys()]
    .filter((file) => file.split('/').some((part, index, parts) => part === 'node_modules'
      && `${parts[index + 1] ?? ''}/`.startsWith(SDK_SCOPE)));
  if (sdkPaths.length > 0) {
    problems.push(`SDK Anthropic w paczce: ${[...new Set(sdkPaths)].slice(0, MAX_LISTED).join(', ')}`);
  }
  if (packageJson === null) {
    problems.push('tarball: brak package/package.json');
  } else {
    let pkg = null;
    try {
      pkg = JSON.parse(packageJson.toString('utf8'));
    } catch {
      problems.push('tarball: package/package.json to nie JSON');
    }
    if (pkg !== null) {
      if (pkg.name !== manifest.name) problems.push(`package.json w tarballu: nazwa ${String(pkg.name)}`);
      if (pkg.version !== manifest.version) problems.push(`package.json w tarballu: wersja ${String(pkg.version)}`);
      for (const field of DEPENDENCY_FIELDS) {
        const value = pkg[field];
        const names = Array.isArray(value) ? value : Object.keys(value ?? {});
        for (const dep of names.filter((one) => typeof one === 'string' && one.startsWith(SDK_SCOPE))) {
          problems.push(`package.json w tarballu: ${dep} w ${field}`);
        }
      }
    }
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rarog-package-audit-'));
  try {
    const listing = npmListing(options.tarball, work);
    if (listing.name !== manifest.name) problems.push(`npm pack: nazwa ${String(listing.name)}`);
    if (listing.version !== manifest.version) problems.push(`npm pack: wersja ${String(listing.version)}`);
    if (!options.filesOnly && listing.integrity !== manifest.integrity) {
      problems.push(`npm pack: integrity ${String(listing.integrity)}, manifest ${String(manifest.integrity)}`);
    }
    for (const field of ['entryCount', 'unpackedSize']) {
      if (manifest[field] !== undefined && listing[field] !== manifest[field]) {
        problems.push(`npm pack: ${field} ${String(listing[field])}, manifest ${String(manifest[field])}`);
      }
    }
    const listed = new Map(listing.files.map((entry) => [entry.path, entry.size]));
    compareLists('npm pack', expectedSizes, listed, problems);
  } catch (failure) {
    if (!(failure instanceof Refusal)) throw failure;
    problems.push(failure.message);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  if (problems.length > 0) throw new Refusal(`${id} różni się od manifestu:\n  ${problems.join('\n  ')}`);
  return { id, files: contents.size, sha256: tarballSha };
}

function main(argv) {
  let options;
  try {
    options = parseCli(argv);
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    process.stderr.write(`package-audit.mjs: ${message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  try {
    const result = audit(options);
    process.stdout.write(`audyt: ${result.id}: ${String(result.files)} plików zgodnych z manifestem`
      + `${options.filesOnly ? ' (tylko treść)' : ''}, sha256 tarballa ${result.sha256}\n`);
    return EXIT_OK;
  } catch (failure) {
    if (failure instanceof Refusal) {
      process.stderr.write(`package-audit.mjs: odmowa: ${failure.message}\n`);
      return EXIT_REFUSED;
    }
    throw failure;
  }
}

process.exitCode = main(process.argv.slice(2));
