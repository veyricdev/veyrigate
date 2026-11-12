#!/usr/bin/env bash
# Restore an encrypted backup into a NEW database (run 87, DEBT-253, D87.10; runbook-ops section 4b).
#   ops/backup/mongo-restore.sh <file.archive.gz.gpg> <src-db> <dst-db>
# Refuses (exit != 0, BEFORE any connection): an option such as --drop, dst == src, an invalid name, a missing
# manifest, a manifest of another db, a sha256 that does not match the manifest, and an archive that is not signed
# by the pinned backup-host key (a full decrypt+verify pass to /dev/null, so nothing reaches mongorestore unless
# VALIDSIG names BACKUP_SIGNER_FPR; DEBT-617). Then refuses a dst that already exists (checked on the server). Restores with nsFrom/nsTo (never over a live db) and requires the final
# "N document(s) restored successfully. 0 document(s) failed" with N = manifest totalDocuments.
# Env:
#   MONGO_RESTORE_CONFIG  mongorestore --config file (YAML `uri: ...`, 0600; the `restore` user). Host path.
#   MONGO_URI             alternative WITHOUT credentials (refused if it contains `@`).
#   MONGORESTORE          default `mongorestore`; drill: `docker exec -i veyrigate-mongo mongorestore`.
#   MONGOSH               default `mongosh`; drill: `docker exec -i veyrigate-mongo mongosh`. The URI is sent on
#                         stdin, never on argv.
#   GPG                   default `gpg`; the private key + passphrase are held by two people (D87.5). The keyring
#                         also holds the backup host's PUBLIC signing key.
#   BACKUP_SIGNER_FPR     pinned fingerprint (40 hex) of the backup host's signing key (runbook-ops section 4).
set -euo pipefail
umask 077

die() {
  echo "mongo-restore: $*" >&2
  exit 1
}
for a in "$@"; do
  case "$a" in -*) die "options are not accepted (no --drop: always restore into a new database)" ;; esac
