"""
app.py — Qwen3-TTS Web UI Server
Run with: python app.py
Then open http://<your-local-ip>:7860 on any device on the same network.
"""

import os
import sys
import json
import queue
import socket
import threading
import time
import shutil
import re

from flask import (
    Flask, request, jsonify, render_template,
    Response, stream_with_context, send_from_directory, abort
)
from werkzeug.utils import secure_filename

# ── Pull everything we need from main.py ──────────────────────────────────────
# We import the module so any edits to main.py constants are picked up on
# server restart without touching app.py.
sys.path.insert(0, os.path.dirname(__file__))
import main as tts_main

# Patch AUTO_PLAY to False so the server never runs afplay during web sessions
tts_main.AUTO_PLAY = False

# ── Config ────────────────────────────────────────────────────────────────────
MAX_UPLOAD_MB = int(os.environ.get("TTS_MAX_UPLOAD_MB", "50"))
PORT = int(os.environ.get("TTS_PORT", "7860"))
HOST = "0.0.0.0"

# ── Flask app ─────────────────────────────────────────────────────────────────
app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

# Track loaded models to avoid re-loading between requests (keyed by model_key)
_loaded_models: dict = {}
_model_lock = threading.Lock()


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _ensure_model(model_key: str, progress_q: queue.Queue):
    """Load (or reuse) a model, posting progress messages to the queue."""
    with _model_lock:
        if model_key in _loaded_models:
            progress_q.put(("info", "Model already loaded — skipping reload."))
            return _loaded_models[model_key]

        info = tts_main.MODELS.get(model_key)
        if not info:
            raise ValueError(f"Unknown model key: {model_key}")

        model_path = tts_main.get_smart_path(info["folder"])
        if not model_path:
            raise FileNotFoundError(
                f"Model folder '{info['folder']}' not found in models/. "
                "Have you downloaded it?"
            )

        progress_q.put(("info", f"Loading {info['name']} ({info['folder']})…"))
        model = tts_main.load_model(model_path)
        _loaded_models[model_key] = model
        progress_q.put(("info", "Model ready."))
        return model


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/ping")
def api_ping():
    return "ok"


@app.route("/api/config")
def api_config():
    """Return all UI-driving constants directly from main.py."""
    models_out = {}
    for key, info in tts_main.MODELS.items():
        models_out[key] = {
            "name": info["name"],
            "mode": info["mode"],
            "folder": info["folder"],
            "output_subfolder": info["output_subfolder"],
            "available": tts_main.get_smart_path(info["folder"]) is not None,
        }

    return jsonify({
        "models": models_out,
        "speaker_map": tts_main.SPEAKER_MAP,
        "emotion_examples": tts_main.EMOTION_EXAMPLES,
        "speeds": [
            {"label": "Normal (1.0×)", "value": 1.0},
            {"label": "Fast (1.3×)",   "value": 1.3},
            {"label": "Slow (0.8×)",   "value": 0.8},
        ],
        "max_upload_mb": MAX_UPLOAD_MB,
    })


@app.route("/api/voices")
def api_voices():
    voices = tts_main.get_saved_voices()
    return jsonify({"voices": voices})


@app.route("/api/voices/<name>", methods=["DELETE"])
def api_delete_voice(name: str):
    safe = re.sub(r"[^\w\-]", "", name)
    if not safe:
        abort(400)
    wav = os.path.join(tts_main.VOICES_DIR, f"{safe}.wav")
    txt = os.path.join(tts_main.VOICES_DIR, f"{safe}.txt")
    deleted = False
    for p in (wav, txt):
        if os.path.exists(p):
            os.remove(p)
            deleted = True
    return jsonify({"deleted": deleted, "name": safe})


