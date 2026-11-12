#!/usr/bin/env bash
# Encrypted logical backup of ONE app database (run 87, DEBT-253, D87.2/D87.5/D87.7/D87.8/D87.10).
#   ops/backup/mongo-backup.sh <db> <out-dir>
# Env:
#   MONGO_BACKUP_CONFIG  mongodump --config file (YAML `uri: ...`, mode 0600) - production: the URI with the
#                        `backup` user and readPreference=secondary never appears on argv. Read by mongodump itself,
#                        so it must be a host path (database tools on the backup host).
#   MONGO_URI            alternative WITHOUT credentials (refused if it contains `@`), e.g. a local drill.
#   BACKUP_PUBKEY        armored PUBLIC key of the backup recipient (the host never holds the private key).
#   BACKUP_SIGN_KEY      fingerprint (40 hex) of this backup host's own SIGNING key, in its GNUPGHOME (DEBT-617): the
#                        restore refuses an archive not signed by that pinned key (origin, not only secrecy).
#   MONGODUMP            dump command, word-split (default `mongodump`; drill: `docker exec veyrigate-mongo mongodump`).
#   GPG                  default `gpg` (GnuPG >= 2.3 to restore an AEAD packet).
#   BACKUP_TEXTFILE_DIR  optional node_exporter textfile dir: metric written only after EVERY step succeeded.
# Output (only on full success): <out-dir>/idp-<db>-<UTC>.archive.gz.gpg (+ .manifest.json), mode 0600.
# The plaintext archive never touches a disk: mongodump | gpg sign+encrypt -> <name>.partial; the manifest is written
# as .partial too and BOTH are renamed only at the very end. Any failure => exit != 0, the .partial files are
# removed, no metric (a failing mongodump prints the tail of its log, credentials masked). Local files older than
# 48 h with exactly this script's names for <db> are pruned.
set -euo pipefail
umask 077

die() {
  echo "mongo-backup: $*" >&2
  exit 1
}
[ "$#" -eq 2 ] || die "usage: mongo-backup.sh <db> <out-dir>"
DB="$1"
OUT="$2"
[[ "$DB" =~ ^[A-Za-z0-9_-]{1,63}$ ]] || die "invalid db name"
[ -d "$OUT" ] || die "out-dir does not exist"
[ -n "${BACKUP_PUBKEY:-}" ] && [ -r "$BACKUP_PUBKEY" ] || die "BACKUP_PUBKEY must name a readable public key file"
[[ "${BACKUP_SIGN_KEY:-}" =~ ^[0-9A-Fa-f]{40}$ ]] || die "BACKUP_SIGN_KEY must be the fingerprint of this host's signing key"
if [ -n "${MONGO_BACKUP_CONFIG:-}" ]; then
  [ -z "${MONGO_URI:-}" ] || die "set MONGO_BACKUP_CONFIG or MONGO_URI, not both"
  [ -r "$MONGO_BACKUP_CONFIG" ] || die "MONGO_BACKUP_CONFIG is not readable"
  CONN=(--config="$MONGO_BACKUP_CONFIG")
elif [ -n "${MONGO_URI:-}" ]; then
  # Never echo the URI: a credential on argv would be visible in ps / shell history.
  case "$MONGO_URI" in *@*) die "MONGO_URI must not carry credentials: use MONGO_BACKUP_CONFIG" ;; esac
  CONN=(--uri="$MONGO_URI")
else
  die "set MONGO_BACKUP_CONFIG (production) or MONGO_URI without credentials"
