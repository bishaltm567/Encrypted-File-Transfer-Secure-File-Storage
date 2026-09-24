const CHUNK_SIZE = 1024 * 1024;
const PBKDF2_ITERATIONS = 250000;

const $ = (id) => document.getElementById(id);

const base64ToBytes = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

async function deriveKey(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptChunk(key, plainBuffer) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plainBuffer)
  );
  const tag = encrypted.slice(-16);
  const ciphertext = encrypted.slice(0, -16);
  return new Blob([nonce, tag, ciphertext]);
}

async function decryptChunk(key, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 28) throw new Error('Invalid encrypted chunk');
  const nonce = bytes.slice(0, 12);
  const tag = bytes.slice(12, 28);
  const ciphertext = bytes.slice(28);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    key,
    combined
  );

  return new Uint8Array(plaintext);
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || response.statusText || 'Request failed');
  }
  return response;
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.textContent = busy ? 'Working…' : button.dataset.defaultText;
}

$('uploadButton').dataset.defaultText = 'Encrypt and upload';
$('downloadButton').dataset.defaultText = 'Download and decrypt';

$('uploadButton').addEventListener('click', async () => {
  const file = $('file').files[0];
  const password = $('uploadPassword').value.trim();
  const status = $('uploadStatus');

  if (!file || !password) {
    status.textContent = 'Choose a file and enter a password.';
    return;
  }

  const button = $('uploadButton');
  setBusy(button, true);

  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    const saved = JSON.parse(localStorage.getItem(`eft:${file.name}:${file.size}`) || 'null');

    let meta;
    if (saved) {
      meta = await apiRequest(`/api/files/${saved.id}`).then((res) => res.json());
      status.textContent = `Resuming ${meta.present.length}/${meta.totalChunks} chunks...`;
    } else {
      meta = await apiRequest('/api/files/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          chunkSize: CHUNK_SIZE,
          salt: bytesToBase64(salt)
        })
      }).then((res) => res.json());
      localStorage.setItem(`eft:${file.name}:${file.size}`, JSON.stringify({ id: meta.id }));
    }

    const present = new Set(meta.present || []);
    for (let index = 0; index < meta.totalChunks; index++) {
      if (present.has(index)) {
        continue;
      }

      const chunkStart = index * CHUNK_SIZE;
      const chunkEnd = Math.min(file.size, chunkStart + CHUNK_SIZE);
      const plain = await file.slice(chunkStart, chunkEnd).arrayBuffer();
      const encryptedBlob = await encryptChunk(key, plain);
      await apiRequest(`/api/files/${meta.id}/chunks/${index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: encryptedBlob
      });

      const progress = ((index + 1) / meta.totalChunks) * 100;
      $('progress').value = progress;
      status.textContent = `Uploaded chunk ${index + 1}/${meta.totalChunks}`;
    }

    await apiRequest(`/api/files/${meta.id}/complete`, { method: 'POST' });
    $('fileId').value = meta.id;
    localStorage.removeItem(`eft:${file.name}:${file.size}`);
    status.textContent = `Upload complete. File ID: ${meta.id}`;
  } catch (error) {
    status.textContent = `Upload paused: ${error.message}. Select the same file and password to resume.`;
  } finally {
    setBusy(button, false);
  }
});

$('downloadButton').addEventListener('click', async () => {
  const fileId = $('fileId').value.trim();
  const password = $('downloadPassword').value.trim();
  const status = $('downloadStatus');

  if (!/^[a-f0-9]{32}$/.test(fileId) || !password) {
    status.textContent = 'Enter a valid file ID and password.';
    return;
  }

  const button = $('downloadButton');
  setBusy(button, true);

  try {
    const meta = await apiRequest(`/api/files/${fileId}`).then((res) => res.json());
    const saltBytes = base64ToBytes(meta.salt);
    const key = await deriveKey(password, saltBytes);
    const chunks = [];

    for (let index = 0; index < meta.totalChunks; index++) {
      const blob = await apiRequest(`/api/files/${fileId}/chunks/${index}`).then((res) => res.blob());
      const decrypted = await decryptChunk(key, blob);
      chunks.push(decrypted);
      status.textContent = `Downloaded chunk ${index + 1}/${meta.totalChunks}`;
    }

    const blob = new Blob(chunks);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = meta.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    status.textContent = `Decrypted ${meta.filename}`;
  } catch (error) {
    status.textContent = `Download failed: ${error.message}`;
  } finally {
    setBusy(button, false);
  }
});
