"""Bounded, offline SenseVoice worker. WAV input is read from stdin."""
import array
import io
import json
import pathlib
import re
import sys
import wave


def transcribe(folder, language, filename=None):
    source = filename
    if source is None:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError()
        source = io.BytesIO(raw)
    with wave.open(source, 'rb') as audio:
        rate = audio.getframerate()
        frames = audio.getnframes()
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or rate != 16000 or not 0 < frames <= rate * (300 if filename else 60):
            raise ValueError()
        pcm = audio.readframes(frames)
    if len(pcm) != frames * 2:
        raise ValueError()
    sys.path.insert(0, str(folder / 'site'))
    import sherpa_onnx
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(folder / 'model.int8.onnx'), tokens=str(folder / 'tokens.txt'),
        language=language, use_itn=True, provider='cpu', num_threads=2,
    )
    stream = recognizer.create_stream()
    samples = array.array('h', pcm)
    if sys.byteorder != 'little':
        samples.byteswap()
    normalized = array.array('f', (sample / 32768 for sample in samples))
    stream.accept_waveform(rate, normalized)
    recognizer.decode_stream(stream)
    return re.sub(r'<\|[^|]{1,40}\|>', '', stream.result.text).strip()[:8000 if filename else 4000]


if __name__ == '__main__':
    try:
        if sys.argv[2] not in ('auto', 'zh', 'en', 'yue', 'ja', 'ko'):
            raise ValueError()
        text = transcribe(pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
        print(json.dumps({'text': text}))
    except Exception:
        print('{"error":"VOICE_SENSEVOICE_FAILED"}')
        sys.exit(1)
