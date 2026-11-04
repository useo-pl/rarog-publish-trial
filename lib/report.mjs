/** Raport próby toru: nazwa i wersja paczki oraz komendy sprawdzenia jej atestacji w rejestrze npm. */
export function report(pkg) {
  const spec = `${pkg.name}@${pkg.version}`;
  const attestations = `https://registry.npmjs.org/-/npm/v1/attestations/${pkg.name.replace('/', '%2f')}@${pkg.version}`;
  return [
    `${spec}: próba toru wydania paczki npm Raroga działa.`,
    `Repo źródłowe: ${pkg.repository?.url ?? 'brak'}`,
    'Sprawdzenie atestacji tej wersji:',
    `  npm view ${spec} dist.attestations --json`,
    `  curl -fsS ${attestations}`,
  ];
}
