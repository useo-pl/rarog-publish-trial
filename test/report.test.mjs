import assert from 'node:assert/strict';
import { test } from 'node:test';
import { report } from '../lib/report.mjs';

test('raport podaje wersję i komendy atestacji', () => {
  const pkg = { name: '@rarog/publish-trial', version: '1.2.3', repository: { url: 'https://x.test/r' } };
  const lines = report(pkg);
  assert.match(lines[0], /^@rarog\/publish-trial@1\.2\.3: /u);
  assert.ok(lines.includes('  npm view @rarog/publish-trial@1.2.3 dist.attestations --json'));
  assert.ok(lines.at(-1)?.endsWith('/-/npm/v1/attestations/@rarog%2fpublish-trial@1.2.3'));
});
