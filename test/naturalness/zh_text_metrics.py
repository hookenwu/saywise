"""Chinese Humanize text-fidelity counts (humanize-gateway research.md). Usage: python3 zh_text_metrics.py <name> ... reads <name>.json rows {id,r,lang,t,out,must,ttft}."""
import json,re,statistics as st,sys
ADD=['估计','可能','大概','应该','也许','左右','差不多','肯定','一定','非得','其实','恐怕','怕是','保证','真']
HEDGE=['我觉得','好像','可能','预计','左右','大概']
def cjk(s): return len(re.findall(r'[一-鿿]',s))
for b in sys.argv[1:]:
  rows=json.load(open(f'{b}.json'))
  zh=[r for r in rows if r['lang']=='zh']; en=[r for r in rows if r['lang']=='en']
  lang_ok=sum(1 for r in zh if cjk(r['out'])*3>=len(re.findall('[A-Za-z]',r['out'])))+sum(1 for r in en if cjk(r['out'])==0)
  miss=[(r['id'],r['r'],m) for r in rows for m in r['must'] if m not in r['out']]
  drift=[(r['id'],r['r'],w) for r in zh for w in ADD if w in r['out'] and w not in r['t'] and w!='其实']
  dropped=[(r['id'],r['r'],h) for r in zh for h in HEDGE if h in r['t'] and h not in r['out']]
  fill=sum(r['out'].count('嗯')+r['out'].count('呃') for r in zh)
  nage=sum(max(0,r['out'].count('那个')-r['t'].count('那个')) for r in zh)
  multi=sum(1 for r in zh if r['out'].count('嗯')+r['out'].count('呃')+max(0,r['out'].count('那个')-r['t'].count('那个'))>=2)
  qishi=sum(1 for r in zh if '其实' in r['out'] and '其实' not in r['t'])
  t=sorted(r['ttft'] for r in zh); te=[r['ttft'] for r in en]
  print(f"\n== {b}: lang_ok={lang_ok}/{len(rows)} | zh TTFT median {st.median(t)} p90 {t[int(len(t)*0.9)-1]} | en median {st.median(te)}")
  print(f" 嗯/呃={fill} added 那个={nage} outputs≥2 hesitations={multi}/{len(zh)} added 其实={qishi}/{len(zh)} length ratio={st.mean(len(r['out'])/len(r['t']) for r in zh):.2f}")
  print(' missing key tokens:',miss)
  print(' added certainty/attitude words (excluding 其实):',len(drift),drift)
  print(' dropped source hedges:',dropped)
