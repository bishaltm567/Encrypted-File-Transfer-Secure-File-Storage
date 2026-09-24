# Encrypted File Transfer & Secure File Storage

This is a dependency-free Node.js app with a browser frontend. Encryption happens client-side with AES-256-GCM; the server receives and stores ciphertext chunks only.

## Features

- Simple browser upload/download UI at `/`.
- AES-256-GCM per chunk and server-side HMAC-SHA-256 integrity checks.
- Upload progress and resumable uploads: an interrupted upload can be resumed by selecting the same file and entering the same password.
- PBKDF2-SHA-256 (250,000 iterations) in the browser; the CLI continues to support scrypt.
- Safe opaque storage IDs, restrictive permissions, path traversal protection, and security headers.
- Docker and Render deployment files included.

## Local run

```bash
cp .env.example .env
# Set STORAGE_HMAC_KEY to a long random secret.
set -a; . ./.env; set +a
npm start
# Open http://127.0.0.1:8443
```

## Render / Docker

Render can deploy this repository using `render.yaml`; attach a persistent disk because ephemeral disks lose encrypted files on restart. Set `STORAGE_HMAC_KEY` as a secret. For Docker, run `docker build -t secure-transfer . && docker run -p 8443:10000 -e STORAGE_HMAC_KEY="$(openssl rand -hex 32)" secure-transfer`.

Vercel/GitHub Pages are not suitable for the server component because they do not provide persistent local storage. They can host the static frontend only if `CORS_ORIGIN` and an external API/storage service are configured; the included Render/Docker deployment is the complete option.

## Threat model

Use HTTPS in production to mitigate man-in-the-middle attacks and protect IDs/metadata. AES-GCM detects client-side ciphertext tampering, while the server HMAC detects unauthorized disk modification. A compromised server can still delete, replay, or withhold chunks and observe metadata. Keep the HMAC secret outside source control, use long unique passwords, and add authentication, authorization, quotas, rate limiting, audit logging, retention policies, and key rotation before multi-user production use. Losing a password means the encrypted file cannot be recovered.