@app.route("/api/enroll", methods=["POST"])
def api_enroll():
    """Save an uploaded audio file as a new cloneable voice."""
    name = request.form.get("name", "").strip()
    transcript = request.form.get("transcript", "").strip()
    audio_file = request.files.get("audio")

    if not name or not audio_file:
        return jsonify({"error": "name and audio are required"}), 400

    safe_name = re.sub(r"[^\w\s-]", "", name).strip().replace(" ", "_")
    if not safe_name:
        return jsonify({"error": "Invalid voice name"}), 400

    os.makedirs(tts_main.VOICES_DIR, exist_ok=True)

    # Save uploaded file to a temp path, convert if needed
    tmp_path = os.path.join(os.getcwd(), f"_enroll_tmp_{int(time.time())}{os.path.splitext(secure_filename(audio_file.filename))[1]}")
    audio_file.save(tmp_path)

    clean_wav = tts_main.convert_audio_if_needed(tmp_path)
    if not clean_wav:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        return jsonify({"error": "Could not convert audio. Is ffmpeg installed?"}), 422

    target_wav = os.path.join(tts_main.VOICES_DIR, f"{safe_name}.wav")
    target_txt = os.path.join(tts_main.VOICES_DIR, f"{safe_name}.txt")

    shutil.copy(clean_wav, target_wav)
    with open(target_txt, "w", encoding="utf-8") as f:
        f.write(transcript)

    # Clean up temp files
    for p in (tmp_path, clean_wav):
        if p and os.path.exists(p) and p != target_wav:
            try:
                os.remove(p)
            except OSError:
                pass

    return jsonify({"enrolled": safe_name})


@app.route("/api/generate", methods=["POST"])
def api_generate():
    """
    SSE endpoint — streams generation progress lines then a final 'done' event
    containing the relative path to the output audio file.

    Expected JSON body:
      model_key   : "1"–"6"
      mode        : "custom" | "design" | "clone_saved" | "clone_quick"
      text        : str
      speaker     : str  (custom only)
      instruct    : str  (custom / design)
      speed       : float (custom only)
      voice_name  : str  (clone_saved only)
      ref_text    : str  (clone_quick / clone_saved)
    """
    data = request.get_json(force=True)
    model_key = str(data.get("model_key", ""))
    mode = data.get("mode", "")
    text = (data.get("text") or "").strip()

    if not model_key or not mode or not text:
        return jsonify({"error": "model_key, mode, and text are required"}), 400

    progress_q: queue.Queue = queue.Queue()

    def run_generation():
        try:
            model = _ensure_model(model_key, progress_q)
            info = tts_main.MODELS[model_key]
            temp_dir = tts_main.make_temp_dir()

            if mode == "custom":
                speaker  = data.get("speaker", "Vivian")
                instruct = data.get("instruct", "Normal tone")
                speed    = float(data.get("speed", 1.0))
                progress_q.put(("info", f"Generating with speaker '{speaker}'…"))
                tts_main.generate_audio(
                    model=model, text=text, voice=speaker,
                    instruct=instruct, speed=speed, output_path=temp_dir
                )

            elif mode == "design":
                instruct = data.get("instruct", "")
                if not instruct:
                    raise ValueError("Voice description is required for Voice Design mode.")
                progress_q.put(("info", f"Designing voice: {instruct[:60]}…"))
                tts_main.generate_audio(
                    model=model, text=text, instruct=instruct, output_path=temp_dir
                )

            elif mode in ("clone_saved", "clone_quick"):
                if mode == "clone_saved":
                    voice_name = data.get("voice_name", "")
                    if not voice_name:
                        raise ValueError("voice_name required for clone_saved.")
                    ref_audio = os.path.join(tts_main.VOICES_DIR, f"{voice_name}.wav")
                    txt_path  = os.path.join(tts_main.VOICES_DIR, f"{voice_name}.txt")
                    ref_text  = open(txt_path, "r", encoding="utf-8").read().strip() if os.path.exists(txt_path) else "."
                    progress_q.put(("info", f"Cloning voice '{voice_name}'…"))
                else:
                    # clone_quick: ref audio uploaded separately and stored in a temp file
                    ref_audio = data.get("ref_audio_path", "")
                    ref_text  = data.get("ref_text", ".") or "."
                    if not ref_audio or not os.path.exists(ref_audio):
                        raise ValueError("ref_audio_path not found for quick clone.")
                    progress_q.put(("info", "Quick cloning…"))

                tts_main.generate_audio(
                    model=model, text=text,
                    ref_audio=ref_audio, ref_text=ref_text,
                    output_path=temp_dir
                )
            else:
                raise ValueError(f"Unknown mode: {mode}")

            # Move output file
            progress_q.put(("info", "Saving audio…"))
            final_path = _save_and_get_path(temp_dir, info["output_subfolder"], text)
            progress_q.put(("done", final_path))

        except Exception as exc:
            progress_q.put(("error", str(exc)))

    def _save_and_get_path(temp_folder, subfolder, text_snippet):
        save_path = os.path.join(tts_main.BASE_OUTPUT_DIR, subfolder)
        os.makedirs(save_path, exist_ok=True)

        from datetime import datetime
        timestamp = datetime.now().strftime("%H-%M-%S")
        clean_text = re.sub(r"[^\w\s-]", "", text_snippet)[:tts_main.FILENAME_MAX_LEN].strip().replace(" ", "_") or "audio"
        filename = f"{timestamp}_{clean_text}.wav"
        final_path = os.path.join(save_path, filename)
        source = os.path.join(temp_folder, "audio_000.wav")
        if os.path.exists(source):
            shutil.move(source, final_path)
        if os.path.exists(temp_folder):
            shutil.rmtree(temp_folder, ignore_errors=True)

        # Return a URL-friendly relative path under /outputs/
        rel = os.path.relpath(final_path, tts_main.BASE_OUTPUT_DIR)
        return f"/outputs/{rel}"

    thread = threading.Thread(target=run_generation, daemon=True)
    thread.start()

    def event_stream():
        while True:
            try:
                kind, payload = progress_q.get(timeout=120)
                yield f"event: {kind}\ndata: {json.dumps(payload)}\n\n"
                if kind in ("done", "error"):
                    break
            except queue.Empty:
                yield "event: error\ndata: \"Timeout waiting for generation.\"\n\n"
                break

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/upload_ref", methods=["POST"])
def api_upload_ref():
    """Upload a reference audio for quick cloning. Returns a temp server path."""
    audio_file = request.files.get("audio")
    if not audio_file:
        return jsonify({"error": "No file"}), 400

    ext = os.path.splitext(secure_filename(audio_file.filename))[1]
    tmp_path = os.path.join(os.getcwd(), f"_ref_tmp_{int(time.time())}{ext}")
    audio_file.save(tmp_path)

    clean_wav = tts_main.convert_audio_if_needed(tmp_path)
    if not clean_wav:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        return jsonify({"error": "Could not convert audio."}), 422

    if clean_wav != tmp_path and os.path.exists(tmp_path):
        os.remove(tmp_path)

    return jsonify({"ref_audio_path": clean_wav})


