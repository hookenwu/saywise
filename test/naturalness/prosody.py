"""Prosody statistics for TTS samples.  usage: prosody.py file.mp3 [...]  -> JSON lines
f0_mean_hz, f0_sd_st (pitch variability in semitones re. speaker median — monotony indicator),
f0_range_st (5-95 pct), intensity_sd_db, pauses (#silences >=150 ms inside speech),
pause_mean_ms, speech_ratio, dur_s.
"""
import sys, json, subprocess, tempfile, os
import numpy as np
import parselmouth
from parselmouth.praat import call


def load(path):
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-ac', '1', '-ar', '16000', tmp], check=True)
    s = parselmouth.Sound(tmp)
    os.unlink(tmp)
    return s


def analyse(path):
    snd = load(path)
    dur = snd.get_total_duration()
    pitch = snd.to_pitch_ac(time_step=0.01, pitch_floor=60, pitch_ceiling=500)
    f0 = pitch.selected_array['frequency']
    f0 = f0[f0 > 0]
    med = np.median(f0)
    st = 12 * np.log2(f0 / med)
    inten = snd.to_intensity(minimum_pitch=75, time_step=0.01)
    iv = inten.values[0]
    thr = np.max(iv) - 30
    voiced = iv > thr
    # trim leading/trailing silence
    idx = np.where(voiced)[0]
    core = voiced[idx[0]:idx[-1] + 1] if len(idx) else voiced
    # internal pauses >= 150 ms
    pauses, run = [], 0
    for v in core:
        if not v:
            run += 1
        else:
            if run * 10 >= 150:
                pauses.append(run * 10)
            run = 0
    speech_ratio = core.mean() if len(core) else 0
    return dict(
        file=os.path.basename(path), dur_s=round(dur, 2),
        f0_mean_hz=round(float(np.mean(f0)), 1),
        f0_sd_st=round(float(np.std(st)), 2),
        f0_range_st=round(float(np.percentile(st, 95) - np.percentile(st, 5)), 2),
        intensity_sd_db=round(float(np.std(iv[iv > thr])), 2),
        pauses=len(pauses), pause_mean_ms=round(float(np.mean(pauses)), 0) if pauses else 0,
        speech_ratio=round(float(speech_ratio), 3),
        lead_sil_ms=int(idx[0] * 10) if len(idx) else 0,
    )


if __name__ == '__main__':
    for p in sys.argv[1:]:
        print(json.dumps(analyse(p)))
