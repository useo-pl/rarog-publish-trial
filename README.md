# @rarog/publish-trial

Paczka próbna toru wydania paczki npm Raroga. Sprawdza na prawdziwym rejestrze to, czego nie da się sprawdzić
lokalnie: workflow publikacji z repo publicznego, `npm stage publish` z tokenem OIDC trusted publishera,
zatwierdzenie z 2FA, atestację (provenance) i podpisy rejestru.

Polecenie `rarog-publish-trial` drukuje nazwę i wersję paczki oraz komendy sprawdzenia atestacji tej wersji.
Workflow `.github/workflows/publish.yml` i audyt `scripts/package-audit.mjs` są kopiami plików repo Raroga;
różni się tylko nazwa paczki. Paczka znika z rejestru po próbie (`npm unpublish` w ciągu 72 godzin).