@app.route("/api/outputs")
def api_outputs():
    """List all generated audio files in the outputs directory."""
    outputs = []
    if os.path.exists(tts_main.BASE_OUTPUT_DIR):
        for root, _, files in os.walk(tts_main.BASE_OUTPUT_DIR):
            for f in files:
                if f.endswith(".wav"):
                    full_path = os.path.join(root, f)
                    rel_path = os.path.relpath(full_path, tts_main.BASE_OUTPUT_DIR)
                    stat = os.stat(full_path)
                    outputs.append({
                        "path": rel_path.replace("\\", "/"),
                        "filename": f,
                        "folder": os.path.basename(os.path.dirname(full_path)) if os.path.dirname(full_path) != tts_main.BASE_OUTPUT_DIR else "Root",
                        "size": stat.st_size,
                        "created": stat.st_ctime
                    })
    outputs.sort(key=lambda x: x["created"], reverse=True)
    return jsonify({"outputs": outputs})


@app.route("/api/outputs/<path:filepath>", methods=["DELETE"])
def api_delete_output(filepath):
    """Delete a generated audio file."""
    safe_path = os.path.normpath(filepath)
    if ".." in safe_path or safe_path.startswith("/"):
        abort(400)
    
    full_path = os.path.join(tts_main.BASE_OUTPUT_DIR, safe_path)
    if os.path.exists(full_path):
        os.remove(full_path)
        return jsonify({"deleted": True})
    return jsonify({"deleted": False}), 404


@app.route("/outputs/<path:filename>")
def serve_output(filename):
    """Serve generated audio files."""
    return send_from_directory(tts_main.BASE_OUTPUT_DIR, filename)



# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    os.makedirs(tts_main.BASE_OUTPUT_DIR, exist_ok=True)
    os.makedirs(tts_main.VOICES_DIR, exist_ok=True)

    local_ip = get_local_ip()
    print("\n" + "=" * 50)
    print("  Qwen3-TTS Web UI")
    print("=" * 50)
    print(f"  Local:   http://127.0.0.1:{PORT}")
    print(f"  Network: http://{local_ip}:{PORT}")
    print(f"  Max upload: {MAX_UPLOAD_MB} MB  (set TTS_MAX_UPLOAD_MB to change)")
    print("=" * 50 + "\n")

    app.run(host=HOST, port=PORT, debug=False, threaded=True)
