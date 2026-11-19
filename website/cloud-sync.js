(() => {
  'use strict';
  const core = window.CQSyncCore;
  const hooks = new Map();
  const sessionKey = 'cq-shared-session-v1';
  const initialHash = new URLSearchParams(location.hash.slice(1));
  let session, engine, applying = false, running = false, joining = false, storageError = false;
  let timer, failures = 0, invitation;
  let lastApplied;
  const config = window.CQ_SYNC_CONFIG || {};
  const ready = /^https:\/\/[a-z0-9.-]+\/?$/.test(config.url || '') &&
    (/^sb_publishable_/.test(config.publishableKey || '') || legacyAnon(config.publishableKey));
  function legacyAnon(key) {
    try { return JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).role === 'anon'; }
    catch { return false; }
  }
  function store(key,value) {
    try { localStorage.setItem(key,JSON.stringify(value)); return true; }
    catch { storageError = true; return false; }
  }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  let tabId;
  try { tabId=sessionStorage.getItem('cq-tab-v1')||crypto.randomUUID(); sessionStorage.setItem('cq-tab-v1',tabId); }
  catch { tabId=crypto.randomUUID(); }
  const outboxKey = room => 'cq-outbox-v1-'+room+'-'+tabId;
  function loadDraft(room) {
    const exact=load(outboxKey(room)); if(exact) return exact;
    // sessionStorage ends with a closed tab; the durable outbox must survive it.
    try {
      return Object.keys(localStorage).filter(key=>key.startsWith('cq-outbox-v1-'+room+'-'))
        .map(load).filter(Boolean).sort((a,b)=>(b.savedAt||0)-(a.savedAt||0))[0] || null;
    } catch {return null;}
  }
  const validSession = s => s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s.room) && /^[a-f0-9]{64}$/.test(s.secret);
  function readState() { return Object.fromEntries([...hooks].map(([name,h]) => [name,h.read()])); }
  function apply(fields) {
    applying = true;
    try {
      const state = core.inflate(fields,hooks.get('plan').read());
      for (const [name,h] of hooks) h.apply(state[name]);
    } finally { applying = false; }
  }
  function status(text, tone = '') {
    const node = document.getElementById('cloud-status');
    if (!node) return;
    if(node.textContent!==text) node.textContent = text; node.dataset.tone = tone;
    for (const id of ['plan-status','packing-save-status','status']) {
      const target = document.getElementById(id);
      if (target && target.textContent!==text) target.textContent = text;
    }
  }
  function formatValue(field,value) {
    if (value === null || value === undefined) return '未选择';
    if (typeof value === 'boolean') return value ? '已勾选' : '未勾选';
    if (typeof value === 'object') return `${value.active ? '加入' : '取消'} · ${{morning:'早上',afternoon:'下午',evening:'晚上'}[value.slot] || value.slot}`;
    return places.get(value)?.name || String(value);
  }
  let places = new Map();
  function fieldLabel(field) {
    const [kind,a,b] = field.split('.');
    if (kind === 'day') return `12月${Number(a)}日 · ${places.get(b)?.name || b}`;
    if (kind === 'position') return `12月${Number(a)}日 · 当前位置`;
    if (kind === 'stay') return '两晚住宿候选';
    if (kind === 'packing') return document.getElementById('packing-'+a)?.closest('label')?.querySelector('strong')?.textContent || '行李清单';
    return a?.startsWith('pick-') ? `收藏 · ${places.get(a.slice(5))?.name || a.slice(5)}` : '出发前确认事项';
  }
  function render(fields,s) {
    if(!lastApplied || !core.equal(lastApplied,fields)) {apply(fields);lastApplied=core.copy(fields);}
    document.getElementById('cloud-create').hidden = !!session;
    document.getElementById('cloud-share').hidden = !session;
    const conflicts = document.getElementById('cloud-conflicts');
    conflicts.replaceChildren(); conflicts.hidden = !s.conflicts.length;
    if (s.conflicts.length) {
      const intro = document.createElement('p'); intro.textContent = '你们改到了同一项，请选要保留的安排。其他项目仍可同步。'; conflicts.append(intro);
      for (const field of s.conflicts) {
        const row = document.createElement('div'); row.className = 'cloud-conflict';
        const title = document.createElement('strong'); title.textContent = fieldLabel(field);
        const values = document.createElement('p');
        values.textContent = `这台手机：${formatValue(field,engine.pending[field].after)}；共享计划：${formatValue(field,engine.base[field])}`;
        row.append(title,values);
        for (const [choice,label] of [['mine','保留这台手机的修改'],['server','采用共享计划']]) {
          const button = document.createElement('button'); button.type='button'; button.textContent=label;
          button.addEventListener('click',()=>{engine.resolve(field,choice); schedule(0);}); row.append(button);
        }
        conflicts.append(row);
      }
      status(`${s.conflicts.length}项修改需要你确认。`,'warning');
    } else if (s.pending) status(storageError ? '修改尚未同步，本机缓存也不可用，请保持此页打开。' : navigator.onLine === false ? `网络未连接，${s.pending}项修改留在此手机，联网后继续同步。` : `正在保存${s.pending}项修改…`,'pending');
    else status(`已同步 · 共享版本${s.revision}${storageError ? '。此浏览器无法记住加入信息，请保留邀请链接。' : ''}`,'saved');
  }
  async function rpc(name,args) {
    const headers = {'Content-Type':'application/json',apikey:config.publishableKey};
    if (legacyAnon(config.publishableKey)) headers.Authorization = 'Bearer '+config.publishableKey;
    const response = await fetch(config.url.replace(/\/$/,'')+'/rest/v1/rpc/'+name,{
      method:'POST',headers,body:JSON.stringify(args),signal:AbortSignal.timeout(12000),credentials:'omit',referrerPolicy:'no-referrer'
    });
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403 ? 'invitation' : 'network');
      error.status = response.status; throw error;
    }
    const data = await response.json(); core.validateData(data.data); return data;
  }
  function args() { return {p_room:session.room,p_secret:session.secret}; }
  function schedule(delay=400) { clearTimeout(timer); timer=setTimeout(tick,delay); }
  async function tick() {
    if (!session || !engine || running || joining) return;
    if (navigator.onLine === false) { status(storageError ? '网络未连接，本机缓存不可用，请保持此页打开。' : '网络未连接。修改留在此手机，联网后继续同步。','warning'); schedule(5000); return; }
    running = true;
    try {
      const request = engine.request();
      if (request) {
        const response = await rpc('cq_patch_trip',{...args(),p_request_id:request.requestId,p_changes:request.changes});
        engine.complete(request,response);
      } else engine.receive(await rpc('cq_read_trip',args()));
      failures = 0;
    } catch (error) {
      if (error.message === 'invitation') {
        status('邀请信息未通过验证。此手机的修改已保留，请重新加入共享行程。','warning');
        clearTimeout(timer); running=false; return;
      }
      failures++;
      status(engine.status().pending ? storageError ? '暂未保存到云端，本机缓存不可用，请保持此页打开。' : '暂未保存到云端，修改已留在此手机；连接恢复后会重试。' : '暂时连不上云端，当前显示上次保存的行程。','warning');
    } finally { running=false; }
    schedule(failures ? Math.min(30000,1500*2**Math.min(failures,5)) : engine.status().pending && !engine.status().conflicts.length ? 400 : document.hidden ? 30000 : 5000);
  }
  async function join(candidate, create=false) {
    if (!validSession(candidate) || !ready || joining || running) return;
    joining=true; status(create ? '正在创建共享行程…' : '正在读取共享行程…','pending');
    try {
      const state = readState();
      const snapshot = await rpc(create?'cq_create_trip':'cq_read_trip',{
        p_room:candidate.room,p_secret:candidate.secret,...(create?{p_data:core.flatten(state)}:{})
      });
      // Back up the current device before replacing it with another shared plan.
      if (!session || session.room !== candidate.room) store('cq-before-join-v1',{at:new Date().toISOString(),state});
      activate(candidate,snapshot);
      if(create) engine.edit(core.flatten(state));
      document.getElementById('cloud-dialog').close();
      schedule(0);
    } catch(error) {
      status(error.message==='invitation' ? '这条邀请链接无效或口令不正确，原来的本机行程没有改变。' : '连接未成功，原来的本机行程没有改变，请稍后重试。','warning');
      if (create) invitation=candidate; // Reuse the same creation ID/key if the response was lost.
    } finally {joining=false;}
  }
  function activate(candidate,snapshot,saved=loadDraft(candidate.room)) {
    session=candidate; store(sessionKey,session);
    let initialized=false;
    engine=new core.Engine({snapshot,saved,
      save:value=>store(outboxKey(session.room),{...value,savedAt:Date.now()}),
      changed:(fields,s)=>{if(initialized) render(fields,s);}
    });
    initialized=true; render(engine.view(),engine.status());
    try {history.replaceState(null,'',shareURL());}catch{}
  }
  function shareURL(candidate=session) {
    const url=new URL(location.href); url.search='';
    const tab=document.querySelector('[data-tab][aria-selected="true"]')?.dataset.tab||'trip';
    url.hash=new URLSearchParams({cq:candidate.room,code:candidate.secret,tab}).toString(); return url.href;
  }
  function exportBackup() {
    const payload={format:'cq-trip-backup-v1',at:new Date().toISOString(),state:readState()};
    const file=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const link=document.createElement('a'); link.href=URL.createObjectURL(file); link.download='重庆行程备份.json';
    link.click(); setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  }
  function showDialog(mode='join') {
    const dialog=document.getElementById('cloud-dialog');
    const sharing=mode==='share' && session;
    document.getElementById('cloud-dialog-title').textContent=sharing?'邀请另一台手机':'加入共享行程';
    document.getElementById('cloud-link-label').textContent=sharing?'复制链接，发给一起出行的人':'粘贴收到的完整邀请链接';
    const input=document.getElementById('cloud-link'); input.value=sharing?shareURL():''; input.readOnly=!!sharing;
    document.getElementById('cloud-copy').hidden=!sharing;
    document.getElementById('cloud-join-submit').hidden=!!sharing;
    document.getElementById('cloud-dialog-status').textContent='';
    dialog.showModal();
  }
  window.CQSync={
    register(name,read,applyState){hooks.set(name,{read,apply:applyState});},
    changed(){if(engine&&!applying){engine.edit(core.flatten(readState()));schedule();}},
    hashForTab(name){
      const candidate=session || (validSession({room:initialHash.get('cq'),secret:initialHash.get('code')})
        ? {room:initialHash.get('cq'),secret:initialHash.get('code')} : null);
      return candidate ? '#'+new URLSearchParams({cq:candidate.room,code:candidate.secret,tab:name}).toString() : '#'+name;
    },
    get connected(){return !!engine;}
  };
  addEventListener('DOMContentLoaded',()=>{
    places=new Map(JSON.parse(document.getElementById('planner-data').textContent).places.map(p=>[p.id,p]));
    document.getElementById('cloud-create').disabled=!ready;
    document.getElementById('cloud-join').disabled=!ready;
    status(ready?'尚未加入共享行程。当前修改保存在此手机。':'云端服务尚未接通，当前修改仍只保存在此手机。');
    document.getElementById('cloud-create').addEventListener('click',()=>{
      if(!invitation) {
        const bytes=crypto.getRandomValues(new Uint8Array(32));
        invitation={room:crypto.randomUUID(),secret:[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('')};
      }
      // Persist before submitting so a timeout/reload retries the same creation.
      if(!store('cq-pending-create-v1',invitation)) {status('此浏览器不能保存邀请信息，请换用手机的普通浏览器后创建。','warning');return;}
      join(invitation,true).then(()=>{if(engine){try{localStorage.removeItem('cq-pending-create-v1');}catch{} showDialog('share');}});
    });
    document.getElementById('cloud-join').addEventListener('click',()=>showDialog());
    document.getElementById('cloud-share').addEventListener('click',()=>showDialog('share'));
    document.getElementById('cloud-close').addEventListener('click',()=>document.getElementById('cloud-dialog').close());
    document.getElementById('cloud-export').addEventListener('click',exportBackup);
    document.getElementById('cloud-copy').addEventListener('click',async()=>{
      try {await navigator.clipboard.writeText(shareURL());document.getElementById('cloud-dialog-status').textContent='已复制，可以发给她了。';}
      catch{document.getElementById('cloud-link').select();document.getElementById('cloud-dialog-status').textContent='请长按链接，选择复制。';}
    });
    document.getElementById('cloud-join-submit').addEventListener('click',()=>{
      try {
        const url=new URL(document.getElementById('cloud-link').value.trim());
        if(url.origin!==location.origin||url.pathname!==location.pathname) throw new Error('wrong-site');
        const params=new URLSearchParams(url.hash.slice(1));
        const candidate={room:params.get('cq'),secret:params.get('code')};
        if(!validSession(candidate)) throw new Error('wrong-invite');
        if(engine?.status().pending) {document.getElementById('cloud-dialog-status').textContent='这台手机还有未同步的修改，请先同步或处理冲突，再切换行程。';return;}
        join(candidate);
      } catch {document.getElementById('cloud-dialog-status').textContent='请粘贴这个网站生成的完整邀请链接。';}
    });
    invitation=load('cq-pending-create-v1'); if(!validSession(invitation)) invitation=null;
    const fromLink={room:initialHash.get('cq'),secret:initialHash.get('code')};
    const saved=load(sessionKey);
    const candidate=validSession(fromLink)?fromLink:validSession(saved)?saved:null;
    const cached=candidate&&loadDraft(candidate.room);
    if(ready&&candidate&&cached?.base) {
      try {
        activate(candidate,{data:cached.base,revision:cached.revision},cached);
        status('已恢复这台手机的行程，正在核对云端最新安排…','pending'); schedule(0);
      } catch {status('本机缓存无法恢复，请用邀请链接重新加入。','warning');}
    } else if(ready&&candidate) join(candidate);
    addEventListener('online',()=>schedule(0));
    addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0);});
    addEventListener('pagehide',()=>{if(engine)store(outboxKey(session.room),{...engine.state(),savedAt:Date.now()});});
    addEventListener('storage',event=>{
      // Another tab is a separate editor; fetching the server keeps CAS protection.
      if(event.key===sessionKey) {
        const updated=load(sessionKey);
        if(validSession(updated)&&session&&updated.room!==session.room) status('另一个标签页加入了不同的行程；此页继续保留当前计划。','warning');
      }
      if(session&&event.key?.startsWith('cq-outbox-v1-'+session.room)) schedule(0);
    });
  });
})();
