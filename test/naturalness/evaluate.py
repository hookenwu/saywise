"""Objective TTS evaluation (specs/voice-copilot-natural-delivery/research.md §2).
usage: <venv>/bin/python test/naturalness/evaluate.py <expDir>/manifest.json <expDir>/eval.json
manifest: [{"file":..., "cond":..., "text":..., "lang":"en"|"zh", "ref": optional}]
Per file: UTMOS22-strong (naturalness MOS predictor), ECAPA speaker cosine vs. a reference
centroid (all files of cond "__ref__" or first condition), Whisper WER/CER, prosody stats.
"""
import sys, json, os, re, subprocess, tempfile
os.environ.setdefault('TORCH_HOME', os.path.expanduser('~/.cache/saywise-eval/torch'))
os.environ.setdefault('HF_HOME', os.path.expanduser('~/.cache/saywise-eval/hf'))
import numpy as np, torch, torchaudio
torch.set_num_threads(2)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prosody import analyse

man = json.load(open(sys.argv[1]))
ref_cond = next((m['cond'] for m in man if m.get('ref')), man[0]['cond'])


def wav16(path):
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-ac', '1', '-ar', '16000', tmp], check=True)
    import soundfile as sf
    a, sr = sf.read(tmp, dtype='float32')
    w = torch.from_numpy(a).unsqueeze(0)
    os.unlink(tmp)
    return w, tmp


utmos = torch.hub.load('tarepan/SpeechMOS:v1.2.0', 'utmos22_strong', trust_repo=True, skip_validation=True)
from speechbrain.inference.speaker import EncoderClassifier
ecapa = EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
                                       savedir=os.path.expanduser('~/.cache/saywise-eval/ecapa'))
from faster_whisper import WhisperModel
whisper = WhisperModel('small', device='cpu', compute_type='int8',
                       download_root=os.path.expanduser('~/.cache/saywise-eval/whisper'))


NUM = {'20th': 'twentieth', '27th': 'twenty seventh', "we're": 'we are', "it's": 'it is'}
FILLERS = {'uh', 'um', 'erm', 'hmm', 'mm'}


def norm_en(s):
    s = s.lower().replace("’", "'")
    for k, v in NUM.items():
        s = s.replace(k, v)
    s = re.sub(r"[^a-z0-9' ]+", ' ', s)
    return [w for w in s.split() if w not in FILLERS]


def norm_zh(s):
    from zhconv import convert
    s = convert(s, 'zh-cn')
    return list(re.sub(r'[^一-鿿0-9a-zA-Z]', '', s))


def edit(a, b):
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
            prev = cur
    return d[-1] / max(1, len(a))


rows = []
embs = {}
for m in man:
    w, _ = wav16(m['file'])
    with torch.no_grad():
        mos = float(utmos(w, 16000).item())
        e = ecapa.encode_batch(w).squeeze()
    embs[m['file']] = e / e.norm()
    segs, _ = whisper.transcribe(w.squeeze(0).numpy(), language=m.get('lang', 'en'), beam_size=1)
    hyp = ''.join(s.text for s in segs)
    if m.get('lang', 'en') == 'zh':
        err = edit([c for c in norm_zh(m['text']) if c not in '嗯呃啊'], [c for c in norm_zh(hyp) if c not in '嗯呃啊'])
    else:
        err = edit(norm_en(re.sub(r'<[^>]+>', ' ', m['text'])), norm_en(hyp))
    r = dict(cond=m['cond'], utmos=round(mos, 3), err=round(err, 3), hyp=hyp.strip())
    r.update(analyse(m['file']))
    rows.append(r)
    print(json.dumps(r, ensure_ascii=False), flush=True)

ref = torch.stack([embs[m['file']] for m in man if m['cond'] == ref_cond]).mean(0)
ref = ref / ref.norm()
for m, r in zip(man, rows):
    r['spk_sim'] = round(float(embs[m['file']] @ ref), 4)

json.dump(rows, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)

# summary per condition
conds = []
for r in rows:
    if r['cond'] not in conds:
        conds.append(r['cond'])
keys = ['utmos', 'spk_sim', 'err', 'f0_sd_st', 'f0_range_st', 'intensity_sd_db', 'pauses', 'pause_mean_ms', 'dur_s']
print('\n' + 'cond'.ljust(26) + ''.join(k.rjust(11) for k in keys) + '      n')
for c in conds:
    rs = [r for r in rows if r['cond'] == c]
    line = c.ljust(26)
    for k in keys:
        v = np.array([r[k] for r in rs], dtype=float)
        line += f'{v.mean():11.3f}'
    print(line + f'{len(rs):7d}')
