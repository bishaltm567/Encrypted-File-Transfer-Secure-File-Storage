import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const port = Number(process.env.PORT || 8443), host = process.env.HOST || '0.0.0.0';
const storage = path.resolve(process.env.STORAGE_DIR || './storage');
const publicDir = path.resolve('./public');
const chunkLimit = Number(process.env.MAX_CHUNK_BYTES || 4194304) + 28;
const hmacKey = Buffer.from(process.env.STORAGE_HMAC_KEY || crypto.randomBytes(32).toString('hex'));
if (!process.env.STORAGE_HMAC_KEY) console.warn('Set STORAGE_HMAC_KEY for a stable deployment.');
const idOk = id => /^[a-f0-9]{32}$/.test(id);
const dir = id => path.join(storage, id), manifest = id => path.join(dir(id), 'manifest.json');
const chunk = (id, i) => path.join(dir(id), `chunk-${i}.bin`), mac = (id, i) => path.join(dir(id), `chunk-${i}.hmac`);
const send = (res, status, value, extra = {}) => { const body = JSON.stringify(value); res.writeHead(status, {'content-type':'application/json','cache-control':'no-store',...extra}); res.end(body); };
const error = (res, status, message) => send(res, status, {error:message});
async function body(req, limit) { const parts=[]; let size=0; for await (const p of req) { size += p.length; if (size > limit) throw Error('request body too large'); parts.push(p); } return Buffer.concat(parts); }
async function read(id) { return JSON.parse(await fs.readFile(manifest(id), 'utf8')); }
const hmac = (id, i, data) => crypto.createHmac('sha256', hmacKey).update(`${id}:${i}:`).update(data).digest('hex');
async function complete(req, res) { const m = new URL(req.url, 'http://localhost').pathname.match(/^\/api\/files\/([a-f0-9]{32})\/complete$/); if (req.method !== 'POST' || !m) return false; try { const meta=await read(m[1]); for(let i=0;i<meta.totalChunks;i++) await fs.access(chunk(m[1],i)); meta.status='complete'; meta.completedAt=new Date().toISOString(); await fs.writeFile(manifest(m[1]), JSON.stringify(meta,null,2)); send(res,200,{id:m[1],status:'complete'}); } catch { error(res,409,'not all chunks are uploaded'); } return true; }
async function api(req,res,url) { try {
 if (req.method==='GET' && url.pathname==='/health') return send(res,200,{status:'ok'});
 if (req.method==='POST' && url.pathname==='/api/files/init') { const x=JSON.parse((await body(req,1e6)).toString()); if(!Number.isSafeInteger(x.size)||x.size<0||!Number.isSafeInteger(x.chunkSize)||x.chunkSize<65536||x.chunkSize>4194304||typeof x.filename!=='string'||!x.filename.trim()||!/^[A-Za-z0-9+/=]{16,128}$/.test(x.salt||'')) return error(res,400,'invalid metadata'); const id=crypto.randomBytes(16).toString('hex'), total=Math.max(1,Math.ceil(x.size/x.chunkSize)); await fs.mkdir(dir(id),{recursive:true,mode:0o700}); await fs.writeFile(manifest(id),JSON.stringify({id,filename:path.basename(x.filename),size:x.size,chunkSize:x.chunkSize,totalChunks:total,salt:x.salt,status:'uploading',createdAt:new Date().toISOString()},null,2),{mode:0o600}); return send(res,201,{id,totalChunks:total,chunkSize:x.chunkSize}); }
 const m=url.pathname.match(/^\/api\/files\/([a-f0-9]{32})(?:\/chunks\/(\d+))?$/); if(!m||!idOk(m[1])) return error(res,404,'not found'); const id=m[1], meta=await read(id);
 if(req.method==='GET'&&!m[2]) { const present=[]; for(let i=0;i<meta.totalChunks;i++) try {await fs.access(chunk(id,i));present.push(i);} catch {} return send(res,200,{...meta,present}); }
 if(m[2]===undefined) return error(res,400,'chunk index required'); const i=Number(m[2]); if(i>=meta.totalChunks) return error(res,416,'chunk index out of range');
 if(req.method==='PUT') { const data=await body(req,Math.min(chunkLimit,meta.chunkSize+28)); if(data.length<28)return error(res,400,'encrypted chunk is too short'); await fs.writeFile(chunk(id,i),data,{mode:0o600}); await fs.writeFile(mac(id,i),hmac(id,i,data),{mode:0o600}); return send(res,200,{id,index:i}); }
 if(req.method==='GET') { let data, stored; try {data=await fs.readFile(chunk(id,i));stored=(await fs.readFile(mac(id,i),'utf8')).trim();} catch{return error(res,404,'chunk not uploaded');} const expected=hmac(id,i,data); if(stored.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(stored),Buffer.from(expected))) return error(res,500,'integrity check failed'); res.writeHead(200,{'content-type':'application/octet-stream','content-length':data.length,'cache-control':'no-store'}); return res.end(data); }
 return error(res,405,'method not allowed');
 } catch(e) { console.error(e); return error(res,e.message==='request body too large'?413:400,e.message); } }
async function staticFile(req,res,url) { if(!['GET','HEAD'].includes(req.method))return false; const rel=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname).replace(/^\/+/, ''); if(rel.includes('..')||rel.includes('\\'))return false; try {const file=path.join(publicDir,rel), stat=await fs.stat(file), data=req.method==='HEAD'?null:await fs.readFile(file); const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}; res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','content-length':stat.size,'x-content-type-options':'nosniff','x-frame-options':'DENY'});res.end(data);return true;}catch{return false;} }
await fs.mkdir(storage,{recursive:true,mode:0o700}); const server=createServer(async(req,res)=>{const url=new URL(req.url,`http://${host}`);if(await complete(req,res))return;if(url.pathname.startsWith('/api/'))return api(req,res,url);if(!await staticFile(req,res,url))error(res,404,'not found');}); server.listen(port,host,()=>console.log(`Secure transfer listening on ${host}:${port}`));