fi
read -r -a DUMP <<<"${MONGODUMP:-mongodump}"
read -r -a GPG_CMD <<<"${GPG:-gpg}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="idp-${DB}-${STAMP}.archive.gz.gpg"
FILE="$OUT/$NAME"
PARTIAL="$FILE.partial"
MANIFEST_PARTIAL="$FILE.manifest.json.partial"
LOG="$(mktemp "$OUT/.mongo-backup-log.XXXXXX")"
cleanup() {
  rm -f "$PARTIAL" "$MANIFEST_PARTIAL" "$LOG"
}
# The log is deleted on exit: show its tail first (a credentialed URI is masked).
log_tail() {
  echo "mongo-backup: last mongodump log lines:" >&2
  tail -n 20 "$LOG" | sed -E 's#(mongodb(\+srv)?://)[^@/[:space:]]*@#\1***@#g' >&2
}
trap cleanup EXIT
[ ! -e "$FILE" ] || die "target file already exists"

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TOOL="$({ "${DUMP[@]}" --version 2>/dev/null || true; } | sed -n 1p | tr -cd 'A-Za-z0-9 .:_-')"
# pipefail: a dump failing half-way fails the pipeline even though gpg exits 0.
"${DUMP[@]}" "${CONN[@]}" --db="$DB" --archive --gzip 2>"$LOG" |
  "${GPG_CMD[@]}" --batch --yes --trust-model always --recipient-file "$BACKUP_PUBKEY" \
    --local-user "$BACKUP_SIGN_KEY" --sign --cipher-algo AES256 --compress-algo none --encrypt -o "$PARTIAL" ||
  { log_tail; die "dump, signing or encryption failed"; }
FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Per-collection counts from mongodump's own "done dumping <db>.<coll> (N documents)" lines.
COLLS=""
TOTAL=0
N=0
# database-tools 100.x quotes the namespace in backticks (done dumping `<db>.<coll>` (N documents)), older ones do
# not: accept both (DEBT-620). DB names are [A-Za-z0-9_-] (checked above), so "$DB" is literal in the regex; the
# backtick/space after the collection anchors it, so a db sharing the prefix (<db>x) never matches.
DONE_RE='done dumping `?'"$DB"'\.([A-Za-z0-9_.-]+)`? \(([0-9]+) documents?\)'
while IFS= read -r line; do
  if [[ "$line" =~ $DONE_RE ]]; then
    COLLS+="${COLLS:+,}\"${BASH_REMATCH[1]}\":${BASH_REMATCH[2]}"
    TOTAL=$((TOTAL + BASH_REMATCH[2]))
    N=$((N + 1))
  fi
done <"$LOG"
[ "$N" -gt 0 ] || { log_tail; die "mongodump reported no collection (wrong db name?)"; }
BYTES="$(wc -c <"$PARTIAL" | tr -d ' ')"
SHA="$(sha256sum "$PARTIAL" | cut -d' ' -f1)"

# Check that needs no private key: the OpenPGP packet structure (public-key encrypted data).
PACKETS="$("${GPG_CMD[@]}" --batch --no-autostart --list-packets "$PARTIAL" 2>/dev/null || true)"
grep -q ':pubkey enc packet:' <<<"$PACKETS" || die "output is not public-key encrypted"
grep -qE 'tag=(18|20) ' <<<"$PACKETS" || die "output has no encrypted data packet"
printf '{"db":"%s","startedAt":"%s","finishedAt":"%s","toolVersion":"%s","collections":{%s},"totalDocuments":%s,"bytes":%s,"sha256":"%s"}\n' \
  "$DB" "$STARTED" "$FINISHED" "$TOOL" "$COLLS" "$TOTAL" "$BYTES" "$SHA" >"$MANIFEST_PARTIAL"
mv "$PARTIAL" "$FILE"
mv "$MANIFEST_PARTIAL" "$FILE.manifest.json"

# Retention (D87.6): local copies 48 h, only this script's own names. Offsite copies expire by lifecycle rule.
TS='[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z'
find "$OUT" -maxdepth 1 -type f \( -name "idp-${DB}-${TS}.archive.gz.gpg" -o -name "idp-${DB}-${TS}.archive.gz.gpg.manifest.json" \) \
  -mmin +2880 -delete

if [ -n "${BACKUP_TEXTFILE_DIR:-}" ]; then
  PROM="$BACKUP_TEXTFILE_DIR/veyrigate_backup_${DB}.prom"
  {
    echo '# HELP veyrigate_backup_last_success_timestamp_seconds Unix time of the last fully successful encrypted backup.'
    echo '# TYPE veyrigate_backup_last_success_timestamp_seconds gauge'
    echo "veyrigate_backup_last_success_timestamp_seconds{db=\"${DB}\"} $(date -u +%s)"
  } >"$PROM.$$"
  mv "$PROM.$$" "$PROM"
fi
echo "mongo-backup: ok $NAME ($N collections, $TOTAL documents, $BYTES bytes)"
