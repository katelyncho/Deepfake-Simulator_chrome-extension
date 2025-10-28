// Displays randomized pop-up "ads" using the prebuilt images in adPool.

let active = false, timer = null;

function spawnAd(dataUrl){
  const box = document.createElement('div');
  const img = document.createElement('img');
  const x = document.createElement('button');

  Object.assign(box.style, {
    position:'fixed', zIndex:'2147483647',
    boxShadow:'0 8px 24px rgba(0,0,0,.25)',
    background:'#fff', border:'1px solid rgba(0,0,0,.1)',
    borderRadius:'10px', overflow:'hidden'
  });
  Object.assign(img.style, { display:'block', maxWidth:'320px', maxHeight:'240px' });
  Object.assign(x.style, {
    position:'absolute', top:'4px', right:'6px', border:'none',
    background:'rgba(0,0,0,.6)', color:'#fff', width:'24px', height:'24px',
    borderRadius:'12px', cursor:'pointer'
  });
  x.textContent='×';

  img.src = dataUrl;
  box.appendChild(img); box.appendChild(x);
  document.documentElement.appendChild(box);

  const vw = Math.max(document.documentElement.clientWidth, window.innerWidth||0);
  const vh = Math.max(document.documentElement.clientHeight, window.innerHeight||0);
  const w = 340, h = 260;
  box.style.left = Math.max(0, Math.floor(Math.random()*(vw - w))) + 'px';
  box.style.top  = Math.max(0, Math.floor(Math.random()*(vh - h))) + 'px';

  x.addEventListener('click', ()=> box.remove());
}

async function tick(){
  if (!active) return;
  const { adPool = [] } = await chrome.storage.local.get(['adPool']);
  if (adPool.length){
    const img = adPool[Math.floor(Math.random()*adPool.length)];
    spawnAd(img);
  }
  schedule();
}
function schedule(){
  if (!active) return;
  const delay = 2000 + Math.floor(Math.random()*5000); // 2–7s
  timer = setTimeout(tick, delay);
}
function start(){ if (active) return; active = true; schedule(); }
function stop(){ active = false; if (timer){ clearTimeout(timer); timer=null; } }

chrome.runtime.onMessage.addListener((msg)=>{
  if (msg?.type === 'startAds') start();
  if (msg?.type === 'stopAds')  stop();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('isActive' in changes){ changes.isActive.newValue ? start() : stop(); }
  if ('adPool' in changes && active){ tick(); }
});

chrome.storage.local.get(['isActive']).then(({isActive}) => { if (isActive) start(); });
