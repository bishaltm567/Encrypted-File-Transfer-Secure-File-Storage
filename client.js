import { promises as fs } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const command = process.argv[2]; const arg = process.argv[3]; const password = process.env.EFT_PASSWORD; const base = process.env.EFT_URL || 'http://127.0.0.1:8443';
if (!['upload', 'download'].includes(command) || !arg || !password) { console.error('Usage: EFT_PASSWORD="..." npm run upload -- ./file [EFT_URL=...]\n       EFT_PASSWORD="..." npm run download -- FILE_ID [EFT_OUTPUT=./file]'); process.exit(1); }
const derive = (salt) => crypto.scryptSync(password, Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
const request = async (url, options = {}) => { const response = await fetch(url, options); if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`); return response; };

if (command === 'upload') {
  const input = path.resolve(arg); const stat = await fs.stat(input); const chunkSize = 1024 * 1024; const salt = crypto.randomBytes(16).toString('base64'); const key = derive(salt);
  const init = await request(`${base}/api/files/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: path.basename(input), size: stat.size, chunkSize, salt }) }).then(r => r.json());
  const stream = createReadStream(input, { highWaterMark: chunkSize }); let index = 0;
  for await (const plain of stream) { const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]); const body = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]); await request(`${base}/api/files/${init.id}/chunks/${index}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': body.length }, body }); console.log(`uploaded chunk ${index + 1}/${init.totalChunks}`); index++; }
  await request(`${base}/api/files/${init.id}/complete`, { method: 'POST' }); console.log(`Upload complete. File ID: ${init.id}`); console.log('Keep the file ID and password to download/decrypt it.');
} else {
  const meta = await request(`${base}/api/files/${arg}`).then(r => r.json()); const key = derive(meta.salt); const output = path.resolve(process.env.EFT_OUTPUT || meta.filename); const out = createWriteStream(output, { flags: 'wx', mode: 0o600 });
  try { for (let index = 0; index < meta.totalChunks; index++) { const body = Buffer.from(await (await request(`${base}/api/files/${arg}/chunks/${index}`)).arrayBuffer()); if (body.length < 28) throw new Error(`invalid encrypted chunk ${index}`); const decipher = crypto.createDecipheriv('aes-256-gcm', key, body.subarray(0, 12)); decipher.setAuthTag(body.subarray(12, 28)); out.write(Buffer.concat([decipher.update(body.subarray(28)), decipher.final()])); console.log(`downloaded chunk ${index + 1}/${meta.totalChunks}`); } out.end(); console.log(`Decrypted file written to ${output}`); } catch (error) { out.destroy(); await fs.rm(output, { force: true }); throw error; }
}
