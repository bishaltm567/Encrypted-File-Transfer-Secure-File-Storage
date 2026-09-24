# Render Deployment Checklist

## Before deployment

- [ ] Push the repository to GitHub and confirm the latest commit is on `main`.
- [ ] Confirm `package.json`, `server.js`, `public/`, `render.yaml`, and `Dockerfile` are present.
- [ ] Confirm no `.env`, private key, password, or storage directory is committed.
- [ ] Generate a strong `STORAGE_HMAC_KEY` or use Render's generated secret.
- [ ] Decide the maximum expected file size and persistent disk size.
- [ ] Review whether the service needs authentication before sharing it publicly.

## Create the Render service

1. Sign in to Render and choose **New + → Blueprint**.
2. Connect the GitHub repository:
   `bishaltm567/Encrypted-File-Transfer-Secure-File-Storage`
3. Select the branch containing `render.yaml` (normally `main`).
4. Review the generated web service before applying it.
5. Confirm the service uses the Node runtime and runs `npm start`.
6. Apply the blueprint and wait for the first build to finish.

## Required environment configuration

- [ ] `STORAGE_HMAC_KEY` is configured as a secret; never put its value in `render.yaml` or source control.
- [ ] `STORAGE_DIR` points to the persistent disk mount, for example `/var/data/storage`.
- [ ] `PORT` is left for Render to provide unless the service explicitly requires another value.
- [ ] `HOST` is `0.0.0.0` so the service is reachable through Render's proxy.
- [ ] If a separately hosted frontend is used, configure `CORS_ORIGIN` to the exact trusted origin rather than `*`.

## Persistent disk

- [ ] Attach a persistent disk to the web service.
- [ ] Use the same mount path configured by `STORAGE_DIR`.
- [ ] Size the disk for encrypted files, manifests, HMAC records, and operational headroom.
- [ ] Understand that changing or deleting the disk can destroy uploaded files.
- [ ] Define an external backup and restore process; a persistent disk is not automatically a complete backup strategy.

## Health and smoke tests

After deployment, replace `<service-url>` with the Render URL:

```bash
curl -fsS https://<service-url>/health
```

Expected response:

```json
{"status":"ok"}
```

Then verify in the browser:

- [ ] The homepage loads over HTTPS.
- [ ] A small file uploads successfully.
- [ ] The file ID is displayed.
- [ ] Download with the correct password reproduces the original file.
- [ ] Download with an incorrect password fails.
- [ ] An interrupted upload resumes after selecting the same file again.
- [ ] A multi-chunk file downloads with the correct byte size.

## Production hardening

- [ ] Add authentication and authorization before making the service multi-user.
- [ ] Do not treat a file ID as sufficient authorization for sensitive data.
- [ ] Add rate limiting, upload quotas, request timeouts, and cleanup of abandoned uploads.
- [ ] Add monitoring, alerts, structured logs, and audit events without logging passwords or plaintext.
- [ ] Define retention and deletion behavior for manifests, chunks, backups, and logs.
- [ ] Plan `STORAGE_HMAC_KEY` rotation and recovery testing.
- [ ] Add a strict Content Security Policy and review all frontend dependencies/assets.
- [ ] Keep Node.js and the deployment image updated.
- [ ] Test restore from backup before storing important files.

## Troubleshooting

### Build fails

Check the Render build logs and confirm the repository branch contains `package.json`. The project requires Node.js 20 or later.

### Homepage loads but uploads fail

Check service logs, verify `STORAGE_HMAC_KEY` is present, and confirm `STORAGE_DIR` is writable and points inside the mounted disk.

### Files disappear after restart

The service is using ephemeral storage or the disk mount path does not match `STORAGE_DIR`. Verify the persistent disk mount and environment variable.

### Large uploads fail

Check request and proxy limits, disk capacity, and memory usage. The prototype buffers individual chunks; use smaller chunks or a streaming implementation for constrained instances.

### CORS errors

If the frontend is hosted separately, set `CORS_ORIGIN` to its exact HTTPS origin and ensure the API is configured to return the required CORS headers.
