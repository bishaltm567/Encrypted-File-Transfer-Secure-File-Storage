# Encrypted File Transfer & Secure File Storage

A small, dependency-free Node.js reference implementation for **client-side encrypted**, chunked file transfer. The server never receives plaintext or the password.

## Features

- AES-256-GCM encryption per chunk (confidentiality plus authenticated encryption).
- 1 MiB chunks by default; upload chunks can be retried/resumed by calling `PUT` again for the same index.
- Server-side HMAC-SHA-256 over every ciphertext chunk, protecting stored data from disk tampering.
- Restrictive storage permissions (`0700` directories and `0600` files), generated opaque IDs, safe filename handling, and no path derived from user input.
- Download verifies the server HMAC before the client verifies each AES-GCM tag.
- Optional HTTPS via `TLS_KEY_FILE` and `TLS_CERT_FILE`.
- No runtime dependencies; requires Node.js 20+.

## Run locally

```bash
cp .env.example .env
# Set a stable, random value in .env. Never commit it:
# STORAGE_HMAC_KEY=$(openssl rand -hex 32)
set -a; . ./.env; set +a
npm start
```

The default listener is `http://127.0.0.1:8443`. For a real deployment, put the service behind TLS (or provide certificate paths in `.env`), bind to a private interface, and add authentication/rate limiting at the reverse proxy.

## Upload and download

```bash
export EFT_PASSWORD='a strong passphrase'
npm run upload -- ./example.pdf
# Save the printed file ID.
EFT_OUTPUT=./restored.pdf npm run download -- FILE_ID
```

The password is used only by `client.js` to derive a 256-bit key with scrypt. The salt is stored as non-secret metadata so the same password can derive the key on download. Losing the password means the encrypted file cannot be recovered.

## HTTP API

1. `POST /api/files/init` with `{filename, size, chunkSize, salt}` → `{id, totalChunks}`.
2. `PUT /api/files/:id/chunks/:index` with one encrypted binary chunk. The body format is `12-byte nonce || 16-byte GCM tag || ciphertext`.
3. Repeat the PUT for missing chunks to resume an upload. `GET /api/files/:id` returns metadata and present indexes.
4. `POST /api/files/:id/complete` marks the upload complete after all chunks exist.
5. `GET /api/files/:id/chunks/:index` retrieves a ciphertext chunk after checking its server HMAC.

## Threat model and mitigations

- **Network observer / man-in-the-middle:** HTTPS/TLS is required for production. AES-GCM protects content if ciphertext is observed, while TLS protects IDs, metadata, and credentials in transit. Pin or properly validate certificates; do not use `-k`/insecure TLS.
- **Malicious or compromised storage disk:** The server stores ciphertext only. A server-held HMAC key detects unauthorized ciphertext modification, and the client-side GCM tag detects modification even if the HMAC key is compromised. Keep `STORAGE_HMAC_KEY` outside the repository and rotate it with a planned re-MAC migration.
- **Compromised application server:** This design limits plaintext exposure because encryption and decryption happen in the client. A compromised server can delete, reorder, replay, or withhold chunks and can observe metadata; authenticated chunk indexes and application authorization are still needed for multi-user use.
- **Password theft / guessing:** Use a long unique passphrase, protect terminal history and environment variables, and consider a KMS or public-key envelope scheme for teams. scrypt slows offline guessing but is not magic.
- **Filename/path attacks:** The server uses an opaque random ID for directories and `basename()` only for display metadata. It never concatenates an attacker filename into a filesystem path.
- **Denial of service:** Deploy authentication, quotas, request limits, connection timeouts, and reverse-proxy rate limits. The sample has a bounded JSON body and chunk body but is intentionally not a complete internet-facing multi-tenant service.

For production, add user authentication and authorization on every file operation, antivirus/content policy checks after decryption in a trusted client, audit logs that exclude secrets, key rotation, backups, and tested deletion/retention policies.
