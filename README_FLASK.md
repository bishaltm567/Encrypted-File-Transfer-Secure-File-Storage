# Flask version of the secure file transfer project

This is the Python/Flask version of the encrypted file-transfer prototype.

## Features

- Browser-based upload and download interface.
- Client-side AES-256-GCM encryption using Web Crypto API.
- Server-side HMAC-SHA-256 integrity checks on stored cipher chunks.
- Resumable uploads through repeated chunk uploads.
- Opaque random file IDs and restricted storage permissions.
- Flask API and static templates for local or Render deployment.

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export STORAGE_HMAC_KEY="replace-with-a-long-random-secret"
python app.py
```

Then open:

```text
http://127.0.0.1:5000
```

## Production notes

For Render or another host, set `STORAGE_HMAC_KEY` as a secret environment variable and mount a persistent disk at the path configured in `STORAGE_DIR`. Use HTTPS and add authentication/authorization before exposing the service beyond a private environment.

## Security model

Encryption and key derivation happen in the browser. The server stores only ciphertext and HMAC files. The password is never sent to the server. A lost password means the file cannot be recovered.
