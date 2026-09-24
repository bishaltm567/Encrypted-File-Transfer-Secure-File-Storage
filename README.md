# Encrypted File Transfer & Secure File Storage

Browser-based client-side encrypted file transfer with chunking, HMAC integrity checks, upload progress, and resumable uploads.

## Run

```bash
cp .env.example .env
# Set STORAGE_HMAC_KEY to a long random secret.
set -a; . ./.env; set +a
npm start
```

Open `http://localhost:8443`. Use HTTPS in production. Render deployment is configured in `render.yaml`; persistent disk storage is required. Docker deployment is available with `docker build -t secure-transfer .` and `docker run -p 8443:10000 -e STORAGE_HMAC_KEY=... secure-transfer`.

AES-256-GCM encryption and PBKDF2 key derivation happen in the browser. The server stores ciphertext chunks and HMACs only. Keep the password and HMAC secret safe; add authentication, authorization, quotas, and rate limiting before multi-user production use.
