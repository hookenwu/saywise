"""Offline pause shaper: shorten internal silences > 250ms to target = 180 + 0.45*(len-180) ms."""
import sys, subprocess, numpy as np, soundfile as sf, tempfile, os
def shape(src, dst, sr=24000):
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
    subprocess.run(['ffmpeg','-v','error','-y','-i',src,'-ac','1','-ar',str(sr),tmp],check=True)
    x,_ = sf.read(tmp, dtype='float32'); os.unlink(tmp)
    hop = int(sr*0.01); n = len(x)//hop
    e = np.array([np.sqrt(np.mean(x[i*hop:(i+1)*hop]**2)+1e-12) for i in range(n)])
    db = 20*np.log10(e); sil = db < (db.max()-38)
    out=[]; i=0
    # keep leading/trailing as-is
    voiced = np.where(~sil)[0]; a,b = voiced[0], voiced[-1]
    out.append(x[:a*hop]); i=a
    while i<=b:
        if sil[i]:
            j=i
            while j<=b and sil[j]: j+=1
            L=(j-i)*10
            if L>250:
                T=int(180+0.45*(L-180)); keep=T//10
                h=keep//2
                seg=np.concatenate([x[i*hop:(i+h)*hop], x[(j-(keep-h))*hop:j*hop]])
                out.append(seg)
            else: out.append(x[i*hop:j*hop])
            i=j
        else:
            j=i
            while j<=b and not sil[j]: j+=1
            out.append(x[i*hop:j*hop]); i=j
    out.append(x[(b+1)*hop:])
    y=np.concatenate(out)
    tw=dst.replace('.mp3','.wav'); sf.write(tw,y,sr)
    subprocess.run(['ffmpeg','-v','error','-y','-i',tw,'-b:a','64k',dst],check=True); os.unlink(tw)
import json
man=json.load(open('e3/manifest.json'))
add=[]
for m in man:
    if m['cond']=='fill_ctx':
        d=m['file'].replace('fill_ctx__','fill_shaped__'); shape(m['file'],d)
        add.append({**m,'file':d,'cond':'fill_shaped','ref':False})
json.dump(man+add,open('e3/manifest.json','w'),indent=1)
print(len(add))
