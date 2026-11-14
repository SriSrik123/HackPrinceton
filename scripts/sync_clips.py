#!/usr/bin/env python3
"""KAN-12 audio sync. Usage:
  python3 sync_clips.py --ref kostas --out offsets.json --work work kostas=a.mp4 valia=b.mp4 ...
Result: offsetSeconds per clip with  clipTime = masterTime - offsetSeconds  (master = the --ref clip's own time).
"""
import argparse, json, os, subprocess, numpy as np, scipy.io.wavfile as w, scipy.signal as sg
SR=16000; HOP=800; FPS=SR/HOP   # 20 feature frames per second

def wav_for(name, path, work):
    out=os.path.join(work, name+".wav")
    if not os.path.exists(out):
        subprocess.run(["ffmpeg","-v","error","-y","-i",path,"-vn","-ac","1","-ar",str(SR),out],check=True)
    return out

def mel_fb(nb=48,fmin=100,fmax=4000,n=1024):
    mel=lambda f:2595*np.log10(1+f/700); inv=lambda m:700*(10**(m/2595)-1)
    pts=inv(np.linspace(mel(fmin),mel(fmax),nb+2)); b=np.floor((n+1)*pts/SR).astype(int); fb=np.zeros((nb,n//2+1))
    for i in range(nb):
        l,c,r=b[i],b[i+1],b[i+2]
        fb[i,l:c]=(np.arange(l,c)-l)/max(c-l,1); fb[i,c:r]=(r-np.arange(c,r))/max(r-c,1)
    return fb
FB=mel_fb()

def features(x):
    _,_,Z=sg.stft(x,fs=SR,nperseg=1024,noverlap=1024-HOP,boundary=None)
    L=np.log(FB@(np.abs(Z)**2)+1e-8); k=int(4*FPS)|1
    mu=np.apply_along_axis(lambda v:np.convolve(np.pad(v,(k//2,k//2),mode="edge"),np.ones(k)/k,"valid"),1,L)
    D=L-mu; return D/(np.linalg.norm(D,axis=0,keepdims=True)+1e-9)

def ncc_curve(a,seg):
    c=sum(sg.correlate(a[b],seg[b],mode="valid",method="fft") for b in range(a.shape[0]))
    e=sum(np.convolve(a[b]**2,np.ones(seg.shape[1]),"valid") for b in range(a.shape[0]))
    return c/np.sqrt(e*np.sum(seg**2)+1e-9)

def bandpass(x):
    b,a=sg.butter(4,[150,1800],btype="band",fs=SR); return sg.filtfilt(b,a,x)

def refine(ref_x, clip_x, coarse, t0, L=15):
    """sample-accurate offset from waveform xcorr near the coarse value; clip window starts at t0 s."""
    seg=clip_x[int(t0*SR):int((t0+L)*SR)]
    if len(seg)<L*SR*0.9: return None
    seg=seg/np.linalg.norm(seg); lo=int((t0+coarse-0.5)*SR); hi=int((t0+coarse+L+0.5)*SR)
    if lo<0 or hi>len(ref_x): return None
    c=sg.correlate(ref_x[lo:hi],seg,mode="valid",method="fft"); i=int(np.argmax(c))
    return (lo+i)/SR - t0

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--ref",required=True); ap.add_argument("--out",default="offsets.json")
    ap.add_argument("--work",default="work"); ap.add_argument("clips",nargs="+"); a=ap.parse_args()
    os.makedirs(a.work,exist_ok=True)
    paths=dict(c.split("=",1) for c in a.clips); wav={n:w.read(wav_for(n,p,a.work))[1].astype(np.float64) for n,p in paths.items()}
    feat={n:features(x) for n,x in wav.items()}; bp={n:bandpass(x) for n,x in wav.items()}
    R=feat[a.ref]; W=int(10*FPS); S=int(5*FPS); result={"reference":a.ref,"convention":"clipTime = masterTime - offsetSeconds","clips":{}}
    result["clips"][a.ref]={"offsetSeconds":0.0,"segments":[{"clipStart":0.0,"clipEnd":len(wav[a.ref])/SR,"offsetSeconds":0.0}]}
    for n in paths:
        if n==a.ref: continue
        rows=[]
        for s in range(0,feat[n].shape[1]-W,S):
            seg=feat[n][:,s:s+W]
            c=ncc_curve(R,seg); i=int(np.argmax(c)); c2=c.copy(); c2[max(0,i-10):i+10]=-1
            rows.append((s/FPS,(i-s)/FPS,float(c[i]),float(c[i]-c2.max())))   # master = clip + offsetSeconds
        offs=np.array([r[1] for r in rows]); groups=[]; used=np.zeros(len(rows),bool)
        for k in np.argsort([-r[2] for r in rows]):             # strongest windows first
            if used[k]: continue
            m=np.abs(offs-offs[k])<0.15; m&=~used
            if m.sum()>=6 and np.median([rows[j][2] for j in np.where(m)[0]])>=0.12:
                groups.append(np.where(m)[0]); used|=m
        segs=[]
        for g in groups:
            ws=[rows[j] for j in g]; med=float(np.median([r[1] for r in ws]))
            fine=[refine(bp[a.ref],bp[n],med,r[0]) for r in ws[:8]]; fine=[f for f in fine if f is not None]
            spread=float(np.ptp(fine)) if len(fine)>1 else None
            off=float(np.median(fine)) if fine and (spread is None or spread<=0.1) else med   # noisy refine: keep the 0.05 s coarse value
            segs.append({"clipStart":min(r[0] for r in ws),"clipEnd":max(r[0] for r in ws)+10,"offsetSeconds":round(off,3),
                         "windowsMatched":len(ws),"medianNCC":round(float(np.median([r[2] for r in ws])),2),
                         "refineSpreadSeconds":None if spread is None else round(spread,3),
                         "confidence":"high (+/-0.02 s)" if (spread is not None and spread<=0.1) else "low (+/-0.15 s, check by ear)"})
        segs.sort(key=lambda s:s["clipStart"])
        result["clips"][n]={"offsetSeconds":segs[0]["offsetSeconds"] if segs else None,"segments":segs}
    # shared range: master-time intervals covered by N clips
    grid=np.arange(0,max(len(x) for x in wav.values())/SR,0.5); cover=np.zeros_like(grid)
    for n,d in result["clips"].items():
        m=np.zeros_like(grid,bool)
        for sgm in d["segments"]:
            m|=(grid>=sgm["clipStart"]+sgm["offsetSeconds"])&(grid<=sgm["clipEnd"]+sgm["offsetSeconds"])
        cover+=m
    shared={}
    for need in (len(paths),len(paths)-1):
        ok=cover>=need; runs=[]; i=0
        while i<len(ok):
            if ok[i]:
                j=i
                while j+1<len(ok) and ok[j+1]: j+=1
                runs.append((float(grid[i]),float(grid[j]))); i=j+1
            else: i+=1
        shared[f"{need}_of_{len(paths)}_clips"]=[{"masterStart":s,"masterEnd":e,"seconds":round(e-s,1)} for s,e in runs if e-s>=20]
    result["sharedMasterRanges"]=shared
    json.dump(result,open(a.out,"w"),indent=2); print(json.dumps(result,indent=2))
if __name__=="__main__": main()