done
[ "$#" -eq 3 ] || die "usage: mongo-restore.sh <file.archive.gz.gpg> <src-db> <dst-db>"
FILE="$1"
SRC="$2"
DST="$3"
NAME_RE='^[A-Za-z0-9_-]{1,63}$'
[[ "$SRC" =~ $NAME_RE ]] || die "invalid src db name"
[[ "$DST" =~ $NAME_RE ]] || die "invalid dst db name"
[ "$SRC" != "$DST" ] || die "dst must differ from src (restore into a new database)"
[ -r "$FILE" ] || die "backup file is not readable"
MANIFEST="$FILE.manifest.json"
[ -r "$MANIFEST" ] || die "manifest $MANIFEST is missing"
field() { sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\)\"\{0,1\}[,}].*/\1/p" "$MANIFEST" | head -n1; }
[ "$(sed -n 's/^{"db":"\([^"]*\)".*/\1/p' "$MANIFEST")" = "$SRC" ] || die "the manifest is for another database"
WANT_SHA="$(field sha256)"
TOTAL="$(field totalDocuments)"
[[ "$WANT_SHA" =~ ^[0-9a-f]{64}$ ]] && [[ "$TOTAL" =~ ^[0-9]+$ ]] || die "manifest is malformed"
[ "$(sha256sum "$FILE" | cut -d' ' -f1)" = "$WANT_SHA" ] || die "sha256 does not match the manifest: refusing to restore"
SIGNER="$(printf '%s' "${BACKUP_SIGNER_FPR:-}" | tr -d ' ' | tr 'a-f' 'A-F')"
[[ "$SIGNER" =~ ^[0-9A-F]{40}$ ]] || die "set BACKUP_SIGNER_FPR to the pinned fingerprint of the backup signing key"
read -r -a GPG_CMD <<<"${GPG:-gpg}"
STATUS="$(mktemp)"
LOG="$(mktemp)"
trap 'rm -f "$STATUS" "$LOG"' EXIT
# 0 when gpg decrypted the archive AND a good signature of the pinned key covers it.
signed_by_pin() {
  grep -q '^\[GNUPG:\] DECRYPTION_OKAY' "$STATUS" &&
    ! grep -qE '^\[GNUPG:\] (BADSIG|ERRSIG|EXPKEYSIG|REVKEYSIG|DECRYPTION_FAILED)' "$STATUS" &&
    awk '$2 == "VALIDSIG" { print $3; print $NF }' "$STATUS" | grep -qx "$SIGNER"
}
"${GPG_CMD[@]}" --quiet --status-file "$STATUS" --decrypt "$FILE" >/dev/null 2>&1 || true
signed_by_pin || die "the archive is not signed by the pinned backup key (or does not decrypt): refusing to restore"

if [ -n "${MONGO_RESTORE_CONFIG:-}" ]; then
  [ -z "${MONGO_URI:-}" ] || die "set MONGO_RESTORE_CONFIG or MONGO_URI, not both"
  [ -r "$MONGO_RESTORE_CONFIG" ] || die "MONGO_RESTORE_CONFIG is not readable"
  URI="$(sed -n 's/^uri:[[:space:]]*["'\'']\{0,1\}\([^"'\'']*\)["'\'']\{0,1\}[[:space:]]*$/\1/p' "$MONGO_RESTORE_CONFIG" | head -n1)"
  [ -n "$URI" ] || die "no uri: line in MONGO_RESTORE_CONFIG"
  CONN=(--config="$MONGO_RESTORE_CONFIG")
elif [ -n "${MONGO_URI:-}" ]; then
  case "$MONGO_URI" in *@*) die "MONGO_URI must not carry credentials: use MONGO_RESTORE_CONFIG" ;; esac
  URI="$MONGO_URI"
  CONN=(--uri="$MONGO_URI")
else
  die "set MONGO_RESTORE_CONFIG (production) or MONGO_URI without credentials"
fi
read -r -a RESTORE <<<"${MONGORESTORE:-mongorestore}"
read -r -a SH <<<"${MONGOSH:-mongosh}"

# dst must not exist. The script (with the URI) goes over stdin; a quote in the URI is refused.
case "$URI$DST" in *\'* | *\\*) die "unsupported character in the URI" ;; esac
EXISTS="$(printf "const c = connect('%s'); print(c.adminCommand({ listDatabases: 1, nameOnly: true }).databases.some((x) => x.name === '%s') ? 'exists' : 'absent');\n" "$URI" "$DST" |
  "${SH[@]}" --nodb --quiet /dev/stdin 2>/dev/null | tr -d '\r' | grep -E '^(exists|absent)$' || true)"
[ "$EXISTS" = absent ] || die "dst database already exists or the server is unreachable (${EXISTS:-no answer}): refusing"

# gpg detects a broken MDC/AEAD tag (or a bad signature) only at the END of the stream, after mongorestore has
# already written: any failure here leaves $DST partially written.
PARTIAL="$DST may be partially written: do NOT use it, drop it (db.getSiblingDB('$DST').dropDatabase())"
"${GPG_CMD[@]}" --quiet --status-file "$STATUS" --decrypt "$FILE" |
  "${RESTORE[@]}" "${CONN[@]}" --archive --gzip --nsInclude="${SRC}.*" --nsFrom="${SRC}.*" --nsTo="${DST}.*" 2>"$LOG" ||
  die "decryption or mongorestore failed: $PARTIAL"
signed_by_pin || die "the signature check failed on the restore pass (file changed?): $PARTIAL"
LAST="$(tr -d '\r' <"$LOG" | grep -E 'document\(s\) restored successfully' | tail -n1)"
[[ "$LAST" =~ ([0-9]+)\ document\(s\)\ restored\ successfully\.\ ([0-9]+)\ document\(s\)\ failed ]] ||
  die "no restore summary line"
RESTORED="${BASH_REMATCH[1]}"
FAILED="${BASH_REMATCH[2]}"
[ "$FAILED" = 0 ] && [ "$RESTORED" = "$TOTAL" ] ||
  die "restored $RESTORED documents ($FAILED failed), manifest says $TOTAL: $PARTIAL"
echo "mongo-restore: ok $SRC -> $DST ($RESTORED documents, 0 failed)"
