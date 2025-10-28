// All Mediapipe work happens here once on Start; content.js only displays ad images.

document.addEventListener('DOMContentLoaded', () => {
  const FACE_SCALE = 1.3;
  const btn = document.getElementById('toggle');
  const count = document.getElementById('count');
  const video = document.getElementById('v');
  const canvas = document.getElementById('c');

  let running = false;
  let stream = null;

  const EXT_TRY = ['jpg','jpeg','png','webp'];

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const render = () => { btn.textContent = running ? 'Stop' : 'Start'; };

  // ---------- Mediapipe (popup only) ----------
  let visionLib, filesetPromise, segmenterPromise;
  async function vision(){ return visionLib ||= await import(chrome.runtime.getURL('lib/vision_bundle.mjs')); }
  async function fileset(){ return filesetPromise ||= (await vision()).FilesetResolver.forVisionTasks(chrome.runtime.getURL('wasm')); }
  async function getSegmenter(){
    if (!segmenterPromise){
      const v = await vision(), fs = await fileset();
      segmenterPromise = v.ImageSegmenter.createFromOptions(fs, {
        baseOptions: { modelAssetPath: chrome.runtime.getURL('models/selfie_multiclass_256x256.tflite') },
        runningMode: 'IMAGE', outputCategoryMask: true
      });
    } return segmenterPromise;
  }
  function faceIdxOf(seg){ const L = seg.getLabels?.() || []; return L.findIndex(l => /face/i.test(String(l))); }
  function maskArray(res){
    if (!res?.categoryMask) return null;
    if (res.categoryMask.getAsUint8Array) return res.categoryMask.getAsUint8Array();
    const f = res.categoryMask.getAsFloat32Array?.(); if (!f) return null;
    const u = new Uint8Array(f.length); for (let i=0;i<f.length;i++) u[i] = Math.round(f[i]); return u;
  }
  // --------------------------------------------

  // ---------- Helpers ----------
  function loadImage(src){
    return new Promise((res,rej)=>{ const img=new Image(); img.onload=()=>res(img); img.onerror=rej; img.src=src; });
  }
  async function readBaseNames(){
    const res = await fetch(chrome.runtime.getURL('images/index.json'));
    const arr = res.ok ? await res.json() : [];
    return Array.isArray(arr)
      ? arr.map(s => String(s).trim().replace(/\.(png|jpe?g|webp)$/i,''))
      : [];
  }
  async function resolveImagePath(entry){
    const base = String(entry).trim().replace(/\.(png|jpe?g|webp)$/i,'');
    const tries = [
      `images/${entry}`,
      `images/${base}.jpg`,
      `images/${base}.jpeg`,
      `images/${base}.png`,
      `images/${base}.webp`
    ];
    for (const rel of tries){
      try { await loadImage(chrome.runtime.getURL(rel)); return rel; } catch {}
    }
    return null;
  }
  function approxBytes(dataUrl){
    const b64 = (dataUrl.split(',')[1] || '');
    return Math.floor(b64.length * 0.75);
  }
  // --------------------------------

  chrome.storage.local.get(['isActive']).then(({isActive}) => { running = !!isActive; render(); });

  btn.addEventListener('click', async () => {
    running = !running; render();
    if (!running){
      await chrome.storage.local.set({ isActive:false, adPool: [] });
      const tabs = await chrome.tabs.query({ url: ["http://*/*","https://*/*"] });
      for (const t of tabs) { chrome.tabs.sendMessage(t.id, { type: "stopAds" }).catch(()=>{}); }
      return;
    }

    try {
      // 1) Capture once
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
      video.srcObject = stream; await video.play();
      for (let i=3;i>0;i--){ count.textContent = i; await sleep(1000); }
      count.textContent = 'smile:D';

      // 2) Snapshot
      const ctx = canvas.getContext('2d');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // 3) Invert mask (keep only face)
      const seg = await getSegmenter(), idx = faceIdxOf(seg);
      if (idx >= 0){
        const bmp = await createImageBitmap(canvas);
        const res = seg.segment(bmp), mask = maskArray(res);
        if (mask){
          const img = ctx.getImageData(0,0,canvas.width,canvas.height), p=img.data;
          for (let i=0,m=0;i<p.length;i+=4,m++) if (mask[m] !== idx){ p[i]=0;p[i+1]=0;p[i+2]=0; }
          ctx.putImageData(img,0,0);
        }
      }

      // 4) Crop to bbox + make black transparent -> faceCutout
      const cut = document.createElement('canvas'), cctx = cut.getContext('2d');
      let minX=canvas.width, minY=canvas.height, maxX=-1, maxY=-1;
      { const d = ctx.getImageData(0,0,canvas.width,canvas.height).data;
        for (let y=0,k=0;y<canvas.height;y++) for (let x=0;x<canvas.width;x++,k+=4){
          if (d[k]||d[k+1]||d[k+2]){ if (x<minX)minX=x; if (y<minY)minY=y; if (x>maxX)maxX=x; if (y>maxY)maxY=y; }
        }
      }
      if (maxX<0){ cut.width=canvas.width; cut.height=canvas.height; cctx.drawImage(canvas,0,0); }
      else {
        const bw=maxX-minX+1, bh=maxY-minY+1, pad=0.12;
        const sx=Math.max(0, Math.floor(minX-bw*pad));
        const sy=Math.max(0, Math.floor(minY-bh*pad));
        const sw=Math.min(canvas.width - sx, Math.ceil(bw*(1+2*pad)));
        const sh=Math.min(canvas.height - sy, Math.ceil(bh*(1+2*pad)));
        cut.width=sw; cut.height=sh; cctx.drawImage(canvas,sx,sy,sw,sh,0,0,sw,sh);
        const img=cctx.getImageData(0,0,sw,sh), p=img.data;
        for (let i=0;i<p.length;i+=4) if(p[i]===0&&p[i+1]===0&&p[i+2]===0) p[i+3]=0;
        cctx.putImageData(img,0,0);
      }
      const faceCutoutUrl = cut.toDataURL('image/png'); // keep alpha

      // 5) Build adPool (randomized host images from images/index.json)
      const names = await readBaseNames();
      const adPool = [];
      const MAX_BYTES = 4_500_000; // keep under storage quota
      let total = 0;

      for (const name of names){
        const rel = await resolveImagePath(name);
        if (!rel) continue;

        const host = await loadImage(chrome.runtime.getURL(rel));

        // base canvas (downscale to keep size reasonable)
        const MAX_W = 1024, MAX_H = 1024;
        const s = Math.min(1, MAX_W/host.width, MAX_H/host.height);
        const outW = Math.max(1, Math.floor(host.width * s));
        const outH = Math.max(1, Math.floor(host.height * s));

        const baseC = document.createElement('canvas');
        baseC.width = outW; baseC.height = outH;
        const bctx = baseC.getContext('2d');
        bctx.drawImage(host, 0, 0, outW, outH);

        // try to place on host face (segment host)
        try {
          const hbmp = await createImageBitmap(baseC);
          const seg2 = await getSegmenter();
          const idx2 = faceIdxOf(seg2);
          const r = seg2.segment(hbmp), m = maskArray(r);

          if (m && idx2 >= 0 && m.length === outW*outH) {
            let minXh=outW, minYh=outH, maxXh=-1, maxYh=-1;
            for (let y=0,k=0;y<outH;y++) for (let x=0;x<outW;x++,k++){
              if (m[k]===idx2){ if (x<minXh)minXh=x; if (y<minYh)minYh=y; if (x>maxXh)maxXh=x; if (y>maxYh)maxYh=y; }
            }
            if (maxXh >= 0) {
              const x=minXh, y=minYh, w=maxXh-minXh+1, h=maxYh-minYh+1;
              const face = await loadImage(faceCutoutUrl);
              const newW = w * FACE_SCALE;
              const newH = h * FACE_SCALE;
              bctx.drawImage(face, x - (newW - w)/2, y - (newH - h)/2, newW, newH);
            } else {
              const face = await loadImage(faceCutoutUrl);
              const w = Math.floor(outW*0.3), h = Math.floor(face.height*(w/face.width));
              const newW = w * FACE_SCALE;
              const newH = h * FACE_SCALE;
              bctx.drawImage(face, (outW - newW)/2, (outH - newH)/2, newW, newH);
            }
          } else {
            const face = await loadImage(faceCutoutUrl);
            const w = Math.floor(outW*0.3), h = Math.floor(face.height*(w/face.width));
            const newW = w * FACE_SCALE;
            const newH = h * FACE_SCALE;
            bctx.drawImage(face, (outW - newW)/2, (outH - newH)/2, newW, newH);
          }
        } catch {
          const face = await loadImage(faceCutoutUrl);
          const w = Math.floor(outW*0.3), h = Math.floor(face.height*(w/face.width));
          const newW = w * FACE_SCALE;
          const newH = h * FACE_SCALE;
          bctx.drawImage(face, (outW - newW)/2, (outH - newH)/2, newW, newH);
        }

        // compress
        const jpeg = baseC.toDataURL('image/jpeg', 0.6);
        const bytes = approxBytes(jpeg);
        if (total + bytes > MAX_BYTES) break;
        adPool.push(jpeg);
        total += bytes;
      }

      await chrome.storage.local.set({ isActive: true, adPool, faceCutout: faceCutoutUrl });

      // nudge existing tabs to start immediately
      const tabs = await chrome.tabs.query({ url: ["http://*/*","https://*/*"] });
      for (const t of tabs) { chrome.tabs.sendMessage(t.id, { type: "startAds" }).catch(()=>{}); }

    } catch (e) {
      running = false; render();
      await chrome.storage.local.set({ isActive:false, adPool: [] });
    } finally {
      count.textContent='';
      if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    }
  });

  render();
});
