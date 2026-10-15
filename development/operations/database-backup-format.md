# Database backup format v1

The worker writes a self-contained `.rootset-backup`. No artifact record, original PostgreSQL database, authentication secret or installation encryption key is needed to decrypt it. The separately retained backup encryption key is required.

The binary envelope is ASCII `ROOTSET-BACKUP\n`, a four-byte unsigned big-endian JSON header length, the UTF-8 JSON header, AES-256-GCM ciphertext, and a 16-byte authentication tag. The complete prefix and header are authenticated additional data. Header length is bounded to 4096 bytes by the internal reader. The header declares `format: rootset.database-backup`, `formatVersion: 1`, `archive: zip64`, `cipher: aes-256-gcm`, a base64 12-byte nonce, and `keyId` (the first 24 hex digits of SHA-256 of the backup key). The 32-byte key is never included. The maximum message size is constrained below the AES-GCM limit.

Decryption yields a ZIP64 archive with unique relative entry paths. Rootset uses full archive encryption rather than ZIP's password encryption. The final `manifest.json` records format and application versions, organisation/database provenance, scheduled and actual snapshot instants, logical table versions/counts, and each other entry's uncompressed byte count and SHA-256. The package's SHA-256 covers the complete encrypted envelope and is stored in run metadata and object metadata. Multipart ETags are not treated as content hashes.

Entries:

- `database.json`: logical database metadata.
- `migrations.json`: applied source migrations and byte digests.
- `schedule.json`: nonsecret schedule configuration; a future restore must force it off.
- `catalog.json`: table metadata, including deletion markers.
- `tables/<source-table-id>/schema.json`: active field definitions and table metadata.
- `tables/<source-table-id>/fields.json`: retained field catalogue, including deleted definitions.
- `tables/<source-table-id>/unique-rules.json`: active unique keys and conditions.
- `tables/<source-table-id>/foreign-keys.json`: active same-database relationships.
- `tables/<source-table-id>/counters.json`: durable integer high-water marks, as decimal strings.
- `tables/<source-table-id>/rows.ndjson`: stable row IDs, decimal version strings, timestamps and values keyed by stable field ID.
- `history/comments.ndjson`: comments and redacted deletion markers.
- `history/cell-changes.ndjson`: retained changes, historical field definitions and decimal identifiers/versions.
- `history/resource-history.ndjson`: retained database/table/schema activity.
- `history/mutations.ndjson`: mutation provenance needed to interpret the cell history. Admission receipts and authentication credentials are excluded.

All entries come from one Repeatable Read transaction under the existing shared database schema lock, acquired before establishing the snapshot. Physical PostgreSQL tables, native indexes, trigger functions and derived uniqueness/foreign-key registries are implementation details and are rebuilt by a future restore. A table in schema maintenance defers the backup instead of omitting data.

The internal reader authenticates before inspection, verifies the manifest and every entry checksum, rejects unsupported versions and duplicates, and bounds decompressed bytes. There is no REST/MCP restore operation. The isolated PostgreSQL/S3 integration rehearsal reconstructs a new database, remaps logical identifiers where necessary, loads rows and counters, rebuilds rules, and checks comments/history. Never execute SQL from a package. Future readers must validate schemas, restore into an unpublished new database, remap attribution without granting authority, validate all rules, and keep restored schedules paused.
