# common-passwords.txt — source, licence, derivation

Used by `password-policy.ts` (run 85, DEBT-574, D85.4) to refuse common passwords (ASVS 5.0 6.2.4).

## Source

- Project: SecLists, <https://github.com/danielmiessler/SecLists>
- Commit: `64b41f2156e1ae3edb592535c1b4b4dd0d6fe26a`
- File: `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt`
- URL: <https://raw.githubusercontent.com/danielmiessler/SecLists/64b41f2156e1ae3edb592535c1b4b4dd0d6fe26a/Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt>
- Size: 835 538 bytes, 99 840 lines; git blob `38eb37702244f55fda75cab281eb2145cd7685b6`
  (`git hash-object <file>`), checked on 2026-11-11 before the derivation.
- Downloaded once (2026-11-11) with the user's permission; the raw file is not committed.

## Licence and attribution

- SecLists is distributed under the MIT License (`LICENSE` of the repository at the commit above;
  licence id read from `api.github.com/repos/danielmiessler/SecLists/license`, tech-lead fold run 85).
- The list is the UK National Cyber Security Centre (NCSC) "100,000 most used passwords", derived
  from Have I Been Pwned's Pwned Passwords by Troy Hunt, published under the Creative Commons
  Attribution 4.0 International licence (CC BY 4.0). Attribution: NCSC, Have I Been Pwned.
  This file is an adaptation: entries filtered, normalised and truncated as described below.

## Derivation

```bash
node be/scripts/derive-common-passwords.mjs <raw 100k-most-used-passwords-NCSC.txt> be/src/modules/authentication/password-policy/common-passwords.txt
```

Rules (Node stdlib only, the input is read as text): split on `\n` and drop a trailing `\r`;
`normalize('NFKC')` then `toLowerCase()`; keep entries of length 8–128 (the password policy);
drop duplicates keeping the first, highest-ranked, occurrence; keep the first 10 000.

Result: 10 000 lines, LF, ending with `\n`, 98 395 bytes, all printable ASCII, lengths 8–26,
sha256 `97aba60cb9aefe33e0c247bd5dc2a5a2db0c487c1e615b7cc8122be00c472726`.

Refresh: DEBT-588 (pin a newer commit, re-run the script, update this file).
