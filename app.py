import os
import re
import secrets
import json
import hmac
import hashlib
from pathlib import Path

from flask import Flask, render_template, request, jsonify, send_file, Response

app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", str(BASE_DIR / "storage"))).resolve()
MAX_CHUNK_BYTES = int(os.environ.get("MAX_CHUNK_BYTES", str(4 * 1024 * 1024))) + 28
HMAC_KEY = os.environ.get("STORAGE_HMAC_KEY", secrets.token_hex(32)).encode()

if not os.environ.get("STORAGE_HMAC_KEY"):
    print("WARNING: STORAGE_HMAC_KEY is not set. A random key was generated for this process only.")

os.makedirs(STORAGE_DIR, exist_ok=True, mode=0o700)


def json_response(payload, status=200):
    return jsonify(payload), status


def file_dir(file_id):
    return STORAGE_DIR / file_id


def manifest_path(file_id):
    return file_dir(file_id) / "manifest.json"


def chunk_path(file_id, index):
    return file_dir(file_id) / f"chunk-{index}.bin"


def hmac_path(file_id, index):
    return file_dir(file_id) / f"chunk-{index}.hmac"


def compute_hmac(file_id, index, data):
    message = f"{file_id}:{index}:".encode() + data
    return hmac.new(HMAC_KEY, message, hashlib.sha256).hexdigest()


def read_manifest(file_id):
    with open(manifest_path(file_id), "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_manifest(file_id, manifest):
    file_dir(file_id).mkdir(exist_ok=True, mode=0o700)
    with open(manifest_path(file_id), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    os.chmod(manifest_path(file_id), 0o600)


def all_chunks_present(file_id, total_chunks):
    for index in range(total_chunks):
        if not chunk_path(file_id, index).exists():
            return False
    return True


@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/health")
def health():
    return json_response({"status": "ok"})


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/files/init")
def init_upload():
    data = request.get_json(silent=True) or {}
    filename = data.get("filename")
    size = data.get("size")
    chunk_size = data.get("chunkSize")
    salt = data.get("salt")

    if not isinstance(size, int) or size < 0:
        return json_response({"error": "invalid size"}, 400)
    if not isinstance(chunk_size, int) or chunk_size < 64 * 1024 or chunk_size > 4 * 1024 * 1024:
        return json_response({"error": "chunkSize must be between 64KiB and 4MiB"}, 400)
    if not isinstance(filename, str) or not filename.strip() or len(filename) > 255:
        return json_response({"error": "invalid filename"}, 400)
    if not isinstance(salt, str) or not re.fullmatch(r"[A-Za-z0-9+/=]{16,128}", salt):
        return json_response({"error": "salt is required"}, 400)

    file_id = secrets.token_hex(16)
    total_chunks = max(1, (size + chunk_size - 1) // chunk_size)
    file_dir(file_id).mkdir(exist_ok=True, mode=0o700)
    manifest = {
        "id": file_id,
        "filename": os.path.basename(filename),
        "size": size,
        "chunkSize": chunk_size,
        "totalChunks": total_chunks,
        "salt": salt,
        "status": "uploading",
        "createdAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }
    write_manifest(file_id, manifest)
    return json_response({"id": file_id, "totalChunks": total_chunks, "chunkSize": chunk_size}, 201)


@app.get("/api/files/<file_id>")
def get_file_info(file_id):
    if not re.fullmatch(r"[a-f0-9]{32}", file_id):
        return json_response({"error": "not found"}, 404)
    try:
        manifest = read_manifest(file_id)
    except FileNotFoundError:
        return json_response({"error": "file not found"}, 404)

    present = []
    for index in range(manifest["totalChunks"]):
        if chunk_path(file_id, index).exists():
            present.append(index)

    manifest["present"] = present
    return json_response(manifest)


@app.put("/api/files/<file_id>/chunks/<int:index>")
def upload_chunk(file_id, index):
    if not re.fullmatch(r"[a-f0-9]{32}", file_id):
        return json_response({"error": "not found"}, 404)
    try:
        manifest = read_manifest(file_id)
    except FileNotFoundError:
        return json_response({"error": "file not found"}, 404)

    if index >= manifest["totalChunks"]:
        return json_response({"error": "chunk index out of range"}, 416)

    chunk_bytes = request.get_data(cache=False)
    if len(chunk_bytes) < 28:
        return json_response({"error": "encrypted chunk is too short"}, 400)
    if len(chunk_bytes) > min(MAX_CHUNK_BYTES, manifest["chunkSize"] + 28):
        return json_response({"error": "request body too large"}, 413)

    chunk_file = chunk_path(file_id, index)
    chunk_file.parent.mkdir(exist_ok=True, mode=0o700)
    with open(chunk_file, "wb") as fh:
        fh.write(chunk_bytes)
    os.chmod(chunk_file, 0o600)

    mac_file = hmac_path(file_id, index)
    digest = compute_hmac(file_id, index, chunk_bytes)
    with open(mac_file, "w", encoding="utf-8") as fh:
        fh.write(digest)
    os.chmod(mac_file, 0o600)

    return json_response({"id": file_id, "index": index, "bytes": len(chunk_bytes)})


@app.get("/api/files/<file_id>/chunks/<int:index>")
def download_chunk(file_id, index):
    if not re.fullmatch(r"[a-f0-9]{32}", file_id):
        return json_response({"error": "not found"}, 404)
    try:
        manifest = read_manifest(file_id)
    except FileNotFoundError:
        return json_response({"error": "file not found"}, 404)

    if index >= manifest["totalChunks"]:
        return json_response({"error": "chunk index out of range"}, 416)

    try:
        chunk_bytes = chunk_path(file_id, index).read_bytes()
        stored_digest = hmac_path(file_id, index).read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return json_response({"error": "chunk not uploaded"}, 404)

    expected_digest = compute_hmac(file_id, index, chunk_bytes)
    if not hmac.compare_digest(stored_digest, expected_digest):
        return json_response({"error": "stored chunk integrity check failed"}, 500)

    return Response(chunk_bytes, mimetype="application/octet-stream")


@app.post("/api/files/<file_id>/complete")
def complete_upload(file_id):
    if not re.fullmatch(r"[a-f0-9]{32}", file_id):
        return json_response({"error": "not found"}, 404)
    try:
        manifest = read_manifest(file_id)
    except FileNotFoundError:
        return json_response({"error": "file not found"}, 404)

    if not all_chunks_present(file_id, manifest["totalChunks"]):
        return json_response({"error": "not all chunks have been uploaded"}, 409)

    manifest["status"] = "complete"
    manifest["completedAt"] = __import__("datetime").datetime.utcnow().isoformat() + "Z"
    write_manifest(file_id, manifest)
    return json_response({"id": file_id, "status": "complete"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    host = os.environ.get("HOST", "0.0.0.0")
    app.run(host=host, port=port, debug=False)
