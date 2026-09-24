# Project Report: Encrypted File Transfer & Secure File Storage

## 1. Executive summary

This project provides a browser-based encrypted file-transfer service. Files are encrypted in the user's browser before they leave the device, divided into fixed-size chunks, uploaded to a Node.js server, and stored on disk as ciphertext. The server does not receive the plaintext file or the user's encryption password.

The implementation demonstrates confidentiality, authenticated encryption, storage integrity, safe file handling, upload progress, and resumable uploads. It is suitable as an academic project or security-focused prototype. A production deployment must add authentication, authorization, quotas, abuse controls, monitoring, and a mature key-management design.

## 2. Objectives

- Encrypt files before transmission and storage.
- Avoid storing plaintext on the server.
- Support large files through chunked transfer.
- Detect modification of stored ciphertext.
- Resume an interrupted upload without restarting from zero.
- Provide a simple browser interface and deployment configuration.
- Document the threat model and remaining limitations.

## 3. System architecture

The system contains three logical components:

1. **Browser frontend** (`public/`): selects files, derives an encryption key from a password, encrypts each chunk with AES-GCM, displays progress, and decrypts downloaded chunks locally.
2. **Node.js API server** (`server.js`): creates opaque file IDs, stores manifests and encrypted chunks, calculates HMACs for stored chunks, verifies integrity during retrieval, and serves the frontend.
3. **Persistent storage** (`storage/`): one restricted directory per file ID containing a manifest, ciphertext chunks, and HMAC records. Plaintext is never intentionally written here.

### Upload flow

1. The browser generates a random salt.
2. A key is derived from the password using PBKDF2-SHA-256.
3. The browser requests a file manifest from `POST /api/files/init`.
4. Each plaintext chunk is encrypted with a fresh random 12-byte nonce using AES-256-GCM.
5. The browser uploads `nonce || authentication tag || ciphertext` to a chunk endpoint.
6. The server stores the ciphertext and a server-side HMAC-SHA-256 record.
7. The browser can retry missing chunks and calls the completion endpoint when all chunks exist.

### Download flow

1. The browser retrieves the manifest using the file ID.
2. It derives the same key using the password and stored salt.
3. It downloads each chunk in order.
4. The server verifies its HMAC before returning a chunk.
5. The browser verifies the AES-GCM authentication tag and decrypts the plaintext.
6. The browser combines chunks into a download Blob.

## 4. Security controls

- **AES-256-GCM:** provides confidentiality and per-chunk authenticated encryption.
- **Fresh nonce per chunk:** avoids nonce reuse for encrypted chunks.
- **PBKDF2-SHA-256:** derives a 256-bit browser key from the password and random salt. The password is not sent to the server.
- **HMAC-SHA-256:** detects unauthorized modification of ciphertext stored on disk.
- **Opaque random identifiers:** prevents filenames from becoming storage paths.
- **Path traversal protection:** rejects unsafe static-file paths and uses `basename()` for display metadata.
- **Restricted permissions:** storage directories and files are created with restrictive permissions where supported.
- **Bounded request bodies:** prevents an individual request from consuming unbounded memory.
- **Security headers:** includes basic browser isolation and MIME-sniffing protections.
- **No-store responses:** prevents sensitive API responses from being cached by intermediaries.

## 5. Threat model

### Protected assets

- File contents and encrypted chunks.
- User encryption passwords, which must remain client-side.
- Storage integrity and file metadata.
- Availability of uploaded files.

### Threats and mitigations

| Threat | Mitigation | Remaining risk |
|---|---|---|
| Network eavesdropping | Use HTTPS/TLS in production; client encryption protects content | IDs and some metadata can still be visible to the service operator |
| Man-in-the-middle | Validated TLS certificates plus AES-GCM authentication | A malicious frontend served before encryption can attack the client |
| Disk or backup tampering | Server HMAC plus AES-GCM authentication tags | A holder of the HMAC key can replace stored ciphertext; keep the key separate |
| Compromised server | Client-side encryption limits plaintext exposure | Server can delete, withhold, reorder, replay, or observe metadata |
| Password guessing | Long unique passwords and a costly KDF | Weak passwords remain vulnerable to offline guessing |
| Path traversal | Opaque IDs, validated IDs, safe filenames, and static-path checks | Authorization is still required to prevent file-ID sharing |
| Denial of service | Chunk limits and bounded metadata requests | Add quotas, authentication, rate limiting, timeouts, and cleanup jobs |
| Browser compromise | HTTPS, CSP in a hardened deployment, and trusted builds | An XSS or compromised frontend can access plaintext and passwords |

## 6. Key management

The browser-derived encryption key is not stored by the server. The salt is stored as non-secret metadata so the same password can derive the key during download. Users must retain the password; password loss is equivalent to key loss.

`STORAGE_HMAC_KEY` is a separate server secret. It must be supplied through the deployment secret manager, never committed to Git, and backed up according to the operator's recovery policy. A production key rotation plan should support re-MACing existing chunks without requiring plaintext access.

For team or multi-user deployments, replace the shared-password model with authenticated users and envelope encryption backed by a KMS or a public-key scheme. Add per-file ownership and authorization checks before exposing file metadata or chunks.

## 7. Testing plan

- Upload a small text file and verify that the downloaded file matches the original.
- Upload a file larger than one chunk and verify ordering and byte equality.
- Stop the server during upload, restart it, select the same file, and verify resume behavior.
- Delete a chunk and verify that the next upload resumes only the missing chunk.
- Modify a stored ciphertext or HMAC and verify retrieval fails.
- Use an incorrect password and verify AES-GCM authentication fails.
- Try path traversal strings and malformed file IDs; verify they are rejected.
- Test files with Unicode names, empty files, and files near the chunk boundary.
- Verify Render or Docker uses persistent storage and does not expose secrets in logs.

## 8. Limitations and future work

- The prototype has no user authentication or per-file authorization.
- File IDs act as bearer references; anyone who obtains one may attempt access.
- The server can observe filenames, sizes, timing, and chunk counts.
- In-memory request buffering should be replaced with streaming pipelines for very large production workloads.
- Add expiration, deletion, quotas, audit events, malware policy, structured logging, metrics, and automated tests.
- Add a strict Content Security Policy and a trusted asset delivery strategy.
- Consider a stronger memory-hard KDF and formal key-management integration for high-value data.

## 9. Conclusion

The project demonstrates a practical end-to-end encrypted transfer design in which the server stores ciphertext rather than plaintext. AES-GCM protects each chunk, server HMACs protect disk integrity, and resumable chunk uploads improve reliability. The design is intentionally transparent and dependency-light, while the documented limitations identify the controls required before operating it as a multi-user production service.
