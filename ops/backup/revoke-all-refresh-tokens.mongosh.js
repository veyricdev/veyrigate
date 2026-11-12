// runbook-ops section 4c (run 87, DEBT-253, D87.10): after a restore, revoke EVERY refresh token of the
// RESTORED database (same two updates as RefreshTokenService.revokeWhere: family stamp first). RTs rotated or
// revoked after the backup point are alive again in the restored copy; whoever holds an old copy could use them.
// The database comes from TARGET, never from the shell's current `db` (that is the live/old one). Run it as:
//   { printf "db = connect('%s');\nconst TARGET='%s';\n" "$URI" '<db_new>'; cat <this file>; } |
//     mongosh --nodb --quiet /dev/stdin
// The URI (with its password) is read from the 0600 config into a shell variable, never put on argv (DEBT-616);
// `/dev/stdin` runs it as a file, so any throw exits 1 (REPL mode would go on and exit 0).
// Drill: the same through `docker exec -i veyrigate-mongo mongosh --nodb --quiet /dev/stdin`.
/* global TARGET, db, print */
if (typeof TARGET !== 'string' || !/^[A-Za-z0-9_-]{1,63}$/.test(TARGET)) {
  throw new Error('set TARGET to the restored database name');
}
const d = db.getSiblingDB(TARGET);
print('DB:', d.getName());
const dbs = db.adminCommand({ listDatabases: 1, nameOnly: true }).databases;
if (!dbs.some((x) => x.name === d.getName())) throw new Error('database does not exist: ' + d.getName());
if (!d.getCollectionNames().includes('refreshtokens')) {
  throw new Error('no refreshtokens collection in ' + d.getName() + ': wrong database?');
}
const now = new Date();
d.refreshtokens.updateMany({ familyRevokedAt: null }, { $set: { familyRevokedAt: now } });
d.refreshtokens.updateMany({ revokedAt: null }, { $set: { revokedAt: now } });
const active = d.refreshtokens.countDocuments({ revokedAt: null });
print('active RT:', active);
print('total RT:', d.refreshtokens.countDocuments());
if (active !== 0) throw new Error('active refresh tokens remain: ' + active);
