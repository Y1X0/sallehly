let state={
  user:null,
  meta:{services:[],packages:[],paymentMethods:[],cities:[]},
  tab:'dash',
  gps:null,
  notifications:[],
  unread:0
};
let chatTimer=null, activeChatId=null;
let socket=null;
function setupSocket(){
  if(typeof io==='undefined' || socket) return;

  socket = io();

  socket.on('connect', ()=>{
    console.log('Socket connected:', socket.id);
  });
  socket.on('chat-message-notify', data=>{
    console.log('CHAT NOTIFY RECEIVED', data);
  
    if(!state.user) return;
    if(Number(data.senderId) === Number(state.user.id)) return;
  
    const isReceiver =
      Number(state.user.id) === Number(data.customerId) ||
      Number(state.user.id) === Number(data.technicianId);
  
    if(!isReceiver) return;
  
    addBellNotification(
      'chat',
      'رسالة جديدة',
      'وصلتك رسالة جديدة',
      'chats'
    );
  
    state.chatCount = Number(state.chatCount || 0) + 1;
    syncChatBell();
    renderBellBadge();
  
    v10Sound('notify');
    toast('وصلتك رسالة جديدة');
  });
  socket.on('new-request-created', ()=>{
    if(state.user && state.user.role==='technician'){
      addBellNotification('request','طلب جديد','وصل طلب جديد من عميل','orders');
      toast('وصل طلب جديد');
      dashboard();
    }
  });

  socket.on('requests-updated', ()=>{
    if(state.user){
      dashboard();
    }
  });

  socket.on('offer-created', (data)=>{
    if(state.user && state.user.role==='customer'){
  
      addBellNotification(
        'offer',
        'عرض جديد',
        'وصل عرض جديد على أحد طلباتك',
        'orders'
      );
  
      toast('وصلت عروض جديدة');
      dashboard();
    }
  });

  socket.on('request-status-updated', ()=>{
    toast('تم تحديث حالة الطلب');
  });

  socket.on('messages-updated', data=>{
    if(activeChatId && Number(data.requestId)===Number(activeChatId)){
      renderMessages(data.messages || []);
    }
  
    if(state.user){
      v10Sound('notify');
      v24RefreshBadges();
  
      state.notifications = state.notifications.filter(n=>n.type!=='chat');
  
      state.notifications.unshift({
        id: Date.now(),
        type:'chat',
        title:'رسائل جديدة',
        text:'وصلتك رسالة جديدة',
        tab:'chats',
        read:false,
        time:new Date().toLocaleTimeString('ar-JO',{hour:'2-digit',minute:'2-digit'})
      });
  
      state.unread = state.notifications.filter(n=>!n.read).length;
  
      renderBellBadge();
      setTimeout(renderBellBadge,150);
  
      toast('وصلتك رسالة جديدة');
    }
  });
  socket.on('topup-created', (data)=>{
    console.log('TOPUP NOTIFY RECEIVED', data, state.user);
    if(state.user && state.user.role==='admin'){
  
      addBellNotification(
        'topup',
        'طلب شحن جديد',
        'وصل طلب شحن جديد بانتظار الموافقة',
        'topups'
      );
  
      toast('وصل طلب شحن جديد');
      dashboard();
    }
  });
  socket.on('support-created', (data)=>{
    console.log('SUPPORT NOTIFY RECEIVED', data, state.user);
  
    if(state.user && state.user.role === 'admin'){
  
      addBellNotification(
        'support',
        'تذكرة دعم جديدة',
        'وصلت تذكرة دعم جديدة',
        'support'
      );
  
      toast('وصلت تذكرة دعم جديدة');
      dashboard();
    }
  });
  socket.on('support-message', (data)=>{
    if(!state.user) return;
  
    if(Number(data.senderId) === Number(state.user.id)) return;
    if(Number(data.ticketUserId) !== Number(state.user.id) && state.user.role !== 'admin') return;
  
    addBellNotification(
      'support',
      'رسالة من الدعم',
      'الإدارة أرسلت لك رسالة دعم',
      'support',
      data.ticketId
    );
  
    v10Sound('notify');
    toast('وصلتك رسالة من الدعم');
  });
  socket.on('rated', ()=>{
    toast('تم استلام التقييم');
  });
}
let recorder=null,audioChunks=[],recordingId=null;
const $=s=>document.querySelector(s), app=$('#app');
async function api(url,opt={}){opt.headers={...(opt.body instanceof FormData?{}:{'Content-Type':'application/json'})};opt.credentials='include';let r=await fetch(url,opt),j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'حدث خطأ');return j}
function toast(t){let d=document.createElement('div');d.className='toast';d.textContent=t;$('#toast').appendChild(d);setTimeout(()=>d.remove(),3500)}
function addBellNotification(type,title,text,tab='dash',ticketId=null){
  const n = {
    id: Date.now() + Math.random(),
    type,
    title,
    text,
    tab,
    ticketId,
    read:false,
    time:new Date().toLocaleTimeString('ar-JO',{hour:'2-digit',minute:'2-digit'})
  };

  state.notifications.unshift(n);
  state.notifications = state.notifications.slice(0,20);
  state.unread = state.notifications.filter(x=>!x.read).length;

  renderBellBadge();
  setTimeout(renderBellBadge,150);
  setTimeout(renderBellBadge,500);
}

function renderBellBadge(){
  const chatUnread = Number(state.chatCount || 0);
  const otherUnread = state.notifications.filter(n=>!n.read && n.type!=='chat').length;
  const total = chatUnread + otherUnread;

  document.querySelectorAll('.bell-btn').forEach(btn=>{
    let badge=btn.querySelector('.bell-count');
    if(!badge){
      btn.insertAdjacentHTML('beforeend', `<span class="bell-count"></span>`);
      badge=btn.querySelector('.bell-count');
    }

    badge.textContent = total > 0 ? total : '';
    badge.style.display = total > 0 ? 'inline-flex' : 'none';
  });
}
function syncChatBell(){
  const c = Number(state.chatCount || 0);

  state.notifications = state.notifications.filter(n => n.type !== 'chat');

  if(c > 0){
    state.notifications.unshift({
      id:'chat-live',
      type:'chat',
      title:'رسائل جديدة',
      text:`لديك ${c} دردشات غير مقروءة`,
      tab:'chats',
      read:false,
      time:new Date().toLocaleTimeString('ar-JO',{hour:'2-digit',minute:'2-digit'})
    });
  }

  state.unread = state.notifications.filter(n=>!n.read).length;

  renderBellBadge();
  setTimeout(renderBellBadge,100);
  setTimeout(renderBellBadge,300);
}


function openNotification(id){
  const n=state.notifications.find(x=>String(x.id)===String(id));
  if(!n) return;

  n.read=true;
  state.unread=state.notifications.filter(x=>!x.read).length;
  renderBellBadge();

  const box=document.querySelector('#bellMenu');
  if(box) box.classList.remove('show');

  if(n.type==='request' || n.type==='offer'){
    state.tab='orders';
    dashboard();

  }else if(n.type==='chat'){
    state.tab='chats';
    dashboard();

  }else if(n.type==='topup'){
    state.tab='topups';
    dashboard();

  }else if(n.type==='support'){
    if(typeof supportChat==='function' && n.ticketId){
      supportChat(n.ticketId);
    }else{
      state.tab='support';
      dashboard();
    }

  }else{
    state.tab=n.tab || 'dash';
    dashboard();
  }

  setTimeout(renderBellBadge,300);
}

window.toggleBell = function(){
  const box=document.querySelector('#bellMenu');
  if(!box) return;

  if(box.classList.contains('show')){
    box.classList.remove('show');
    return;
  }

  box.innerHTML = state.notifications.length
    ? state.notifications.map(n=>`
      <div class="bell-item ${n.read?'read':'unread'}" onclick="openNotification('${n.id}')">
        <div class="bell-title">${n.read?'':'🔴 '} ${n.title}</div>
        <div class="bell-text">${n.text}</div>
        <div class="bell-time">${n.time}</div>
      </div>
    `).join('')
    : `<div class="bell-empty">لا توجد إشعارات جديدة</div>`;

  box.classList.add('show');
};

window.openNotification = openNotification;
window.renderBellBadge = renderBellBadge;
window.addBellNotification = addBellNotification;
window.syncChatBell = syncChatBell;
function stars(n=0){let x=Math.round(Number(n)||0);return `<span class="stars">${'★'.repeat(x)}${'☆'.repeat(5-x)}</span>`}

// Global safe text helper used by home/service cards
window.esc = window.esc || function(v){
  return String(v ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
};
function v10ApplyTheme(){ if(localStorage.sallehlyTheme==='dark') document.body.classList.add('dark-dash'); else document.body.classList.remove('dark-dash'); }
function v10ToggleTheme(){ localStorage.sallehlyTheme = document.body.classList.contains('dark-dash') ? 'light' : 'dark'; v10ApplyTheme(); toast(localStorage.sallehlyTheme==='dark'?'تم تفعيل الدارك مود':'تم تفعيل الوضع الفاتح'); }
function v10Sound(type='notify'){
  try{ const AudioCtx=window.AudioContext||window.webkitAudioContext; const ctx=new AudioCtx(); const o=ctx.createOscillator(); const g=ctx.createGain(); const map={notify:[660,.08],request:[880,.12],message:[520,.09],done:[740,.16],logout:[330,.1]}; const [f,d]=map[type]||map.notify; o.frequency.value=f; o.type='sine'; g.gain.setValueAtTime(.0001,ctx.currentTime); g.gain.exponentialRampToValueAtTime(.16,ctx.currentTime+.01); g.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+d); o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime+d+.02); }catch(e){}
}
function v10Notify(text='تنبيه جديد',type='notify'){ v10Sound(type); const b=document.querySelector('.bell-btn'); if(b){b.classList.add('sound-on'); setTimeout(()=>b.classList.remove('sound-on'),700)} toast(text); }

function v11SelectService(service){
  if(!state.user){ localStorage.pendingService=service; go('register'); return; }
  if(state.user.role==='customer'){
    state.tab='near'; dashboard();
    setTimeout(()=>{ if($('#searchTechQ')) $('#searchTechQ').value=service; if($('#searchService')) $('#searchService').value=service; searchTechnicians(); },180);
  }else{ toast('هذه الخدمة للعميل. يمكنك إدارة الطلبات من لوحتك.'); }
}
function v11Hero(title, sub){return `<div class="dh-slim"><div class="dh-slim-top"><span class="dh-slim-title">👋 ${title}</span>${sub?`<span class="dh-slim-sub">${sub}</span>`:''}</div></div>`;}
function v11Improvements(){return `<div class="v11-improve-grid"><div><b>📌 طلبات بدون تداخل</b><small>الفني لا يقبل طلب جديد قبل إنهاء الطلب النشط.</small></div><div><b>🧾 سجل عمليات</b><small>كل طلب وشحن ورصيد محفوظ للنظام.</small></div><div><b>💬 شات بعد القبول</b><small>المحادثة بين العميل والفني مرتبطة بالطلب.</small></div><div><b>📍 محافظة ومنطقة</b><small>بحث حسب عمان، الزرقاء، إربد وباقي المحافظات.</small></div></div>`;}


async function init(){
  // Hide only the app content, not the loader
  const appEl = document.getElementById('app');
  const nav = document.querySelector('.nav');
  const foot = document.querySelector('footer');
  if(appEl) appEl.style.visibility='hidden';
  if(nav) nav.style.visibility='hidden';
  if(foot) foot.style.visibility='hidden';
  setupSocket();
  try{ state.meta=await api('/api/meta'); }catch(e){ state.meta={services:[],packages:[]}; }
  let landed = false;
  try{
    let m=await api('/api/me');
    state.user=m.user;
    await dashboard();
    landed=true;
  }catch(e){ }
  if(!landed){ go('home'); }
  // Reveal content and hide loader
  if(appEl) appEl.style.visibility='';
  if(window._hideLoader) window._hideLoader();
}
function go(p){document.body.classList.remove('open'); if(p==='home') {home(); window.scrollTo({top:0,behavior:'smooth'}); return;} if(p==='services'){servicesPage(); window.scrollTo({top:0,behavior:'smooth'}); return;} if(p==='how'){howPage(); window.scrollTo({top:0,behavior:'smooth'}); return;} if(p==='tech'){techPage(); window.scrollTo({top:0,behavior:'smooth'}); return;} if(p==='contact'){contact(); window.scrollTo({top:0,behavior:'smooth'}); return;} if(p==='login'){login(); window.scrollTo({top:0,behavior:'smooth'}); return;} if(p==='register'){register(); window.scrollTo({top:0,behavior:'smooth'}); return;} if(p==='dashboard'){dashboard(); window.scrollTo({top:0,behavior:'smooth'}); return;} home();}
window.go = go;
function home(){app.innerHTML=`<section class="hero pro-hero"><div class="hero-copy"><span class="badge glow-badge"><span class="live-dot"></span> منصة صيانة احترافية في الأردن • فنيين موثوقين • دفع كاش</span><h1>صلّحلي — وصّل العميل بالفني الأقرب بشكل أسرع وأرتب</h1><p class="hero-lead">واجهة احترافية تعرض الخدمات، الفنيين، الطلبات، التقييمات، الرصيد، والدردشة بمظهر حديث يناسب إطلاق مشروع حقيقي.</p><div class="hero-actions"><button class="btn big" onclick="go('${state.user?'dashboard':'register'}')">اطلب خدمة الآن</button><button class="btn ghost big" onclick="register('technician')">انضم كفني</button></div><div class="trust-strip"><div><b>+12</b><span>خدمة صيانة</span></div><div><b>GPS</b><span>تحديد موقع</span></div><div><b>⭐ 4.8</b><span>تقييمات فنيين</span></div></div></div><div class="phone pro-phone"><div class="phone-top"><span></span><b>فنيين مقترحين</b><em>Live</em></div><div class="screen pro-screen">${['فني تكييف','كهربائي','سباك'].map((x,i)=>`<div class="screen-row pro-row"><div style="display:flex;gap:10px;align-items:center"><div class="avatar">${['❄️','⚡','🚰'][i]}</div><div><b>${x}</b><div>${stars(5-i/2)} <small>${20-i*4} عمل مكتمل</small></div></div></div><button class="btn ghost mini">اختيار</button></div>`).join('')}<div class="mini-map"><span>📍</span><div><b>الأقرب لموقعك</b><small>ترتيب حسب المنطقة والتقييم</small></div></div></div></div></section><section class="section services-section" id="services"><div class="section-head"><span class="eyebrow">خدمات جاهزة</span><h2>كل ما يحتاجه البيت بمكان واحد</h2><p class="muted">اختر الخدمة، انشر الطلب، وشاهد الفنيين المناسبين حسب منطقتك.</p></div><div class="grid feature-grid">${state.meta.services.slice(0,12).map(s=>`<div class="card service-card"><div class="icon">${s.icon}</div><h3>${s.name}</h3><p class="muted">طلب سريع، فنيين قريبين، وتقييم واضح قبل الاختيار.</p></div>`).join('')}</div></section><section class="section"><div class="section-head"><span class="eyebrow">كيف يعمل؟</span><h2>خطوات بسيطة من الطلب إلى الإنجاز</h2></div><div class="grid steps-grid"><div class="card step-card"><span>01</span><h3>أنشئ طلب</h3><p class="muted">اختر الخدمة، اكتب وصف المشكلة، وحدد المحافظة والمنطقة.</p></div><div class="card step-card"><span>02</span><h3>اختر الفني</h3><p class="muted">يعرض النظام الفنيين المناسبين مع التقييم وعدد الأعمال.</p></div><div class="card step-card"><span>03</span><h3>ادفع وقيّم</h3><p class="muted">بعد الإنجاز يتم الدفع كاش وتقييم الفني بالنجوم.</p></div></div></section><section class="section cta-section"><div class="cta-card"><div><span class="eyebrow">جاهز للإطلاق</span><h2>ابدأ بتحويل طلبات الصيانة إلى تجربة مرتبة وموثوقة</h2><p>تصميم حديث، أزرار واضحة، كروت احترافية، وتجربة مناسبة للموبايل والكمبيوتر.</p></div><button class="btn light big" onclick="go('${state.user?'dashboard':'register'}')">ابدأ الآن</button></div></section>`}
// ── V61: Premium Public Pages ──
;(function(){

  // expose to global scope immediately
  window.servicesPage = servicesPage;
  window.howPage = howPage;
  window.techPage = techPage;
  window.contact = contact;

function servicesPage(){
  document.body.classList.remove('open','sidebar-open','v37-menu-open','dashboard-mode','v37-dashboard');
  const safe = window.esc || (v=>String(v??''));
  const cards = (state.meta.services||[]).map(s=>`
    <button class="v61-service-card" onclick="v40ChooseService('${String(s.name||'').replace(/'/g,"\\'")}')">
      <div class="v61-service-icon">${safe(s.icon||'🛠️')}</div>
      <h3>${safe(s.name)}</h3>
      <p>فنيين متاحين قريبين منك</p>
      <span class="v61-service-cta">اطلب الآن ←</span>
    </button>`).join('');

  app.innerHTML = `
  <div class="v61-home">
    <canvas class="v60-canvas" id="v61SvCanvas"></canvas>
    <div class="v61-bg-gradient"></div>
    <section class="v61-inner-hero">
      <span class="v61-eyebrow">خدماتنا</span>
      <h1>كل ما يحتاجه <span class="v61-gradient-text">بيتك</span></h1>
      <p>اختر الخدمة وابدأ الطلب — فنيون موثوقون حسب منطقتك</p>
    </section>
    <section style="position:relative;z-index:1;padding:0 6% 80px;max-width:1200px;margin:0 auto">
      <div class="v61-services-grid">${cards}</div>
    </section>
  </div>`;
  v61MiniParticles('v61SvCanvas');
  window.scrollTo({top:0,behavior:'smooth'});
}

function howPage(){
  document.body.classList.remove('open','sidebar-open','v37-menu-open','dashboard-mode','v37-dashboard');
  app.innerHTML = `
  <div class="v61-home">
    <canvas class="v60-canvas" id="v61HwCanvas"></canvas>
    <div class="v61-bg-gradient"></div>
    <section class="v61-inner-hero">
      <span class="v61-eyebrow">طريقة الاستخدام</span>
      <h1>كيف <span class="v61-gradient-text">تعمل صلّحلي؟</span></h1>
      <p>ثلاث خطوات بسيطة تفصلك عن الفني المناسب</p>
    </section>
    <section style="position:relative;z-index:1;padding:0 6% 80px;max-width:1000px;margin:0 auto">

      <div class="v61-how-grid">
        <div class="v61-how-card">
          <div class="v61-how-num">01</div>
          <div class="v61-how-icon">👤</div>
          <h3>للعميل</h3>
          <ul class="v61-how-list">
            <li>أنشئ حساباً مجاناً</li>
            <li>انشر طلب الخدمة مع وصف المشكلة</li>
            <li>استقبل عروض الفنيين وشاهد تقييماتهم</li>
            <li>اختر الفني الأنسب وتواصل معه</li>
            <li>ادفع كاش بعد الإنجاز وقيّم الفني</li>
          </ul>
        </div>
        <div class="v61-how-card">
          <div class="v61-how-num">02</div>
          <div class="v61-how-icon">🔧</div>
          <h3>للفني</h3>
          <ul class="v61-how-list">
            <li>سجّل وارفع صورتك وخبرتك</li>
            <li>أول طلبين مجاناً بدون رصيد</li>
            <li>اشحن رصيدك لاستقبال المزيد من الطلبات</li>
            <li>قدّم عرض سعر وانتظر موافقة العميل</li>
            <li>أنجز العمل واستلم الدفع مباشرة</li>
          </ul>
        </div>
        <div class="v61-how-card">
          <div class="v61-how-num">03</div>
          <div class="v61-how-icon">⚙️</div>
          <h3>للإدارة</h3>
          <ul class="v61-how-list">
            <li>إدارة المستخدمين والفنيين</li>
            <li>مراجعة طلبات الشحن والموافقة عليها</li>
            <li>متابعة الطلبات والشكاوى</li>
            <li>إدارة الخدمات والباقات</li>
          </ul>
        </div>
      </div>

      <div style="text-align:center;margin-top:48px">
        <button class="v61-btn-primary" onclick="go('${state.user?'dashboard':'register'}')">
          ابدأ الآن مجاناً
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
      </div>
    </section>
  </div>`;
  v61MiniParticles('v61HwCanvas');
  window.scrollTo({top:0,behavior:'smooth'});
}

function techPage(){
  document.body.classList.remove('open','sidebar-open','v37-menu-open','dashboard-mode','v37-dashboard');
  const pkgs = (state.meta.packages||[]).map(p=>`
    <div class="v61-pkg-card">
      <div class="v61-pkg-badge">باقة</div>
      <h3>${String(p.name||'')}</h3>
      <div class="v61-pkg-price">${p.amount} <span>د.أ</span></div>
      <ul class="v61-how-list">
        <li>رصيد إضافي: <b>${p.bonus} د.أ</b></li>
        <li>خصم كل طلب: <b>${p.commission_per_order} د.أ</b></li>
      </ul>
      <button class="v61-btn-primary" onclick="register('technician')">اختر هذه الباقة</button>
    </div>`).join('');

  app.innerHTML = `
  <div class="v61-home">
    <canvas class="v60-canvas" id="v61TkCanvas"></canvas>
    <div class="v61-bg-gradient"></div>
    <section class="v61-inner-hero">
      <span class="v61-eyebrow">للفنيين</span>
      <h1>انضم كفني <span class="v61-gradient-text">واكسب أكثر</span></h1>
      <p>سجّل حسابك، اشحن رصيدك، واستقبل طلبات من عملاء في منطقتك</p>
    </section>
    <section style="position:relative;z-index:1;padding:0 6% 40px;max-width:1000px;margin:0 auto">

      <div class="v61-feat-grid">
        <div class="v61-feat"><span>🆓</span><h4>أول طلبين مجاناً</h4><p>ابدأ بدون رصيد وجرّب المنصة</p></div>
        <div class="v61-feat"><span>💰</span><h4>دفع كاش مباشر</h4><p>تستلم مبلغ الطلب مباشرة من العميل</p></div>
        <div class="v61-feat"><span>📍</span><h4>طلبات قريبة منك</h4><p>فلترة الطلبات حسب منطقتك وخبرتك</p></div>
        <div class="v61-feat"><span>⭐</span><h4>بناء سمعتك</h4><p>تقييمات العملاء ترفع ظهورك في النتائج</p></div>
      </div>

      <div class="v61-section-head" style="margin-top:60px">
        <span class="v61-eyebrow">باقات الشحن</span>
        <h2>اختر الباقة المناسبة</h2>
      </div>
      <div class="v61-pkgs-grid">${pkgs}</div>

      <div style="text-align:center;margin-top:40px">
        <button class="v61-btn-primary" onclick="register('technician')" style="font-size:18px;height:58px;padding:0 36px">
          سجّل كفني الآن 🔧
        </button>
      </div>
    </section>
  </div>`;
  v61MiniParticles('v61TkCanvas');
  window.scrollTo({top:0,behavior:'smooth'});
}

function contact(){
  document.body.classList.remove('open','sidebar-open','v37-menu-open','dashboard-mode','v37-dashboard');
  app.innerHTML = `
  <div class="v61-home">
    <canvas class="v60-canvas" id="v61CtCanvas"></canvas>
    <div class="v61-bg-gradient"></div>
    <section class="v61-inner-hero">
      <span class="v61-eyebrow">تواصل معنا</span>
      <h1>نحن هنا <span class="v61-gradient-text">لمساعدتك</span></h1>
      <p>تواصل معنا لأي استفسار أو دعم تقني</p>
    </section>
    <section style="position:relative;z-index:1;padding:0 6% 80px;max-width:700px;margin:0 auto">

      <div class="v61-contact-grid">
        <a class="v61-contact-card" href="tel:0790000000">
          <span>📞</span>
          <h3>الهاتف</h3>
          <p>0790000000</p>
          <small>السبت - الخميس | 9ص - 9م</small>
        </a>
        <a class="v61-contact-card" href="https://wa.me/962790000000" target="_blank">
          <span>💬</span>
          <h3>واتساب</h3>
          <p>تواصل فوري</p>
          <small>رد خلال دقائق</small>
        </a>
        <a class="v61-contact-card" href="mailto:info@sallehly.jo">
          <span>✉️</span>
          <h3>البريد الإلكتروني</h3>
          <p>info@sallehly.jo</p>
          <small>رد خلال 24 ساعة</small>
        </a>
      </div>

      <div class="v61-cta-card" style="margin-top:40px">
        <div class="v61-cta-glow"></div>
        <h3 style="font-size:22px;margin:0 0 10px">هل أنت فني وتريد الانضمام؟</h3>
        <p style="color:rgba(255,255,255,0.5);margin:0 0 20px">سجّل حسابك الآن وابدأ باستقبال الطلبات</p>
        <button class="v61-btn-primary" onclick="register('technician')">سجّل كفني 🔧</button>
      </div>
    </section>
  </div>`;
  v61MiniParticles('v61CtCanvas');
  window.scrollTo({top:0,behavior:'smooth'});
}

function v61MiniParticles(id){
  const canvas = document.getElementById(id);
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, P = [];
  function resize(){ W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight; }
  resize();
  function Pt(){ this.x=Math.random()*W; this.y=Math.random()*H; this.r=Math.random()*1.5+0.3; this.dx=(Math.random()-0.5)*0.3; this.dy=(Math.random()-0.5)*0.3; this.a=Math.random()*0.3+0.05; this.c=Math.random()>0.5?'124,58,237':'37,99,235'; }
  for(let i=0;i<50;i++) P.push(new Pt());
  let aid;
  function draw(){
    if(!document.getElementById(id)){ cancelAnimationFrame(aid); return; }
    ctx.clearRect(0,0,W,H);
    P.forEach(p=>{ ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fillStyle=`rgba(${p.c},${p.a})`; ctx.fill(); p.x+=p.dx; p.y+=p.dy; if(p.x<0||p.x>W)p.dx*=-1; if(p.y<0||p.y>H)p.dy*=-1; });
    aid=requestAnimationFrame(draw);
  }
  draw();
}

// CSS for pages
const s = document.createElement('style');
s.id = 'v61-pages-css';
if(!document.getElementById('v61-pages-css')) document.head.appendChild(s);
s.textContent = `
.v61-inner-hero{position:relative;z-index:1;text-align:center;padding:120px 6% 48px;max-width:700px;margin:0 auto}
.v61-inner-hero h1{font-size:clamp(32px,5vw,52px);font-weight:900;margin:12px 0 16px}
.v61-inner-hero p{color:rgba(255,255,255,0.5);font-size:16px;margin:0}
.v61-how-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.v61-how-card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:32px 24px;position:relative;overflow:hidden;transition:all 0.25s}
.v61-how-card:hover{background:rgba(124,58,237,0.1);border-color:rgba(124,58,237,0.3);transform:translateY(-4px)}
.v61-how-num{font-size:48px;font-weight:900;background:linear-gradient(135deg,#7c3aed,#2563eb);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:8px;line-height:1}
.v61-how-icon{font-size:36px;margin-bottom:12px}
.v61-how-card h3{font-size:20px;font-weight:800;margin:0 0 16px;color:#fff}
.v61-how-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}
.v61-how-list li{color:rgba(255,255,255,0.6);font-size:14px;padding-right:20px;position:relative;line-height:1.5}
.v61-how-list li::before{content:'✓';position:absolute;right:0;color:#7c3aed;font-weight:900}
.v61-how-list li b{color:#fff}
.v61-feat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.v61-feat{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:24px 20px;text-align:center;transition:all 0.25s}
.v61-feat:hover{background:rgba(124,58,237,0.1);border-color:rgba(124,58,237,0.3);transform:translateY(-3px)}
.v61-feat span{font-size:36px;display:block;margin-bottom:12px}
.v61-feat h4{font-size:15px;font-weight:700;margin:0 0 8px;color:#fff}
.v61-feat p{color:rgba(255,255,255,0.4);font-size:13px;margin:0;line-height:1.5}
.v61-pkgs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;margin-top:24px}
.v61-pkg-card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:24px;padding:28px 24px;display:flex;flex-direction:column;gap:16px;transition:all 0.25s;position:relative}
.v61-pkg-card:hover{background:rgba(124,58,237,0.12);border-color:rgba(124,58,237,0.35);transform:translateY(-4px);box-shadow:0 16px 40px rgba(124,58,237,0.2)}
.v61-pkg-badge{display:inline-block;background:linear-gradient(135deg,rgba(124,58,237,0.3),rgba(37,99,235,0.3));border:1px solid rgba(124,58,237,0.3);color:#a78bfa;padding:3px 12px;border-radius:999px;font-size:11px;font-weight:700;width:fit-content}
.v61-pkg-card h3{font-size:20px;font-weight:800;margin:0;color:#fff}
.v61-pkg-price{font-size:40px;font-weight:900;color:#fff;line-height:1}.v61-pkg-price span{font-size:16px;color:rgba(255,255,255,0.5)}
.v61-pkg-card .v61-btn-primary{margin-top:auto;justify-content:center}
.v61-contact-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.v61-contact-card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:32px 24px;text-align:center;text-decoration:none;color:#fff;transition:all 0.25s;display:flex;flex-direction:column;align-items:center;gap:8px}
.v61-contact-card:hover{background:rgba(124,58,237,0.12);border-color:rgba(124,58,237,0.3);transform:translateY(-4px)}
.v61-contact-card span{font-size:40px}
.v61-contact-card h3{font-size:17px;font-weight:700;margin:0}
.v61-contact-card p{color:#60a5fa;font-size:16px;font-weight:600;margin:0}
.v61-contact-card small{color:rgba(255,255,255,0.3);font-size:12px}
@media(max-width:768px){.v61-how-grid,.v61-feat-grid,.v61-contact-grid{grid-template-columns:1fr}}
@media(max-width:600px){.v61-pkgs-grid{grid-template-columns:1fr}}
`;

})();
function login(){app.innerHTML=`<div class="page"><div class="card" style="max-width:520px;margin:auto"><h1>تسجيل الدخول</h1><form class="form" onsubmit="doLogin(event)"><div class="field"><label>البريد الإلكتروني</label><input id="email" type="email" required></div><div class="field"><label>كلمة السر</label><input id="password" type="password" required></div><button class="btn">دخول</button><p class="muted">حساب الإدارة لا يظهر للعامة. اطلب بيانات الدخول من مالك المنصة.</p></form></div></div>`}
async function doLogin(e){
  e.preventDefault();
  const emailVal = document.getElementById('email')?.value?.trim();
  const passVal  = document.getElementById('password')?.value;
  const btn      = document.getElementById('loginBtn');
  const errBox   = document.getElementById('loginError');
  if(errBox) errBox.style.display='none';
  if(!emailVal || !passVal){ if(errBox){errBox.textContent='يرجى تعبئة جميع الحقول';errBox.style.display='block';} return; }
  if(btn){ btn.disabled=true; btn.querySelector('.btn-text').style.display='none'; btn.querySelector('.btn-spinner').style.display='inline'; }
  try{
    const j = await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:emailVal,password:passVal})});
    state.user = j.user;
    toast('تم تسجيل الدخول');
    dashboard();
  } catch(err){
    if(errBox){ errBox.textContent=err.message||'بيانات غير صحيحة'; errBox.style.display='block'; }
    else toast(err.message);
  } finally {
    if(btn){ btn.disabled=false; btn.querySelector('.btn-text').style.display='inline'; btn.querySelector('.btn-spinner').style.display='none'; }
  }
}
// ── V60: Premium Register Page ──
;(function(){

register = window.register = function(role='customer'){
  state.tab = 'dash';
  document.body.classList.remove('dashboard-mode','v37-dashboard','sidebar-open','open');
  const safe = window.esc || ((v)=>String(v??''));

  const cities = typeof governorateOptions === 'function'
    ? governorateOptions('عمان')
    : (state.meta.cities||[]).map(c=>`<option>${c}</option>`).join('');
  const services = (state.meta.services||[]).map(s=>`<option value="${s.name}">${s.name}</option>`).join('');

  app.innerHTML = `
  <div class="v60-page" id="v60RegPage">
    <canvas class="v60-canvas" id="v60RegCanvas"></canvas>
    <video class="v60-video" autoplay muted loop playsinline>
      <source src="/videos/login.mp4" type="video/mp4">
    </video>
    <div class="v60-overlay"></div>

    <div class="v60r-wrap">

      <!-- Logo -->
      <div class="v60-brand" style="margin-bottom:4px">
        <div class="v60-brand-icon">
          <img src="/logo.png" alt="صلّحلي" onerror="this.parentNode.innerHTML='🔧'">
        </div>
        <span class="v60-brand-name">صلّحلي</span>
      </div>

      <!-- Card -->
      <div class="v60r-card" id="v60RegCard">
        <div class="v60-glow"></div>

        <div class="v60-head">
          <h1 class="v60-title">إنشاء حساب جديد</h1>
          <p class="v60-sub">انضم لمنصة صلّحلي للخدمات والصيانة المنزلية</p>
        </div>

        <!-- Error -->
        <div class="v60-error" id="v60RegError" style="display:none">
          <span class="v60-error-icon">⚠️</span>
          <span id="v60RegErrorMsg"></span>
        </div>

        <!-- Role tabs -->
        <div class="v60r-tabs">
          <button type="button" class="v60r-tab active" id="v60TabCust" onclick="v60SwitchRole('customer')">
            👤 عميل
          </button>
          <button type="button" class="v60r-tab" id="v60TabTech" onclick="v60SwitchRole('technician')">
            🔧 فني
          </button>
        </div>

        <form class="v60r-form" id="v60RegForm" onsubmit="v60DoRegister(event)" novalidate>
          <input type="hidden" id="role" value="${role}">

          <!-- Row 1: Name + Email -->
          <div class="v60r-grid">
            <div class="v60-field">
              <label class="v60-label">الاسم الكامل</label>
              <div class="v60-input-wrap">
                <svg class="v60-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"/><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/></svg>
                <input id="name" class="v60-input" type="text" placeholder="مثال: أحمد محمد" required minlength="2" oninput="v60ClearRegError()">
              </div>
            </div>
            <div class="v60-field">
              <label class="v60-label">البريد الإلكتروني</label>
              <div class="v60-input-wrap">
                <svg class="v60-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 7 10-7"/></svg>
                <input id="remail" class="v60-input" type="email" autocomplete="email" placeholder="example@email.com" required oninput="v60ClearRegError()">
              </div>
            </div>
          </div>

          <!-- Row 2: Phone + Password -->
          <div class="v60r-grid">
            <div class="v60-field">
              <label class="v60-label">رقم الهاتف</label>
              <div class="v60-input-wrap">
                <svg class="v60-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 2.09 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                <input id="phone" class="v60-input" type="tel" placeholder="0791234567" required oninput="v60ClearRegError()">
              </div>
            </div>
            <div class="v60-field">
              <label class="v60-label">كلمة السر</label>
              <div class="v60-input-wrap">
                <svg class="v60-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <input id="rpassword" class="v60-input" type="password" autocomplete="new-password" placeholder="8 أحرف على الأقل" required minlength="8" oninput="v60ClearRegError()">
                <button type="button" class="v60-eye" onclick="v60ToggleRegPass()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="17" height="17"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </div>
          </div>

          <!-- Row 3: City -->
          <div class="v60r-grid">
            <div class="v60-field">
              <label class="v60-label">المحافظة</label>
              <div class="v60-input-wrap">
                <svg class="v60-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
                <select id="city" class="v60-input v60-select">${cities}</select>
              </div>
            </div>
            <div class="v60-field">
              <label class="v60-label">المنطقة</label>
              <div class="v60-input-wrap">
                <svg class="v60-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                <select id="regArea" class="v60-input v60-select"></select>
              </div>
            </div>
          </div>

          <!-- Technician only fields -->
          <div class="v60r-tech-section techOnly" style="display:none">
            <div class="v60r-tech-label">حقول الفني</div>

            <div class="v60-field">
              <label class="v60-label">الصورة الشخصية <span class="v60r-required">مطلوبة</span></label>
              <label class="v60r-upload" for="avatar">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="28" height="28"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                <span id="v60AvatarLabel">اختر صورة أو اسحبها هنا</span>
                <small>JPG / PNG / WEBP</small>
                <input id="avatar" type="file" accept="image/png,image/jpeg,image/webp" style="display:none" onchange="v60PreviewAvatar(this)">
              </label>
            </div>

            <div class="v60r-grid">
              <div class="v60-field">
                <label class="v60-label">الرقم الوطني</label>
                <div class="v60-input-wrap">
                  <svg class="v60-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
                  <input id="national" class="v60-input" placeholder="10 أرقام" oninput="v60ClearRegError()">
                </div>
              </div>
              <div class="v60-field">
                <label class="v60-label">مناطق العمل <span style="color:rgba(255,255,255,0.3);font-size:11px">اختر مناطقك</span></label>
                <div class="v61-pills-wrap" id="v61AreasWrap" style="max-height:160px;overflow-y:auto"></div>
                <select id="areas" style="display:none" multiple></select>
              </div>
            </div>

            <div class="v60-field">
              <label class="v60-label">الخدمات <span style="color:rgba(255,255,255,0.3);font-size:11px">اختر كل ما تتقنه</span></label>
              <div class="v61-pills-wrap" id="v61SrvWrap">
                ${(state.meta.services||[]).map(s=>`<label class="v61-pill-check"><input type="checkbox" name="srv" value="${safe(s.name)}" style="display:none"><span>${safe(s.icon||'🛠️')} ${safe(s.name)}</span></label>`).join('')}
              </div>
              <select id="srv" style="display:none" multiple></select>
            </div>
          </div>

          <!-- Submit -->
          <button class="v60-btn" type="submit" id="v60RegBtn" style="margin-top:8px">
            <span id="v60RegBtnText">إنشاء الحساب</span>
            <svg id="v60RegSpinner" class="v60-spinner" style="display:none" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" stroke-width="3"/>
              <path d="M12 2a10 10 0 0 1 10 10" stroke="white" stroke-width="3" stroke-linecap="round"/>
            </svg>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>

        </form>

        <div class="v60-divider"><span>عندك حساب؟</span></div>
        <button class="v60-secondary" onclick="login()">تسجيل الدخول</button>
        <p class="v60-hint">🔐 حساب الإدارة يُضبط من السيرفر فقط</p>
      </div>

      <div class="v60-trust">
        <span>🔒 اتصال آمن</span>
        <span>⚡ خدمة فورية</span>
        <span>🏆 فنيون موثوقون</span>
      </div>
    </div>
  </div>`;

  // Set role
  document.getElementById('role').value = role;
  v60SwitchRole(role);

  // Bind area selects
  if(typeof bindAreaSelect === 'function'){
    bindAreaSelect('city', 'regArea');
    bindAreaSelect('city', 'areas');
  }

  // Particles + animation
  v60RegParticles();
  requestAnimationFrame(()=>{
    const card = document.getElementById('v60RegCard');
    if(card){ card.style.opacity='0'; card.style.transform='translateY(30px) scale(0.97)';
      setTimeout(()=>{ card.style.transition='all 0.7s cubic-bezier(0.22,1,0.36,1)';
        card.style.opacity='1'; card.style.transform='translateY(0) scale(1)'; }, 50);
    }
  });
};

window.v60SwitchRole = function(role){
  document.getElementById('role').value = role;
  const techFields = document.querySelectorAll('.techOnly');
  techFields.forEach(el => el.style.display = role === 'technician' ? 'block' : 'none');
  document.getElementById('v60TabCust')?.classList.toggle('active', role === 'customer');
  document.getElementById('v60TabTech')?.classList.toggle('active', role === 'technician');
  // Build areas pills when switching to technician
  if(role === 'technician'){
    const areasWrap = document.getElementById('v61AreasWrap');
    if(areasWrap && !areasWrap.children.length){
      const allAreas = typeof JORDAN_AREAS !== 'undefined'
        ? Object.values(JORDAN_AREAS).flat()
        : (state.meta.cities||[]);
      areasWrap.innerHTML = allAreas.map(a=>`<label class="v61-pill-check"><input type="checkbox" name="area_cb" value="${a}" style="display:none"><span>📍 ${a}</span></label>`).join('');
    }
  }
};

window.v60ClearRegError = function(){
  const e = document.getElementById('v60RegError');
  if(e) e.style.display = 'none';
};

window.v60ToggleRegPass = function(){
  const inp = document.getElementById('rpassword');
  if(inp) inp.type = inp.type === 'password' ? 'text' : 'password';
};

window.v60PreviewAvatar = function(input){
  const label = document.getElementById('v60AvatarLabel');
  if(input.files?.[0] && label) label.textContent = '✓ ' + input.files[0].name;
};

window.v60DoRegister = async function(e){
  e.preventDefault();
  const role = document.getElementById('role')?.value;
  const btn  = document.getElementById('v60RegBtn');
  const btnText = document.getElementById('v60RegBtnText');
  const spinner = document.getElementById('v60RegSpinner');
  const errBox  = document.getElementById('v60RegError');
  const errMsg  = document.getElementById('v60RegErrorMsg');

  if(btn) btn.disabled = true;
  if(btnText) btnText.textContent = 'جاري الإنشاء...';
  if(spinner) spinner.style.display = 'block';

  try{
    const fd = new FormData();
    fd.append('role', role);
    fd.append('name', document.getElementById('name')?.value.trim() || '');
    fd.append('email', document.getElementById('remail')?.value.trim() || '');
    fd.append('phone', document.getElementById('phone')?.value.trim() || '');
    fd.append('password', document.getElementById('rpassword')?.value || '');
    fd.append('city', document.getElementById('city')?.value || '');
    fd.append('national_number', document.getElementById('national')?.value.trim() || '');
    fd.append('services', Array.from(document.querySelectorAll('#v61SrvWrap input:checked')).map(i=>i.value).join(','));
    fd.append('areas',
      Array.from(document.querySelectorAll('#v61AreasWrap input:checked')).map(i=>i.value).join(',') ||
      (typeof selectedArea === 'function' ? selectedArea('regArea','regAreaOther') || document.getElementById('regArea')?.value || '' : '')
    );
    if(role === 'technician'){
      const avatar = document.getElementById('avatar')?.files?.[0];
      if(!avatar) throw new Error('الرجاء اختيار صورة شخصية للفني');
      fd.append('avatar', avatar);
    }

    const j = await api('/api/auth/register', {method:'POST', body:fd});

    if(j.step === 'verify'){
      showOtpScreen?.(j.email);
    } else {
      state.user = j.user;
      if(btn) btn.style.background = 'linear-gradient(135deg,#059669,#10b981)';
      if(btnText) btnText.textContent = '✓ تم إنشاء الحساب!';
      setTimeout(()=>{ toast?.('مرحباً ' + (j.user?.name||'') + ' 🎉'); dashboard(); }, 400);
    }
  } catch(err){
    if(errBox && errMsg){
      errMsg.textContent = err.message || 'حدث خطأ';
      errBox.style.display = 'flex';
      const card = document.getElementById('v60RegCard');
      if(card){ card.style.animation='v60Shake 0.4s ease'; setTimeout(()=>card.style.animation='',400); }
    }
    if(btn) btn.disabled = false;
    if(btnText) btnText.textContent = 'إنشاء الحساب';
    if(spinner) spinner.style.display = 'none';
    if(btn) btn.style.background = '';
  }
};

function v60RegParticles(){
  const canvas = document.getElementById('v60RegCanvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];
  function resize(){ W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);
  function P(){ this.x=Math.random()*W; this.y=Math.random()*H; this.r=Math.random()*2+0.5; this.dx=(Math.random()-0.5)*0.4; this.dy=(Math.random()-0.5)*0.4; this.alpha=Math.random()*0.5+0.1; this.color=Math.random()>0.5?'124,58,237':'37,99,235'; }
  for(let i=0;i<80;i++) particles.push(new P());
  let id;
  function draw(){
    if(!document.getElementById('v60RegCanvas')){ cancelAnimationFrame(id); return; }
    ctx.clearRect(0,0,W,H);
    particles.forEach(p=>{ ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fillStyle=`rgba(${p.color},${p.alpha})`; ctx.fill(); p.x+=p.dx; p.y+=p.dy; if(p.x<0||p.x>W)p.dx*=-1; if(p.y<0||p.y>H)p.dy*=-1; });
    for(let i=0;i<particles.length;i++) for(let j=i+1;j<particles.length;j++){ const d=Math.hypot(particles[i].x-particles[j].x,particles[i].y-particles[j].y); if(d<100){ ctx.beginPath(); ctx.moveTo(particles[i].x,particles[i].y); ctx.lineTo(particles[j].x,particles[j].y); ctx.strokeStyle=`rgba(124,58,237,${0.08*(1-d/100)})`; ctx.lineWidth=0.5; ctx.stroke(); } }
    id=requestAnimationFrame(draw);
  }
  draw();
}

// CSS
const rst = document.createElement('style');
rst.id = 'v60r-css';
if(!document.getElementById('v60r-css')) document.head.appendChild(rst);
rst.textContent = `
.v60r-wrap{position:relative;z-index:3;width:100%;max-width:580px;display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px 0}
.v60r-card{width:100%;padding:36px 32px;border-radius:28px;background:rgba(255,255,255,0.06);backdrop-filter:blur(32px);-webkit-backdrop-filter:blur(32px);border:1px solid rgba(255,255,255,0.1);box-shadow:0 32px 80px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.08);position:relative;overflow:hidden}
@supports not (backdrop-filter:blur(32px)){.v60r-card{background:rgba(15,10,40,0.95)}}
.v60r-tabs{display:flex;gap:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:5px;margin-bottom:20px}
.v60r-tab{flex:1;height:38px;border:none;border-radius:10px;color:rgba(255,255,255,0.5);font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;background:transparent;transition:all 0.25s}
.v60r-tab.active{background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;box-shadow:0 4px 16px rgba(124,58,237,0.35)}
.v60r-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.v60r-form{display:flex;flex-direction:column;gap:14px}
.v60-select{cursor:pointer;-webkit-appearance:none;appearance:none}
.v60-select option{background:#1a1040;color:#fff}
.v60r-tech-section{padding:16px;background:rgba(124,58,237,0.08);border:1px solid rgba(124,58,237,0.2);border-radius:16px;display:flex;flex-direction:column;gap:14px}
.v60r-tech-label{color:#a78bfa;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px}
.v60r-required{background:rgba(239,68,68,0.2);color:#fca5a5;font-size:11px;padding:2px 8px;border-radius:6px;margin-right:6px}
.v60r-upload{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:20px;border:2px dashed rgba(124,58,237,0.3);border-radius:14px;cursor:pointer;transition:all 0.25s;color:rgba(255,255,255,0.5);font-size:13px;text-align:center}
.v60r-upload:hover{border-color:#7c3aed;background:rgba(124,58,237,0.08);color:#a78bfa}
.v60r-upload svg{color:#7c3aed}
.v61-pills-wrap{display:flex;flex-wrap:wrap;gap:8px;padding:4px 0}
.v61-pill-check{cursor:pointer}
.v61-pill-check input:checked + span{background:linear-gradient(135deg,rgba(124,58,237,0.5),rgba(37,99,235,0.5));border-color:#7c3aed;color:#fff;box-shadow:0 0 0 1px rgba(124,58,237,0.5)}
.v61-pill-check span{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:999px;color:rgba(255,255,255,0.6);font-size:13px;transition:all 0.2s;user-select:none}
.v61-pill-check span:hover{background:rgba(124,58,237,0.2);border-color:rgba(124,58,237,0.4);color:#fff}
@media(max-width:560px){.v60r-grid{grid-template-columns:1fr}.v60r-card{padding:24px 18px;border-radius:20px}.v60r-wrap{max-width:100%}}
`;

})();
function toggleTech(){document.querySelectorAll('.techOnly').forEach(x=>x.style.display=$('#role').value==='technician'?'block':'none')}
function vals(sel){return Array.from($(sel).selectedOptions||[]).map(o=>o.value)}
async function doRegister(e){e.preventDefault();try{const role=$('#role').value;const fd=new FormData();fd.append('role',role);fd.append('name',$('#name').value.trim());fd.append('email',$('#remail').value.trim());fd.append('phone',$('#phone').value.trim());fd.append('password',$('#rpassword').value);fd.append('city',$('#city').value);fd.append('national_number',$('#national')?$('#national').value.trim():'');fd.append('services',vals('#srv').join(','));fd.append('areas',vals('#areas').join(','));if(role==='technician'&&!$('#avatar').files[0]) throw new Error('الرجاء اختيار صورة شخصية للفني');if($('#avatar')&&$('#avatar').files[0])fd.append('avatar',$('#avatar').files[0]);const j=await api('/api/auth/register',{method:'POST',body:fd});if(j.step==='verify'){showOtpScreen(j.email);}else{state.user=j.user;toast('تم إنشاء الحساب');dashboard();}}catch(err){toast(err.message)}}
// ── OTP Verification Screen ───────────────────────────────────────────────
function showOtpScreen(email) {
  state._pendingOtpEmail = email;
  app.innerHTML = `<div class="page"><div class="card" style="max-width:440px;margin:auto;text-align:center">
    <div style="font-size:48px;margin-bottom:12px">📧</div>
    <h1 style="margin-bottom:8px">تحقق من بريدك</h1>
    <p class="muted" style="margin-bottom:24px">أرسلنا كود مكون من 6 أرقام إلى<br><b>${email}</b></p>
    <form class="form" onsubmit="doVerifyOtp(event)">
      <div class="field">
        <input id="otpInput" type="text" inputmode="numeric" maxlength="6" placeholder="● ● ● ● ● ●" required
          oninput="this.value=this.value.replace(/[^0-9]/g,'')"
          style="text-align:center;font-size:28px;font-weight:900;letter-spacing:10px;padding:16px">
      </div>
      <button class="btn" style="width:100%">تأكيد الحساب</button>
    </form>
    <p class="muted" style="margin-top:16px;font-size:13px">لم يصلك الكود؟ <a href="#" onclick="go('register');return false" style="color:#7c3aed">أعد التسجيل</a></p>
  </div></div>`;
  setTimeout(()=>{ const i=$('#otpInput'); if(i) i.focus(); }, 100);
}

async function doVerifyOtp(e) {
  e.preventDefault();
  const email = state._pendingOtpEmail;
  if(!email) return toast('حدث خطأ، أعد التسجيل');
  const rawOtp = ($('#otpInput')?.value || '').trim().replace(/\s/g,'');
  if(rawOtp.length !== 6) return toast('أدخل الكود المكون من 6 أرقام');
  try {
    const j = await api('/api/auth/verify-otp', {method:'POST', body:JSON.stringify({email, otp: rawOtp})});
    state.user = j.user;
    state._pendingOtpEmail = null;
    toast('🎉 تم إنشاء الحساب بنجاح!');
    dashboard();
    if(localStorage.pendingService){
      const ps = localStorage.pendingService;
      localStorage.removeItem('pendingService');
      setTimeout(()=>{
        if(state.user?.role==='customer'){
          state.tab='near'; dashboard();
          setTimeout(()=>{ if($('#searchTechQ')) $('#searchTechQ').value=ps; searchTechnicians(); },180);
        }
      },250);
    }
  } catch(err){ toast(err.message); }
}

async function logout(){await api('/api/auth/logout',{method:'POST'}).catch(()=>{});state.user=null;home()}
async function dashboard(){
  setupSocket();
  
  if(!state.user) return login();
  if(state.user.role==='admin') return admin();
  if(state.user.role==='technician') return techDash();
  return custDash();
}
function layout(title,menu,content){
  app.innerHTML=`<div class="page">
    <div class="topbar">
      <h1>${title}</h1>

      <div class="bell-wrap">
        <button class="btn ghost bell-btn" onclick="toggleBell()">
          🔔 <span class="bell-count"></span>
        </button>
        <div id="bellMenu" class="bell-menu"></div>
      </div>

      <button class="btn ghost" onclick="logout()">تسجيل خروج</button>
    </div>

    <div class="panel">
      <aside class="sidebar">
        ${menu.map(m=>`<button class="sidebtn ${state.tab===m[0]?'active':''}" onclick="state.tab='${m[0]}';dashboard();setTimeout(v35ScrollToContent,80)">${m[1]}</button>`).join('')}
      </aside>
      <section>${content}</section>
    </div>
  </div>`;

  setTimeout(renderBellBadge,50);
}
async function custDash(){let menu=[['dash','طلب جديد'],['near','الفنيين الأقرب'],['orders','طلباتي']];let c=''; if(state.tab==='orders'){let j=await api('/api/requests');c=`<div class="card"><h2>طلباتي</h2>${reqTable(j.requests)}</div>`}else if(state.tab==='near'){c=nearbyPage()}else c=requestForm();layout('لوحة العميل',menu,c); if(state.tab==='near') loadNearby();}
function mapBox(lat,lng){if(!lat||!lng)return `<div class="mapbox empty">لم يتم تحديد الموقع بعد</div>`;return `<iframe class="mapbox" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${Number(lng)-0.01}%2C${Number(lat)-0.01}%2C${Number(lng)+0.01}%2C${Number(lat)+0.01}&layer=mapnik&marker=${lat}%2C${lng}"></iframe><a class="maplink" target="_blank" href="https://www.google.com/maps?q=${lat},${lng}">فتح الموقع على خرائط Google</a>`}
function requestForm(){return `<div class="card bluehint offer-request"><h2>طلب خدمة جديد</h2><p class="muted">انشر المشكلة وسيقوم الفنيون بإرسال عروض سعر ومدة تنفيذ. قبول العرض يكون بقرار العميل فقط.</p><form class="form two" onsubmit="createReq(event)"><div class="field"><label>الخدمة</label><select id="qservice">${state.meta.services.map(s=>`<option>${s.name}</option>`).join('')}</select></div><div class="field"><label>المحافظة</label><select id="qcity">${state.meta.cities.map(c=>`<option>${c}</option>`).join('')}</select></div><div class="field"><label>المنطقة / الحي</label><input id="qarea" placeholder="مثال: الجبيهة، القويسمة، ماركا"></div><div class="field"><label>الوقت المناسب</label><input id="qtime" placeholder="اليوم مساءً / بكرا صباحاً"></div><div class="field" style="grid-column:1/-1"><label>صورة المشكلة اختياري</label><input id="problemImage" type="file" accept="image/png,image/jpeg,image/webp" onchange="previewProblemImage()"><small class="muted">PNG / JPG / WEBP فقط، حجم آمن حتى 3MB.</small><div id="problemPreview"></div></div><div class="field" style="grid-column:1/-1"><label>وصف المشكلة</label><textarea id="qdesc" required minlength="10" placeholder="مثال: المكيف لا يبرد، نوعه سبليت، أحتاج فني اليوم إذا أمكن"></textarea></div><div class="field" style="grid-column:1/-1"><button type="button" class="btn ghost" onclick="useGPS('request')">📍 حدد موقعي الآن</button><small class="muted">الموقع يساعد الفنيين على تقدير السعر والوقت بدقة.</small><div id="requestMap">${mapBox(state.gps?.lat,state.gps?.lng)}</div></div><button class="btn">نشر الطلب واستقبال عروض</button></form></div><br><div id="techs"></div>`}
function previewProblemImage(){let f=$('#problemImage')?.files?.[0], box=$('#problemPreview'); if(!box)return; if(!f){box.innerHTML='';return} if(!['image/png','image/jpeg','image/webp'].includes(f.type)) return toast('نوع الصورة غير مسموح'); box.innerHTML=`<img class="problem-preview" src="${URL.createObjectURL(f)}" alt="معاينة المشكلة">`;}
async function createReq(e){e.preventDefault();try{let fd=new FormData();fd.append('service',qservice.value);fd.append('city',qcity.value);fd.append('area',qarea.value);fd.append('preferred_time',qtime.value);fd.append('description',qdesc.value);fd.append('lat',state.gps?.lat||'');fd.append('lng',state.gps?.lng||'');if(problemImage.files[0])fd.append('problem_image',problemImage.files[0]);await api('/api/requests',{method:'POST',body:fd});toast('تم نشر الطلب، بانتظار عروض الفنيين');state.tab='orders';dashboard()}catch(err){toast(err.message)}}

function nearbyPage(){return `<div class="card bluehint"><h2>الفنيين الأقرب لك</h2><p class="muted">استخدم GPS لتحديد موقعك، ثم اختر الخدمة. تظهر الخريطة الصغيرة لمنطقتك ويتم ترتيب الفنيين حسب المحافظة ومناطق العمل والتقييم.</p><div class="form two"><div class="field"><label>الخدمة</label><select id="nservice" onchange="loadNearby()">${state.meta.services.map(s=>`<option>${s.name}</option>`).join('')}</select></div><div class="field"><label>المحافظة</label><select id="ncity" onchange="loadNearby()">${state.meta.cities.map(c=>`<option>${c}</option>`).join('')}</select></div><button class="btn ghost" onclick="useGPS('near')">📍 تحديد موقعي GPS</button></div><div id="nearMap">${mapBox(state.gps?.lat,state.gps?.lng)}</div></div><br><div id="nearList" class="grid"></div>`}
function cityFromGPS(lat,lng){ if(lat>=31.72&&lat<=32.15&&lng>=35.65&&lng<=36.15)return 'عمان'; if(lat>=32.0&&lat<=32.25&&lng>=35.8&&lng<=36.2)return 'الزرقاء'; if(lat>=32.45&&lat<=32.7)return 'إربد'; if(lat<29.8)return 'العقبة'; if(lat<30.4)return 'معان'; if(lat<30.95)return 'الطفيلة'; if(lat<31.35)return 'الكرك'; return 'عمان';}
function useGPS(mode='near'){ if(!navigator.geolocation)return toast('المتصفح لا يدعم GPS'); navigator.geolocation.getCurrentPosition(pos=>{state.gps={lat:pos.coords.latitude.toFixed(6),lng:pos.coords.longitude.toFixed(6)};let c=cityFromGPS(pos.coords.latitude,pos.coords.longitude); if($('#ncity'))$('#ncity').value=c; if($('#qcity'))$('#qcity').value=c; if($('#nearMap'))$('#nearMap').innerHTML=mapBox(state.gps.lat,state.gps.lng); if($('#requestMap'))$('#requestMap').innerHTML=mapBox(state.gps.lat,state.gps.lng); toast('تم تحديد موقعك: '+c); if(mode==='near')loadNearby();},()=>toast('لم يتم السماح بالوصول للموقع'),{enableHighAccuracy:true,timeout:10000});}
async function loadNearby(){try{let service=$('#nservice')?.value||state.meta.services[0]?.name, city=$('#ncity')?.value||state.user.city||'عمان';let j=await api(`/api/technicians?service=${encodeURIComponent(service)}&city=${encodeURIComponent(city)}&lat=${state.gps?.lat||''}&lng=${state.gps?.lng||''}`);let box=$('#nearList'); if(!box)return; box.innerHTML=j.technicians.length?j.technicians.map(t=>`<div class="card techcard"><div class="techhead">${t.avatar_url?`<img class="techAvatar" src="${_safeSrc(t.avatar_url)}" onerror="this.outerHTML='<div class=\'techAvatar fallback\'>ف</div>'">`:`<div class="techAvatar fallback">ف</div>`}<div><h3>${_x(t.name||'-')}</h3><div>${stars(t.rating_avg)} <small class="muted">(${t.rating_count||0} تقييم)</small></div></div></div><p><b>الخدمات:</b> ${_x(t.services||'-')}</p><p><b>المناطق:</b> ${_x(t.areas||t.city||'-')}</p><p><b>أعمال مكتملة:</b> ${t.completed_jobs||0}</p><span class="status">قريب منك في ${_x(city)}</span></div>`).join(''):`<div class="card empty">لا يوجد فنيين مناسبين حالياً لهذه الخدمة والمنطقة.</div>`}catch(e){toast(e.message)}}

function reqTable(rows){if(!rows.length)return '<div class="empty">لا توجد طلبات</div>';return `<div class="request-list">${rows.map(r=>`<div class="request-card"><div class="request-head"><div><b>#${r.id} - ${_x(r.service)}</b><p class="muted">${_x(r.city)}${r.area?' - '+_x(r.area):''} • ${_x(r.preferred_time||'بدون وقت محدد')}</p></div><span class="status">${_x(r.status)}</span></div>${r.problem_image_url?`<img class="problem-img" src="${_safeSrc(r.problem_image_url)}" alt="صورة المشكلة">`:''}<p>${_x(r.description||'')}</p>${r.lat&&r.lng?`<details><summary>📍 عرض موقع العميل على الخريطة</summary>${mapBox(r.lat,r.lng)}</details>`:''}<div class="request-meta"><span>الفني: ${_x(r.technician_name||'-')}</span><span>العميل: ${_x(r.customer_name||'-')}</span><span>السعر المقبول: ${r.offer_price? _x(String(r.offer_price))+' د.أ':'-'}</span><span>المدة: ${_x(r.arrival_time||'-')}</span></div><div class="actions">${actions(r)}</div><div id="offers-${r.id}" class="offers-box"></div></div>`).join('')}</div>`}
function actions(r){
  let a='';

  if(state.user.role==='customer'){
    a+=`<button class="btn ghost" onclick="loadOffers(${r.id})">عروض الفنيين</button> `;

    if(!['مكتمل','ملغي'].includes(r.status)){
      a+=`<button class="btn danger" onclick="deleteMyRequest(${r.id})">حذف الطلب</button> `;
    }
  }

  if(r.technician_id || state.user.role==='admin')
    a+=`<button class="btn ghost" onclick="chat(${r.id})">محادثة</button> `;

  if(state.user.role==='technician' && ['بانتظار العروض','وصلت عروض'].includes(r.status))
    a+=`<button class="btn" onclick="offerForm(${r.id},'${(r.service||'').replaceAll("'",'')}')">تقديم عرض سعر</button>`;

  if(state.user.role==='customer' && ['تم اختيار عرض','قيد التنفيذ','بانتظار تأكيد الدفع'].includes(r.status))
    a+=`<button class="btn green" onclick="setStatus(${r.id},'مكتمل')">تم إنجاز الطلب</button>`;

  if(state.user.role==='customer' && r.status==='مكتمل')
    a+=`<button class="btn" onclick="rate(${r.id})">تقييم الفني</button>`;

  return a;
}
async function deleteMyRequest(id){
  if(!confirm('متأكد بدك تحذف هذا الطلب؟')) return;

  try{
    await api(`/api/requests/${id}`, {
      method:'DELETE'
    });

    toast('تم حذف الطلب');
    dashboard();
  }catch(e){
    toast(e.message || 'فشل حذف الطلب');
  }
}
function offerForm(id,service=''){app.innerHTML=`<div class="page"><button class="btn ghost" onclick="dashboard()">رجوع</button><div class="card offer-panel" style="max-width:760px;margin:auto"><h2>تقديم عرض سعر</h2><p class="muted">الفني يرسل السعر والمدة فقط. الطلب لا يصبح قيد التنفيذ إلا بعد موافقة العميل.</p><form class="form two" onsubmit="sendOffer(event,${id})"><div class="field"><label>السعر بالدينار</label><input id="offerPrice" type="number" min="1" step="0.5" placeholder="مثال: 15" required></div><div class="field"><label>مدة التنفيذ / الوصول</label><input id="arrivalTime" placeholder="مثال: خلال 45 دقيقة / خلال ساعتين" required></div><div class="field" style="grid-column:1/-1"><label>ملاحظة اختيارية للعميل</label><textarea id="offerNote" placeholder="مثال: السعر يشمل الكشف والصيانة البسيطة ولا يشمل قطع الغيار"></textarea></div><button class="btn">إرسال العرض للعميل</button></form></div></div>`}
async function sendOffer(e,id){e.preventDefault();try{await api(`/api/requests/${id}/offer`,{method:'POST',body:JSON.stringify({offer_price:offerPrice.value,duration:arrivalTime.value,note:offerNote.value||''})});toast('تم إرسال العرض، بانتظار موافقة العميل');state.tab='orders';dashboard()}catch(e){toast(e.message)}}
async function loadOffers(id){try{let j=await api(`/api/requests/${id}/offers`);let box=$(`#offers-${id}`); if(!box)return; box.innerHTML=offerCards(j.offers,j.request)}catch(e){toast(e.message)}}
function offerCards(offers,req){if(!offers.length)return '<div class="empty small">لا توجد عروض بعد</div>';return `<div class="offers-list"><h3>العروض المستلمة</h3>${offers.map(o=>`<div class="offer-card ${_x(o.status)}">${o.avatar_url?`<img class="miniAvatar" src="${_safeSrc(o.avatar_url)}" onerror="this.outerHTML='<div class=\'miniAvatar fallback\'>ف</div>'">`:'<div class="miniAvatar fallback">ف</div>'}<div class="offer-info"><b>${_x(o.technician_name||'-')}</b><small>${_x(o.technician_city||'')} • ${_x(o.technician_areas||'')}</small><span>${stars(o.rating_avg)} (${o.rating_count||0}) • ${o.completed_jobs||0} عمل</span><p>${_x(o.note||'لا توجد ملاحظة')}</p></div><div class="offer-price"><b>${_x(String(o.price||0))} د.أ</b><span>${_x(o.duration||'')}</span><em>${o.status==='accepted'?'مقبول':o.status==='rejected'?'مرفوض':'بانتظار قرارك'}</em>${state.user.role==='customer'&&o.status==='pending'&&req.customer_id===state.user.id?`<button class="btn green mini" onclick="decideOffer(${o.id},'accepted',${req.id})">موافق</button><button class="btn red mini" onclick="decideOffer(${o.id},'rejected',${req.id})">رفض</button>`:''}</div></div>`).join('')}</div>`}
async function decideOffer(id,decision,requestId){try{await api(`/api/offers/${id}/decision`,{method:'POST',body:JSON.stringify({decision})});toast(decision==='accepted'?'تم قبول العرض وفتح الشات':'تم رفض العرض والطلب ما زال مطروحاً');state.tab='orders';dashboard()}catch(e){toast(e.message)}}
async function setStatus(id,s){try{await api(`/api/requests/${id}/status`,{method:'POST',body:JSON.stringify({status:s})});toast(s==='مكتمل'?'تم إكمال الطلب وخصم عمولة الفني حسب النظام':'تم تحديث الحالة');dashboard()}catch(e){toast(e.message)}}
function rate(id){
  app.innerHTML=`<div class="page"><button class="btn ghost" onclick="dashboard()">رجوع</button><div class="card rating-card" style="max-width:620px;margin:auto;text-align:center">
    <h2>قيّم الفني</h2>
    <p class="muted">اختر عدد النجوم ثم اكتب تعليقك. التقييم يظهر للفنيين والعملاء بشكل احترافي.</p>
    <div id="ratingStars" class="rating-picker" data-value="0">
      ${[1,2,3,4,5].map(n=>`<button type="button" class="rating-star" onclick="selectRating(${n})">☆</button>`).join('')}
    </div>
    <textarea id="ratingComment" placeholder="اكتب تعليقك عن الخدمة..." style="width:100%;min-height:110px;margin-top:14px"></textarea>
    <button class="btn" style="margin-top:14px" onclick="submitRating(${id})">إرسال التقييم</button>
  </div></div>`;
}
function selectRating(n){
  const box=$('#ratingStars'); if(!box)return; box.dataset.value=n;
  box.querySelectorAll('.rating-star').forEach((b,i)=>{b.textContent=i<n?'★':'☆'; b.classList.toggle('active',i<n)});
}
async function submitRating(id){
  const st=Number($('#ratingStars')?.dataset.value||0);
  if(!st)return toast('اختر عدد النجوم أولاً');
  try{await api(`/api/requests/${id}/rate`,{method:'POST',body:JSON.stringify({stars:st,comment:$('#ratingComment').value||''})});toast('تم إرسال التقييم');dashboard()}catch(e){toast(e.message)}
}
function escapeHtml(str){
  return String(str || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
// Short alias used throughout to escape ALL user-supplied data before innerHTML injection
const _x = escapeHtml;
// Safe src: only allow relative /uploads/ paths and nothing else (prevents javascript: and data: XSS)
function _safeSrc(url){ const s=String(url||''); return (s.startsWith('/uploads/')||s.startsWith('https://')||s.startsWith('http://'))&&!s.includes('"')&&!s.includes("'")&&!s.includes('<')&&!s.includes('>')&&!s.includes(' ')?s:''; }

function messageBody(body){
  body = String(body || '');

  if(body.startsWith('[audio]')){
    let u = escapeHtml(body.replace('[audio]',''));
    return `<audio controls src="${u}"></audio>`;
  }

  if(body.startsWith('[location]')){
    let p = body.replace('[location]','').split(',');
    let lat = encodeURIComponent(p[0] || '');
    let lng = encodeURIComponent(p[1] || '');
    return `📍 <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps?q=${lat},${lng}">فتح الموقع على الخريطة</a>`;
  }

  return escapeHtml(body).replace(
    /(https?:\/\/[^\s]{1,500})/g,
    (_, url) => {
      try { const u=new URL(url); if(u.protocol!=='https:'&&u.protocol!=='http:') return escapeHtml(url); }
      catch(e){ return escapeHtml(url); }
      return `<a target="_blank" rel="noopener noreferrer" href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    }
  );
}

function renderMessages(messages){
  let box=$('#chatbox');
  if(!box)return;
  box.innerHTML=messages.map(m=>`
    <div class="msg ${m.sender_id===state.user.id?'me':''}">
      <b>${escapeHtml(m.sender_name)}</b><br>
      ${messageBody(m.body)}
      <br><small>${escapeHtml(m.created_at)}</small>
    </div>
  `).join('');
}
async function refreshChat(){if(!activeChatId)return; try{let j=await api(`/api/requests/${activeChatId}/messages`);renderMessages(j.messages)}catch(e){}}
async function chat(id){activeChatId=id; setupSocket(); if(socket) socket.emit('join-request', id); if(chatTimer)clearInterval(chatTimer);let j=await api(`/api/requests/${id}/messages`);app.innerHTML=`<div class="page chat-page"><button class="btn ghost" onclick="if(socket&&activeChatId)socket.emit('leave-request',activeChatId);activeChatId=null;if(chatTimer)clearInterval(chatTimer);dashboard()">رجوع</button><div class="card chat-card"><h2>المحادثة للطلب #${id}</h2><div class="chat" id="chatbox"></div><form class="chat-input-row" onsubmit="sendMsg(event,${id})"><input id="msg" autocomplete="off" placeholder="اكتب رسالة"><button class="btn send-text-btn">إرسال</button></form><div class="chat-icon-tools"><button class="round-action location-action" onclick="sendLocation(${id})" title="إرسال الموقع">📍</button><button id="micBtn" class="round-action mic-action" onclick="toggleRec(${id})" title="تسجيل صوت">🎙️</button><button id="sendVoiceBtn" class="round-action send-voice-action hide" onclick="stopRec(${id})" title="إرسال الصوت">➤</button><span id="recordingLabel" class="recording-label hide">● جاري التسجيل...</span></div><small class="muted">المحادثة تتحدث تلقائياً، ويمكنك إرسال صوت أو موقعك بضغطة زر.</small></div></div>`;renderMessages(j.messages);chatTimer=setInterval(refreshChat,5000)}
async function sendMsg(e,id){e.preventDefault();try{let text=msg.value.trim();if(!text)return;msg.value='';let j=await api(`/api/requests/${id}/messages`,{method:'POST',body:JSON.stringify({body:text})});renderMessages(j.messages)}catch(err){toast(err.message)}}

async function toggleRec(id){
  if(recorder && recorder.state==='recording') return stopRec(id);
  return startRec(id);
}
async function startRec(id){try{let stream=await navigator.mediaDevices.getUserMedia({audio:true});audioChunks=[];recordingId=id;recorder=new MediaRecorder(stream);recorder.ondataavailable=e=>audioChunks.push(e.data);recorder.start();$('#micBtn')?.classList.add('recording');$('#sendVoiceBtn')?.classList.remove('hide');$('#recordingLabel')?.classList.remove('hide');toast('بدأ التسجيل الصوتي')}catch(e){toast('لم يتم السماح باستخدام الميكروفون')}}
async function stopRec(id){try{if(!recorder||recorder.state!=='recording')return toast('لا يوجد تسجيل يعمل');recorder.onstop=async()=>{let blob=new Blob(audioChunks,{type:'audio/webm'});let fd=new FormData();fd.append('audio',blob,'voice.webm');let j=await api(`/api/requests/${id}/audio`,{method:'POST',body:fd});renderMessages(j.messages);$('#micBtn')?.classList.remove('recording');$('#sendVoiceBtn')?.classList.add('hide');$('#recordingLabel')?.classList.add('hide');toast('تم إرسال التسجيل الصوتي')};recorder.stop()}catch(e){toast(e.message)}}
async function sendLocation(id){if(!navigator.geolocation)return toast('المتصفح لا يدعم تحديد الموقع');navigator.geolocation.getCurrentPosition(async pos=>{let lat=pos.coords.latitude.toFixed(6),lng=pos.coords.longitude.toFixed(6);try{let j=await api(`/api/requests/${id}/messages`,{method:'POST',body:JSON.stringify({body:`[location]${lat},${lng}`})});renderMessages(j.messages);toast('تم إرسال الموقع')}catch(e){toast(e.message)}},()=>toast('لم يتم السماح بالوصول للموقع'),{enableHighAccuracy:true,timeout:10000})}

async function techDash(){let me=(await api('/api/me')).user;state.user=me;let menu=[['dash','الرئيسية'],['orders','الطلبات'],['balance','الرصيد والباقات'],['topups','طلبات الشحن'],['ledger','سجل الرصيد']];let c='';if(state.tab==='orders'){let j=await api('/api/requests');c=`<div class="card"><h2>الطلبات المناسبة</h2>${reqTable(j.requests)}</div>`}else if(state.tab==='balance'){c=balancePage(me)}else if(state.tab==='topups'){let j=await api('/api/topups');c=topupTable(j.topups)}else if(state.tab==='ledger'){let j=await api('/api/ledger');c=ledgerTable(j.ledger)}else c=`<div class="cards4"><div class="stat"><span>الرصيد</span><br><b>${me.balance} د.أ</b></div><div class="stat"><span>طلبات مجانية مستخدمة</span><br><b>${me.free_orders_used}/2</b></div><div class="stat"><span>التقييم</span><br><b>${stars(me.rating_avg)}</b></div><div class="stat"><span>الأعمال</span><br><b>${me.completed_jobs}</b></div></div>`;layout('لوحة الفني',menu,c)}
function balancePage(me){
  const pm = (state.meta.paymentMethods && state.meta.paymentMethods[0]) || {};
  const packages = state.meta.packages || [];

  return `
    <div class="card">
      <h2>رصيدك الحالي: ${me.balance || 0} د.أ</h2>
      <p class="muted">
        اختر الباقة المناسبة، حوّل المبلغ على الحساب البنكي، ثم ارفع صورة وصل الدفع.
        الإدارة تراجع الطلب وتضيف الرصيد بعد الموافقة.
      </p>
    </div>

    <br>

    <div class="cards2">
      ${packages.map(p => `
        <div class="card package">
          <h3>${p.name}</h3>
          <strong>${p.amount} د.أ</strong>
          <p>بونص: ${p.bonus || 0} د.أ</p>
          <button class="btn" onclick="topupForm(${p.id})">
            اختيار الباقة
          </button>
        </div>
      `).join('')}
    </div>

    <br>

    <div class="card">
      <h3>بيانات الدفع</h3>
      <p><b>البنك:</b> ${pm.bank_name || '-'}</p>
      <p><b>اسم الحساب:</b> ${pm.account_name || '-'}</p>
      <p><b>رقم الحساب / IBAN:</b> ${pm.account_number || '-'}</p>
      <p><b>رقم التواصل:</b> ${pm.phone || '-'}</p>
      <p class="muted">${pm.instructions || ''}</p>
    </div>
  `;
}
function topupForm(pid){
  const p = (state.meta.packages || []).find(x => x.id == pid);
  const pm = (state.meta.paymentMethods && state.meta.paymentMethods[0]) || {};

  if(!p){
    toast('الباقة غير موجودة');
    return;
  }

  app.innerHTML = `
    <div class="page">
      <button class="btn ghost" onclick="dashboard()">رجوع</button>

      <div class="card">
        <h2>شحن ${p.name}</h2>

        <p><b>قيمة الباقة:</b> ${p.amount} د.أ</p>
        <p><b>البونص:</b> ${p.bonus || 0} د.أ</p>

        <h3>بيانات التحويل</h3>
        <p><b>البنك:</b> ${pm.bank_name || '-'}</p>
        <p><b>اسم الحساب:</b> ${pm.account_name || '-'}</p>
        <p><b>رقم الحساب:</b> ${pm.account_number || '-'}</p>

        <form class="form" onsubmit="sendTopup(event,${p.id})">
          <div class="field">
            <label>صورة إثبات الدفع</label>
            <input id="receipt" type="file" accept="image/png,image/jpeg,image/webp" required>
          </div>

          <div class="field">
            <label>ملاحظة للإدارة</label>
            <textarea id="topupNote"></textarea>
          </div>

          <button class="btn">إرسال للمراجعة</button>
        </form>
      </div>
    </div>
  `;
}
async function sendTopup(e,pid){
  e.preventDefault();

  let fd = new FormData();

  fd.append('package_id', pid);
  const receiptInput = document.getElementById('receipt');
  if(!receiptInput || !receiptInput.files[0]){
    toast('الرجاء اختيار صورة إثبات الدفع');
    return;
  }
  fd.append('receipt', receiptInput.files[0]);

  const note = document.getElementById('topupNote');
  if(note) fd.append('note', note.value || '');

  try{
    await api('/api/topups',{
      method:'POST',
      body:fd
    });

    toast('تم إرسال طلب الشحن للإدارة');

    state.tab='topups';
    dashboard();

  }catch(err){
    toast(err.message);
  }
}
function topupTable(rows){return `<div class="card"><h2>طلبات الشحن</h2>${!rows.length?'<div class="empty">لا يوجد</div>':`<table class="table"><tr><th>#</th><th>الفني</th><th>الباقة</th><th>المبلغ</th><th>الصورة</th><th>الحالة</th><th>إجراء</th></tr>${rows.map(t=>`<tr><td>${t.id}</td><td>${_x(t.technician_name||'-')}</td><td>${_x(t.package_name||'-')}</td><td>${_x(String(t.amount||0))}</td><td>${_safeSrc(t.receipt_url)?`<a target="_blank" rel="noopener noreferrer" href="${_safeSrc(t.receipt_url)}">فتح</a>`:'—'}</td><td><span class="status ${_x(t.status)}">${_x(t.status||'')}</span></td><td>${state.user.role==='admin'&&t.status==='pending'?`<button class="btn green" onclick="reviewTopup(${t.id},'approved')">موافقة</button> <button class="btn red" onclick="reviewTopup(${t.id},'rejected')">رفض</button>`:''}</td></tr>`).join('')}</table>`}</div>`}
async function reviewTopup(id,status){let note=prompt('ملاحظة الإدارة','تمت المراجعة');try{await api(`/api/admin/topups/${id}/review`,{method:'POST',body:JSON.stringify({status,admin_note:note})});toast('تمت المراجعة');admin()}catch(e){toast(e.message)}}
function ledgerTable(rows){return `<div class="card"><h2>سجل الرصيد</h2>${!rows.length?'<div class="empty">لا يوجد</div>':`<table class="table"><tr><th>النوع</th><th>المبلغ</th><th>الرصيد بعد العملية</th><th>ملاحظة</th><th>التاريخ</th></tr>${rows.map(l=>`<tr><td>${l.type}</td><td>${l.amount}</td><td>${l.balance_after}</td><td>${l.note||''}</td><td>${l.created_at}</td></tr>`).join('')}</table>`}</div>`}
async function admin(){let menu=[['dash','الإحصائيات'],['users','المستخدمين'],['orders','الطلبات'],['topups','شحن الفنيين'],['services','المهن والخدمات'],['packages','الباقات']];let c='';if(state.tab==='users'){let j=await api('/api/admin/users');c=usersTable(j.users)}else if(state.tab==='orders'){let j=await api('/api/requests');c=`<div class="card"><h2>كل الطلبات</h2>${reqTable(j.requests)}</div>`}else if(state.tab==='topups'){let j=await api('/api/topups');c=topupTable(j.topups)}else if(state.tab==='services')c=servicesAdmin();else if(state.tab==='packages')c=packagesAdmin();else{let j=await api('/api/admin/stats');let s=j.stats;c=`<div class="cards4"><div class="stat"><span>العملاء</span><br><b>${s.customers}</b></div><div class="stat"><span>الفنيين</span><br><b>${s.technicians}</b></div><div class="stat"><span>الطلبات</span><br><b>${s.requests}</b></div><div class="stat"><span>شحن بانتظار</span><br><b>${s.pendingTopups}</b></div></div>`}layout('لوحة الإدارة',menu,c)}
function usersTable(rows){return `<div class="card"><h2>المستخدمين</h2><table class="table"><tr><th>#</th><th>الصورة</th><th>الدور</th><th>الاسم</th><th>الهاتف</th><th>الرقم الوطني</th><th>الرصيد</th><th>التقييم</th><th>حالة</th><th></th></tr>${rows.map(u=>`<tr><td>${u.id}</td><td>${u.avatar_url?`<img src="${u.avatar_url}" class="miniAvatar">`:'-'}</td><td>${v15EscapeHtml(u.role||"")}</td><td>${v15EscapeHtml(u.name||"")}</td><td>${v15EscapeHtml(u.phone||"")}</td><td>${v15EscapeHtml(u.national_number||"-")}</td><td>${u.balance}</td><td>${u.role==='technician'?stars(u.rating_avg):'-'}</td><td>${u.is_active?'فعال':'موقوف'}</td><td>${u.role!=='admin'?`<button class="btn ghost" onclick="toggleUser(${u.id})">تفعيل/إيقاف</button>`:''}</td></tr>`).join('')}</table></div>`}
async function toggleUser(id){await api(`/api/admin/users/${id}/toggle`,{method:'POST'});admin()}

function servicesAdmin(){return `<div class="card"><h2>إضافة مهنة / خدمة جديدة</h2><form class="form two" onsubmit="addService(event)"><div class="field"><label>اسم المهنة</label><input id="sname" placeholder="مثال: فني طاقة شمسية" required></div><div class="field"><label>أيقونة اختيارية</label><input id="sicon" placeholder="🔧"></div><button class="btn">إضافة</button></form></div><br><div class="grid">${state.meta.services.map(s=>`<div class="card"><div class="icon">${s.icon||'🔧'}</div><h3>${s.name}</h3></div>`).join('')}</div>`}
async function addService(e){e.preventDefault();try{await api('/api/admin/services',{method:'POST',body:JSON.stringify({name:sname.value,icon:sicon.value||'🔧'})});state.meta=await api('/api/meta');toast('تمت إضافة المهنة بنجاح');state.tab='services';admin()}catch(err){toast(err.message)}}

function packagesAdmin(){return `<div class="card"><h2>إضافة باقة</h2><form class="form two" onsubmit="addPkg(event)"><input id="pname" placeholder="اسم الباقة"><input id="pamount" type="number" placeholder="المبلغ"><input id="pbonus" type="number" placeholder="بونص"><input id="pcomm" type="number" value="2" placeholder="خصم الطلب"><button class="btn">إضافة</button></form></div><br><div class="cards2">${state.meta.packages.map(p=>`<div class="card"><h3>${p.name}</h3><b>${p.amount} د.أ</b><p>بونص ${p.bonus} - خصم ${p.commission_per_order}</p></div>`).join('')}</div>`}
async function addPkg(e){e.preventDefault();try{await api('/api/admin/packages',{method:'POST',body:JSON.stringify({name:pname.value,amount:pamount.value,bonus:pbonus.value,commission_per_order:pcomm.value})});state.meta=await api('/api/meta');toast('تمت إضافة الباقة');admin()}catch(err){toast(err.message)}}
init();

function menuIcon(key){return ({dash:'🏠',users:'👥',orders:'🛒',topups:'🚚',services:'💼',packages:'⚙️',near:'📍',balance:'💳',ledger:'📘'}[key]||'•')}
function roleName(){return state.user?.role==='admin'?'مدير النظام':state.user?.role==='technician'?'فني معتمد':'عميل'}
function heroMetrics(items){return `<div class="hero-metrics-row">${items.map(x=>`<div class="metric-card-sm"><div class="mc-icon">${x.icon}</div><div class="mc-val">${x.value}</div><div class="mc-label">${x.label}</div><div class="mc-badge">↑ ${x.up||'نشط'}</div></div>`).join('')}</div>`}
function dashboardHero(title,sub,items){return `<div class="dh-slim"><div class="dh-slim-top"><span class="dh-slim-title">👋 ${title}</span></div>${heroMetrics(items)}</div>`}
function activityBox(){return `<div class="dash-card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2>الأنشطة الأخيرة</h2><button class="btn ghost mini">عرض الكل</button></div><div class="activity-list"><div class="activity-item"><div><b>تم تسجيل مستخدم جديد</b><br><small class="muted">منذ 5 دقائق</small></div><span class="activity-icon">👤</span></div><div class="activity-item"><div><b>طلب خدمة كهرباء جديد</b><br><small class="muted">منذ 15 دقيقة</small></div><span class="activity-icon">⚡</span></div><div class="activity-item"><div><b>تم إكمال طلب صيانة</b><br><small class="muted">منذ 30 دقيقة</small></div><span class="activity-icon">✅</span></div><div class="activity-item"><div><b>إضافة خدمة جديدة</b><br><small class="muted">منذ ساعة</small></div><span class="activity-icon">➕</span></div></div></div>`}
function promoBox(title='طور خدماتك', text='قدم أفضل تجربة لعملائك وزد من أرباحك'){return `<div class="dash-card promo-card"><div class="promo-illustration">👨‍🔧</div><h2>${title}</h2><p class="muted">${text}</p><button class="btn ghost">← استكشف المزيد</button></div>`}
function categoriesBox(){let cats=[['أعمال البناء','🏗️','12 خدمة'],['الصيانة والإصلاح','🔧','18 خدمة'],['التنظيف','🧽','16 خدمة'],['نقل وتوصيل','🚚','10 خدمة'],['أخرى','•••','8 خدمات']];return `<div class="dash-card" style="margin-bottom:18px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><h2>الفئات الرئيسية</h2><button class="btn ghost mini">عرض الكل</button></div><div class="category-row">${cats.map(c=>`<div class="category-card"><div><h3>${c[0]}</h3><small>${c[2]}</small></div><div class="cat-icon">${c[1]}</div></div>`).join('')}</div></div>`}
function chartsBox(){return `<div class="dash-grid"><div class="dash-card"><h2>أداء الشهر</h2><div class="chart-fake"></div></div><div class="dash-card"><h2>توزيع الطلبات</h2><div class="donut-fake"></div><div class="mini-list" style="margin-top:18px"><div class="mini-list-row"><span>مكتملة</span><b>65%</b></div><div class="mini-list-row"><span>قيد التنفيذ</span><b>25%</b></div><div class="mini-list-row"><span>ملغاة</span><b>10%</b></div></div></div><div class="dash-card"><h2>أعلى الخدمات طلباً</h2><div class="mini-list"><div class="mini-list-row"><span>كهرباء</span><b>342 طلب ⚡</b></div><div class="mini-list-row"><span>سباكة</span><b>298 طلب 💧</b></div><div class="mini-list-row"><span>تكييف</span><b>221 طلب ❄️</b></div></div></div></div>`}
function layout(title,menu,content){document.body.classList.add('dashboard-mode');let user=state.user||{};app.innerHTML=`<div class="admin-shell"><aside class="admin-sidebar"><div class="admin-logo"><img src="/logo.png" alt="صلّحلي" class="logo-img">صلّحلي</div><div class="admin-section-label">الرئيسية</div><div class="admin-menu">${menu.map(m=>`<button class="sidebtn ${state.tab===m[0]?'active':''}" onclick="state.tab='${m[0]}';dashboard();setTimeout(v35ScrollToContent,80)"><b>${m[1]}</b><span class="mi">${menuIcon(m[0])}</span></button>`).join('')}</div><div class="admin-section-label">النظام</div><div class="admin-menu"><button class="sidebtn" onclick="toast('الإعدادات لاحقاً')"><b>الإعدادات</b><span class="mi">⚙️</span></button><button class="sidebtn" onclick="logout()"><b>تسجيل الخروج</b><span class="mi">🚪</span></button></div><div class="admin-profile"><div class="avatar-sm">${(user.name||'ص').slice(0,1)}</div><div><b>${user.name||roleName()}</b><small>${user.email||roleName()}</small></div></div></aside><main class="admin-main"><div class="admin-top"><div class="admin-search">🔎 <input placeholder="ابحث هنا..." onkeydown="if(event.key==='Enter')toast('البحث التجريبي: '+this.value)"></div><div class="admin-actions"><button class="admin-icon-btn" onclick="toast('لا توجد إشعارات جديدة')">🔔</button><button class="admin-icon-btn" onclick="document.body.classList.toggle('dark-dash')">🌙</button><button class="admin-icon-btn logout" onclick="logout()">⏻</button></div></div>${content}</main></div>`}
async function custDash(){let menu=[['dash','طلب جديد'],['near','الفنيين الأقرب'],['orders','طلباتي']];let c=''; if(state.tab==='orders'){let j=await api('/api/requests');c=dashboardHero('لوحة العميل','تابع طلباتك واختر الفنيين المناسبين بسهولة',[{label:'طلباتي',value:j.requests.length,up:'طلبات نشطة',icon:'🛒'},{label:'فنيين قريبين',value:'24',up:'حسب منطقتك',icon:'👥'},{label:'خدمات متاحة',value:state.meta.services.length,up:'خدمة',icon:'📦'},{label:'التقييم',value:'4.8',up:'موثوق',icon:'⭐'}])+`<div class="dash-card"><h2>طلباتي</h2>${reqTable(j.requests)}</div>`}else if(state.tab==='near'){c=dashboardHero('الفنيين الأقرب لك','حدد موقعك وشاهد الفنيين حسب الخدمة والمنطقة',[{label:'فنيين متاحين',value:'24',up:'متصلين',icon:'👨‍🔧'},{label:'الخدمات',value:state.meta.services.length,up:'جاهزة',icon:'💼'},{label:'المدن',value:state.meta.cities.length,up:'مغطاة',icon:'📍'},{label:'سرعة الرد',value:'15د',up:'متوسط',icon:'⚡'}])+nearbyPage()}else c=dashboardHero('لوحة العميل','اطلب خدمة خلال دقيقة وتابعها من مكان واحد',[{label:'طلباتك',value:'0',up:'ابدأ الآن',icon:'🛠️'},{label:'فنيين',value:'856',up:'نشط',icon:'👥'},{label:'خدمات',value:state.meta.services.length,up:'متوفرة',icon:'📦'},{label:'دفع',value:'كاش',up:'سهل',icon:'💵'}])+`<div class="dash-grid"><div>${activityBox()}</div><div class="dash-card v6-form">${requestForm()}</div>${promoBox('اختر الفني الأنسب','قارن التقييمات ومناطق العمل قبل إرسال الطلب')}</div>${categoriesBox()}`;layout('لوحة العميل',menu,c); if(state.tab==='near') loadNearby();}
async function techDash(){let me=(await api('/api/me')).user;state.user=me;let menu=[['dash','الرئيسية'],['orders','الطلبات'],['balance','الرصيد والباقات'],['topups','طلبات الشحن'],['ledger','سجل الرصيد']];let c='';if(state.tab==='orders'){let j=await api('/api/requests');c=dashboardHero('لوحة الفني','تابع الطلبات القريبة وقدم عروضك بسرعة',[{label:'طلبات مناسبة',value:j.requests.length,up:'جديدة',icon:'🛒'},{label:'رصيدك',value:(me.balance||0)+' د.أ',up:'متاح',icon:'💳'},{label:'تقييمك',value:stars(me.rating_avg),up:'ثقة',icon:'⭐'},{label:'الأعمال',value:me.completed_jobs||0,up:'مكتملة',icon:'✅'}])+`<div class="dash-card"><h2>الطلبات المناسبة</h2>${reqTable(j.requests)}</div>`}else if(state.tab==='balance'){c=dashboardHero('الرصيد والباقات','اشحن رصيدك وتابع خصم عمولة الطلبات',[{label:'الرصيد',value:(me.balance||0)+' د.أ',up:'متاح',icon:'💳'},{label:'مجاني مستخدم',value:(me.free_quota_used ?? (me.free_orders_used||0))+'/2',up:'طلبات',icon:'🎁'},{label:'الباقات',value:state.meta.packages.length,up:'متاحة',icon:'📦'},{label:'الأعمال',value:me.completed_jobs||0,up:'منجزة',icon:'✅'}])+balancePage(me)}else if(state.tab==='topups'){let j=await api('/api/topups');c=dashboardHero('طلبات الشحن','تابع حالة دفعاتك وموافقات الإدارة',[{label:'طلبات الشحن',value:j.topups.length,up:'إجمالي',icon:'🚚'},{label:'الرصيد',value:(me.balance||0)+' د.أ',up:'متاح',icon:'💳'},{label:'باقات',value:state.meta.packages.length,up:'متوفرة',icon:'📦'},{label:'حالة الحساب',value:'فعال',up:'نشط',icon:'✅'}])+topupTable(j.topups)}else if(state.tab==='ledger'){let j=await api('/api/ledger');c=dashboardHero('سجل الرصيد','كل عمليات الخصم والشحن في مكان واحد',[{label:'عمليات',value:j.ledger.length,up:'مسجلة',icon:'📘'},{label:'الرصيد',value:(me.balance||0)+' د.أ',up:'حالي',icon:'💳'},{label:'طلبات',value:me.completed_jobs||0,up:'مكتملة',icon:'✅'},{label:'تقييم',value:stars(me.rating_avg),up:'فني',icon:'⭐'}])+ledgerTable(j.ledger)}else c=dashboardHero('لوحة الفني','إدارة احترافية لطلباتك ورصيدك وتقييمك',[{label:'الرصيد',value:(me.balance||0)+' د.أ',up:'متاح',icon:'💳'},{label:'طلبات مجانية',value:(me.free_quota_used ?? (me.free_orders_used||0))+'/2',up:'مستخدمة',icon:'🎁'},{label:'التقييم',value:stars(me.rating_avg),up:'ثقة',icon:'⭐'},{label:'الأعمال',value:me.completed_jobs||0,up:'مكتملة',icon:'✅'}])+`<div class="dash-grid"><div>${activityBox()}</div>${promoBox('زِد فرص قبولك','حدّث صورتك وخدماتك ومناطق عملك لتحصل على طلبات أكثر')}<div class="dash-card"><h2>ملخص سريع</h2><div class="mini-list"><div class="mini-list-row"><span>حالة الحساب</span><b>فعال</b></div><div class="mini-list-row"><span>العمولة لكل طلب</span><b>2 د.أ</b></div><div class="mini-list-row"><span>الأعمال المكتملة</span><b>${me.completed_jobs||0}</b></div></div></div></div>${chartsBox()}`;layout('لوحة الفني',menu,c)}
async function admin(){let menu=[['dash','لوحة الإدارة'],['users','المستخدمين'],['orders','الطلبات'],['topups','شحن الفنيين'],['services','المهن والخدمات'],['packages','الباقات']];let c='';if(state.tab==='users'){let j=await api('/api/admin/users');c=dashboardHero('إدارة المستخدمين','تحكم بحسابات العملاء والفنيين وحالات التفعيل',[{label:'المستخدمين',value:j.users.length,up:'إجمالي',icon:'👥'},{label:'الفنيين',value:j.users.filter(u=>u.role==='technician').length,up:'فنيين',icon:'👨‍🔧'},{label:'العملاء',value:j.users.filter(u=>u.role==='customer').length,up:'عملاء',icon:'🙂'},{label:'نشط',value:j.users.filter(u=>u.is_active).length,up:'حساب',icon:'✅'}])+usersTable(j.users)}else if(state.tab==='orders'){let j=await api('/api/requests');c=dashboardHero('إدارة الطلبات','راقب جميع طلبات المنصة وحالات التنفيذ',[{label:'كل الطلبات',value:j.requests.length,up:'إجمالي',icon:'🛒'},{label:'مفتوحة',value:j.requests.filter(r=>r.status==='open').length,up:'طلب',icon:'⚡'},{label:'مكتملة',value:j.requests.filter(r=>r.status==='completed').length,up:'طلب',icon:'✅'},{label:'قيد العمل',value:j.requests.filter(r=>r.status==='accepted').length,up:'طلب',icon:'🔧'}])+`<div class="dash-card"><h2>كل الطلبات</h2>${reqTable(j.requests)}</div>`}else if(state.tab==='topups'){let j=await api('/api/topups');c=dashboardHero('شحن الفنيين','راجع إثباتات الدفع وفعّل أرصدة الفنيين',[{label:'طلبات الشحن',value:j.topups.length,up:'إجمالي',icon:'🚚'},{label:'بانتظار',value:j.topups.filter(t=>t.status==='pending').length,up:'مراجعة',icon:'⏳'},{label:'موافق عليها',value:j.topups.filter(t=>t.status==='approved').length,up:'عملية',icon:'✅'},{label:'مرفوضة',value:j.topups.filter(t=>t.status==='rejected').length,up:'عملية',icon:'❌'}])+topupTable(j.topups)}else if(state.tab==='services')c=dashboardHero('المهن والخدمات','أضف خدمات جديدة ورتّبها بشكل جذاب داخل المنصة',[{label:'الخدمات',value:state.meta.services.length,up:'متاحة',icon:'💼'},{label:'الأيقونات',value:'جاهزة',up:'UI',icon:'🎨'},{label:'الفئات',value:'5',up:'رئيسية',icon:'📦'},{label:'النظام',value:'فعال',up:'مباشر',icon:'✅'}])+`<div class="dash-grid two"><div class="dash-card v6-form">${servicesAdmin()}</div>${promoBox('وسّع الخدمات','أضف مهن جديدة مثل الطاقة الشمسية، الزجاج، الأثاث وغيرها')}</div>${categoriesBox()}`;else if(state.tab==='packages')c=dashboardHero('إدارة الباقات','أنشئ باقات شحن للفنيين وحدد العمولة',[{label:'الباقات',value:state.meta.packages.length,up:'متاحة',icon:'📦'},{label:'الدفع',value:'بنكي',up:'تحويل',icon:'🏦'},{label:'العمولة',value:'2 د.أ',up:'افتراضي',icon:'💳'},{label:'حالة',value:'فعال',up:'جاهز',icon:'✅'}])+packagesAdmin();else{let j=await api('/api/admin/stats');let s=j.stats;c=dashboardHero('مرحباً بك في لوحة الإدارة','تحكم كامل في خدماتك وإحصائياتك من مكان واحد',[{label:'إجمالي الإيرادات',value:'25,680 د.ج',up:'24%',icon:'💲'},{label:'الطلبات الكلية',value:s.requests||0,up:'18%',icon:'🛍️'},{label:'المستخدمين',value:(s.customers||0)+(s.technicians||0),up:'12%',icon:'👥'},{label:'الخدمات النشطة',value:state.meta.services.length,up:'7%',icon:'📦'}])+`<div class="dash-grid"><div>${activityBox()}</div><div class="dash-card v6-form">${servicesAdmin()}</div>${promoBox('طور خدماتك','قدم أفضل الخدمات لعملائك وزد من أرباحك')}</div>${categoriesBox()}${chartsBox()}`}layout('لوحة الإدارة',menu,c)}



function showWelcomeModal(){
  if(sessionStorage.sallehlyWelcomeSeen) return;
  sessionStorage.sallehlyWelcomeSeen='1';
  const el=document.createElement('div'); el.className='welcome-overlay'; el.id='welcomeOverlay';
  el.innerHTML=`<div class="welcome-card"><button class="welcome-close" onclick="closeWelcome()">×</button><div class="welcome-logo"><img src="/logo.png" alt="صلّحلي" class="logo-img"></div><h2>صلّحلي</h2><p>منصة صلّحلي لطلب خدمات الصيانة بسرعة وثقة. اختر الخدمة، انشر الطلب، وتابع الفني من لوحة مرتبة وآمنة.</p><div class="welcome-actions"><button class="btn" onclick="closeWelcome();go('register')">ابدأ الآن</button><button class="btn ghost" onclick="closeWelcome();go('services')">استعرض الخدمات</button></div></div>`;
  document.body.appendChild(el);
}
function closeWelcome(){const el=document.getElementById('welcomeOverlay'); if(el){el.style.opacity='0';setTimeout(()=>el.remove(),220)}}

function serviceMarquee(){
 const list=(state.meta.services||[]).slice(0,16); const data=[...list,...list];
 return `<section class="service-marquee-wrap"><div class="service-marquee-head"><div><h2>الخدمات الأكثر طلباً</h2><span>تتحرك تلقائياً — اختر الخدمة المناسبة بسرعة</span></div><button class="btn ghost mini" onclick="go('services')">كل الخدمات</button></div><div class="service-marquee">${data.map(s=>`<div class="service-pill" onclick="go('${state.user?'dashboard':'register'}')"><div class="icon">${s.icon||'🔧'}</div><div><h3>${s.name}</h3><p>طلب سريع، فنيين قريبين، وتقييم واضح قبل الاختيار.</p></div></div>`).join('')}</div></section>`
}
function securityIdeas(){return `<div class="security-strip"><div class="security-item"><b>🔒 منع تداخل الطلبات</b><small>الفني لا يستطيع قبول طلب جديد قبل إنهاء الطلب النشط.</small></div><div class="security-item"><b>🧾 سجل عمليات</b><small>كل طلب، شحن رصيد، وخصم عمولة محفوظ داخل النظام.</small></div><div class="security-item"><b>🛡️ حماية رفع الملفات</b><small>قبول صور محددة فقط وحجم محدود لإثبات الدفع وصورة الفني.</small></div><div class="security-item"><b>⭐ تقييم بعد الإنجاز</b><small>العميل يقيّم الفني بعد اكتمال الطلب لرفع الثقة.</small></div></div>`}
const __oldHome=home; home=function(){__oldHome(); const sec=document.querySelector('.services-section'); if(sec) sec.insertAdjacentHTML('beforebegin',serviceMarquee()+securityIdeas());}
const __oldCustDash=custDash; custDash=async function(){await __oldCustDash(); const main=document.querySelector('.admin-main'); if(main && state.tab==='dash'){const hero=main.querySelector('.dashboard-hero'); if(hero) hero.insertAdjacentHTML('afterend',serviceMarquee()+securityIdeas());}}
const __oldTechDash=techDash; techDash=async function(){await __oldTechDash(); const main=document.querySelector('.admin-main'); if(main && state.tab==='dash'){const hero=main.querySelector('.dashboard-hero'); if(hero) hero.insertAdjacentHTML('afterend',`<div class="lock-note">⚠️ نظام صلّحلي: لا يمكنك قبول طلب جديد أثناء وجود طلب قيد التنفيذ أو تم اختيارك له. أنهي الطلب الحالي أولاً.</div>`+securityIdeas());}}
const __oldAdmin=admin; admin=async function(){await __oldAdmin(); const main=document.querySelector('.admin-main'); if(main && state.tab==='dash'){const hero=main.querySelector('.dashboard-hero'); if(hero) hero.insertAdjacentHTML('afterend',securityIdeas());}}


const JORDAN_AREAS = {
  'عمان':['القويسمة','الجبيهة','طبربور','صويلح','خلدا','تلاع العلي','مرج الحمام','ضاحية الياسمين','البيادر','الدوار السابع','الدوار الثامن','أبو نصير','شفا بدران','النصر','ماركا','الهاشمي الشمالي','جبل الحسين','جبل عمان','عبدون','دابوق','الرابية','أم أذينة','وادي السير','ناعور','المقابلين','سحاب','اليادودة','خريبة السوق'],
  'الزرقاء':['الزرقاء الجديدة','الجبل الأبيض','الرصيفة','ياجوز','الغويرية','الهاشمية','بيرين','الضليل','حي معصوم','حي الأمير محمد','الزواهرة'],
  'إربد':['وسط البلد','الحي الشرقي','الحي الجنوبي','الحي الشمالي','الصريح','الحصن','الرمثا','بني كنانة','كفر يوبا','بيت راس','أيدون','كفر أسد','الطيبة'],
  'البلقاء':['السلط','الصبيحي','الفحيص','ماحص','عين الباشا','دير علا','الشونة الجنوبية','زي','يرقا','علان'],
  'الكرك':['الكرك','المزار الجنوبي','مؤتة','المرج','الثنية','القصر','غور الصافي','عي','الربة','فقوع'],
  'معان':['معان','الشوبك','وادي موسى','البتراء','الحسينية','الجفر','أذرح','إيل'],
  'الطفيلة':['الطفيلة','بصيرا','القادسية','الحسا','العين البيضاء','غرندل','الرشادية'],
  'العقبة':['العقبة','القويرة','وادي عربة','الديسة','رحمة','الشامية','المحدود'],
  'جرش':['جرش','سوف','ساكب','برما','كفر خل','المعراض','المصطبة'],
  'عجلون':['عجلون','كفرنجة','عنجره','عبين','صخرة','اشتفينا','رأس منيف'],
  'مادبا':['مادبا','ذيبان','ماعين','الفيصلية','جرينة','مليح','لب'],
  'المفرق':['المفرق','البادية الشمالية','رحاب','الخالدية','أم الجمال','بلعما','سما السرحان','منشية بني حسن']
};
function governorateOptions(selected='عمان'){
  return Object.keys(JORDAN_AREAS).map(c=>`<option ${c===selected?'selected':''}>${c}</option>`).join('');
}
function areaOptions(city='عمان', selected=''){
  return (JORDAN_AREAS[city]||[]).map(a=>`<option ${a===selected?'selected':''}>${a}</option>`).join('') + `<option value="أخرى">أخرى</option>`;
}
function bindAreaSelect(cityId, areaId, otherId){
  const city=document.getElementById(cityId), area=document.getElementById(areaId), other=otherId?document.getElementById(otherId):null;
  if(!city||!area) return;
  const refresh=()=>{ area.innerHTML=areaOptions(city.value); if(other) other.classList.toggle('hide', area.value!=='أخرى'); };
  city.addEventListener('change', refresh);
  area.addEventListener('change', ()=>{ if(other) other.classList.toggle('hide', area.value!=='أخرى'); });
  refresh();
}
function selectedArea(areaId, otherId){
  const a=document.getElementById(areaId)?.value||'';
  const o=document.getElementById(otherId)?.value?.trim()||'';
  return a==='أخرى'?o:a;
}
function showWelcomeModalForce(){
  const old=document.getElementById('welcomeOverlay'); if(old) old.remove();
  const el=document.createElement('div'); el.className='welcome-overlay v8-welcome'; el.id='welcomeOverlay';
  el.innerHTML=`<div class="welcome-card v8-welcome-card">
    <button class="welcome-close" onclick="closeWelcome()">×</button>
    <div class="welcome-logo big-logo"><img src="/logo.png" alt="صلّحلي" class="logo-img"></div>
    <h2>صلّحلي</h2>
    <p>مرحباً بك في منصة صلّحلي. اختر الخدمة، حدد المحافظة والمنطقة، واترك النظام يرشح لك الفنيين الأقرب والأنسب.</p>
    <div class="welcome-features">
      <div><b>ملف مرتب</b><small>إدارة حسابك بأمان</small></div>
      <div><b>فني واحد</b><small>لا يقبل طلب ثاني قبل إنهاء الحالي</small></div>
      <div><b>مناطق دقيقة</b><small>كل محافظات الأردن ومناطقها</small></div>
    </div>
    <div class="welcome-actions"><button class="btn" onclick="closeWelcome();go('${state.user?'dashboard':'register'}')">متابعة إلى المنصة</button><button class="btn ghost" onclick="closeWelcome()">إغلاق</button></div>
  </div>`;
  document.body.appendChild(el);
}

function openTechDetails(t, service, city, area){
  const _esc=typeof v20SafeTxt==='function'?v20SafeTxt:(typeof escapeHtml==='function'?escapeHtml:function(s){return String(s??''). replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));});
  const old=document.getElementById('techDetailsOverlay'); if(old)old.remove();
  const av=t.avatar_url?`<img class="tech-modal-avatar" src="${_safeSrc(t.avatar_url)}" onerror="this.outerHTML='<div class=\'tech-modal-avatar fallback\'>ف</div>'">`:`<div class="tech-modal-avatar fallback">ف</div>`;
  const el=document.createElement('div'); el.className='welcome-overlay'; el.id='techDetailsOverlay';
  el.innerHTML=`<div class="welcome-card tech-details-modal"><button class="welcome-close" onclick="document.getElementById('techDetailsOverlay').remove()">×</button>${av}<h2>${_esc(t.name||"-")}</h2><p class="muted">${stars(t.rating_avg)} — ${t.rating_count||0} تقييم — ${t.completed_jobs||0} عمل مكتمل</p><div class="mini-list"><div class="mini-list-row"><span>المحافظة</span><b>${_esc(t.city||"-")}</b></div><div class="mini-list-row"><span>الخدمات</span><b>${_esc(t.services||"-")}</b></div><div class="mini-list-row"><span>المناطق</span><b>${_esc(t.areas||"-")}</b></div></div><div class="welcome-actions"><button class="btn" onclick="document.getElementById('techDetailsOverlay').remove();directRequest(${t.id},'${String(service).replaceAll("'",'')}','${String(city).replaceAll("'",'')}','${String(area).replaceAll("'",'')}')">إنشاء طلب مع هذا الفني</button><button class="btn ghost" onclick="document.getElementById('techDetailsOverlay').remove()">إغلاق</button></div></div>`;
  document.body.appendChild(el);
}
async function directRequest(techId, service, city, area){
  const desc=prompt('اكتب وصف المشكلة حتى يقدر الفني يفهم الطلب:', `أحتاج خدمة ${service} في ${city}${area?' - '+area:''}`);
  if(!desc || desc.trim().length<10) return toast('الوصف لازم يكون 10 أحرف على الأقل');
  try{
    const j=await api('/api/requests',{method:'POST',body:JSON.stringify({technician_id:techId,service,city,area,description:desc,preferred_time:'أقرب وقت',lat:state.gps?.lat||'',lng:state.gps?.lng||''})});
    toast('تم إنشاء الطلب وفتح المحادثة');
    chat(j.request.id);
  }catch(e){toast(e.message)}
}
function settingsPage(){
  const u = state.user || {};

  let techServices = 'فني';

  if (Array.isArray(u.services)) {
    techServices = u.services
      .map(s => typeof s === 'object' ? (s.name || '') : s)
      .filter(Boolean)
      .join('، ');
  } else if (typeof u.services === 'string' && u.services.trim()) {
    techServices = u.services;
  } else if (u.service) {
    techServices = u.service;
  }

  const profileCard = u.role === 'technician' ? `
    <div class="dash-card technician-profile-card">

      <div class="tech-profile-header">

        ${(u.avatar_url || u.avatar)
          ? `<img
              src="${u.avatar_url || u.avatar}"
              class="tech-profile-avatar"
              alt="${u.name || ''}"
              onerror="this.outerHTML='<div class=\\'tech-profile-avatar tech-profile-avatar--fallback\\'>${(u.name||'ف').slice(0,1)}</div>'"
            >`
          : `<div class="tech-profile-avatar tech-profile-avatar--fallback">${(u.name||'ف').slice(0,1)}</div>`
        }

        <div class="tech-profile-info">
          <h2>${u.name || 'الفني'}</h2>
          <div class="tech-badge">${techServices}</div>
        </div>

      </div>

      <div class="tech-profile-grid">

        <div class="tech-item">
          <span>📱 الهاتف</span>
          <strong>${u.phone || '-'}</strong>
        </div>

        <div class="tech-item">
          <span>🪪 الرقم الوطني</span>
          <strong>${u.national_number || '-'}</strong>
        </div>

        <div class="tech-item">
          <span>🛠 المهنة</span>
          <strong>${techServices}</strong>
        </div>

        <div class="tech-item">
          <span>⭐ التقييم</span>
          <strong>${u.rating_avg || 0} / 5</strong>
        </div>

      </div>

    </div>
  ` : '';

  return `
    ${profileCard}

    <div class="settings-grid">

      <div class="dash-card">
        <h2>تعديل الحساب</h2>

        <form class="form two" onsubmit="saveProfile(event)">

          <div class="field">
            <label>الاسم</label>
            <input id="setName" value="${u.name || ''}" required>
          </div>

          <div class="field">
            <label>الهاتف</label>
            <input id="setPhone" value="${u.phone || ''}" required>
          </div>

          <div class="field">
            <label>المحافظة</label>
            <select id="setCity">
              ${governorateOptions(u.city || 'عمان')}
            </select>
          </div>

          <div class="field">
            <label>المنطقة</label>
            <select id="setArea"></select>
          </div>

          <button class="btn">حفظ التعديلات</button>

        </form>
      </div>

      <div class="dash-card">
        <h2>تغيير كلمة السر</h2>

        <form class="form" onsubmit="changePassword(event)">

          <div class="field">
            <label>كلمة السر الحالية</label>
            <input id="oldPass" type="password" required>
          </div>

          <div class="field">
            <label>كلمة السر الجديدة</label>
            <input id="newPass" type="password" minlength="8" required>
          </div>

          <button class="btn">تحديث كلمة السر</button>

        </form>

        <p class="muted">
          نصيحة: استخدم 8 أحرف على الأقل مع أرقام ورموز.
        </p>

      </div>

    </div>
  `;
}
function v13Badge(n){ n=Number(n||0); return n>0?`<em class="chat-badge">${n>99?'99+':n}</em>`:''; }
async function v13LoadChatCount(){
  try{ if(!state.user || state.user.role==='admin') return 0; const j=await api('/api/chats'); state.chatCount=j.total_unread||0; return state.chatCount; }catch(e){ return state.chatCount||0; }
}
function v13Ticker(){
  const sv=(state.meta.services||[]); if(!sv.length) return '';
  const one=sv.map(s=>`<button class="v13-tick" onclick="v11SelectService('${String(s.name).replace(/'/g,"\\'")}')"><span>${s.icon||'🧰'}</span><b>${s.name}</b><small>متوفر الآن</small></button>`).join('');
  return `<section class="v13-ticker-wrap"><div class="v13-ticker-title"><b>⚡ شريط المهن المباشر</b><small>كل مهنة تضيفها من الإدارة تظهر هنا تلقائياً</small></div><div class="v13-ticker-window"><div class="v13-ticker-track">${one}${one}</div></div></section>`;
}
function v13LogoutConfirm(){
  const old=document.getElementById('logoutConfirm'); if(old) old.remove();
  const el=document.createElement('div'); el.id='logoutConfirm'; el.className='logout-modal';
  el.innerHTML=`<div class="logout-box"><button class="welcome-close" onclick="document.getElementById('logoutConfirm').remove()">×</button><div class="logout-icon">🚪</div><h2>تسجيل خروج</h2><p>هل أنت متأكد أنك تريد الخروج من حسابك؟</p><div class="logout-actions"><button class="btn ghost" onclick="document.getElementById('logoutConfirm').remove()">إلغاء</button><button class="btn red" onclick="document.getElementById('logoutConfirm').remove();logout()">نعم، تسجيل خروج</button></div></div>`;
  document.body.appendChild(el);
}
function menuIconV13(k){ if(k==='chats') return '💬'; if(k==='support') return '🎧'; return menuIcon(k); }
const __v13LayoutBase = layout;
layout=function(title,menu,content){
  document.body.classList.add('dashboard-mode');v10ApplyTheme();let user=state.user||{};
  const contentWithTicker = (state.user && state.user.role!=='admin' ? v13Ticker() : '') + content;
  app.innerHTML=`<div class="admin-shell v24-shell"><aside class="admin-sidebar v24-sidebar"><div class="admin-logo"><img src="/logo.png" alt="صلّحلي" class="logo-img">صلّحلي</div><button class="mobile-menu-close" onclick="document.body.classList.remove('sidebar-open')">×</button><div class="admin-section-label">الرئيسية</div><div class="admin-menu">${menu.map(sidebarBtn).join('')}</div><div class="admin-section-label">النظام</div><div class="admin-menu">${allSystem.map(sidebarBtn).join('')}<button type="button" class="sidebtn logout-side v15-logout-side" onclick="v15LogoutConfirm?.()||logout()"><b>تسجيل خروج</b><span class="mi">🚪</span></button></div><div class="admin-profile"><div class="avatar-sm">${v24Safe((user.name||'ص').slice(0,1))}</div><div><b>${v24Safe(user.name||roleName?.()||'مستخدم')}</b><small>${v24Safe(user.email||'')}</small></div></div></aside><main class="admin-main v24-main"><div class="admin-top"><button class="admin-icon-btn mobile-menu-open" onclick="document.body.classList.add('sidebar-open')">☰</button><div class="admin-search">🔎 <input placeholder="بحث عن فني أو خدمة أو طلب..." onkeydown="if(event.key==='Enter'){state.tab=state.user.role==='customer'?'near':'orders';dashboard();setTimeout(()=>{let q=document.getElementById('searchTechQ'); if(q){q.value=this.value; searchTechnicians?.();}},120)}"></div><div class="admin-actions"><button class="admin-icon-btn bell-btn" title="التنبيهات" onclick="state.tab='chats';state.chatCount=0;dashboard()">🔔 ${v24Badge((state.chatCount || 0) + (state.requestCount || 0))}</button><button class="admin-icon-btn" onclick="v10ToggleTheme?.()">🌙</button><button class="admin-icon-btn clean-logout v15-top-logout" onclick="v15LogoutConfirm?.()||logout()">🚪 تسجيل خروج</button></div></div>${typeof v20LiveServicesStrip==='function'?v20LiveServicesStrip():''}<div class="v24-content">${content}</div></main></div>`;
}
async function chatsPage(){
  let j=await api('/api/chats'); 
  state.chatCount=j.total_unread||0;
  const rows=j.chats||[];

  return v11Hero('الدردشات','كل محادثاتك مع العملاء والفنيين في مكان واحد')+
  `<div class="dash-card">
    <div class="v13-card-head">
      <h2>كل الدردشات ${v13Badge(Number(state.chatCount||0))}</h2>
      <p class="muted">الرقم الأحمر يعني رسائل جديدة لم تفتحها بعد.</p>
    </div>
    ${rows.length?`
      <div class="v13-chat-list">
        ${rows.map(c=>`
          <button class="v13-chat-item" onclick="chat(${Number(c.request_id||0)})">
            <div class="v13-chat-avatar">${escapeHtml((c.other_name||'ص').slice(0,1))}</div>
            <div>
              <b>
                ${escapeHtml(c.other_name||'محادثة طلب')}
                ${Number(c.unread_count||0)>0?`<em class="chat-badge inline">${Number(c.unread_count||0)}</em>`:''}
              </b>
              <small>
                #${Number(c.request_id||0)} • 
                ${escapeHtml(c.service||'-')} • 
                ${escapeHtml(c.status||'')}
              </small>
              <p>${escapeHtml(c.last_body||'لا توجد رسائل بعد')}</p>
            </div>
            <span>فتح المحادثة ←</span>
          </button>
        `).join('')}
      </div>
    `:'<div class="empty">لا توجد دردشات حالياً. تظهر الدردشة بعد قبول عرض الفني أو بدء محادثة على طلب.</div>'}
  </div>`;
}

function v15EscapeHtml(s){return String(s??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}

// Fully replace the broken recursive logout popup from V14
function v15LogoutConfirm(){
  const old=document.getElementById('logoutConfirm'); if(old) old.remove();
  const el=document.createElement('div');
  el.id='logoutConfirm';
  el.className='logout-modal v15-logout-modal';
  el.innerHTML=`<div class="logout-box logout-box-pro v15-logout-box">
    <button class="welcome-close v15-close" type="button" onclick="document.getElementById('logoutConfirm')?.remove()">×</button>
    <div class="logout-icon v15-logout-icon">🚪</div>
    <h2>تأكيد تسجيل الخروج</h2>
    <p>سيتم إنهاء الجلسة والرجوع إلى الصفحة الرئيسية.</p>
    <div class="logout-actions">
      <button class="btn ghost" type="button" onclick="document.getElementById('logoutConfirm')?.remove()">إلغاء</button>
      <button class="btn red" type="button" id="v15LogoutNow">نعم، تسجيل خروج</button>
    </div>
  </div>`;
  document.body.appendChild(el);
  document.getElementById('v15LogoutNow')?.addEventListener('click', v15DoLogout, {once:true});
}
async function v15DoLogout(){
  try{ v10Sound?.('logout'); }catch(e){}
  try{ await api('/api/auth/logout',{method:'POST'}); }catch(e){}
  try{ if(socket) socket.disconnect(); }catch(e){}
  try{ if(chatTimer) clearInterval(chatTimer); }catch(e){}
  localStorage.removeItem('token');
  state.user=null; state.tab='dash'; state.chatCount=0;
  document.getElementById('logoutConfirm')?.remove();
  document.body.classList.remove('dashboard-mode','open');
  toast('تم تسجيل الخروج بنجاح');
  setTimeout(()=>{ try{home()}catch(e){location.reload()} },180);
}

async function v17LoadCounters(){
  try{
    if(!state.user) return {orders:0,chats:0};
    const [r,c] = await Promise.allSettled([api('/api/requests'), api('/api/chats')]);
    const requests = r.status==='fulfilled' ? (r.value.requests||[]) : [];
    const chats = c.status==='fulfilled' ? (c.value.chats||[]) : [];
    state.chatCount = c.status==='fulfilled' ? (c.value.total_unread||0) : (state.chatCount||0);
    if(state.user.role==='technician'){
      state.orderCount = requests.filter(x => ['بانتظار العروض','وصلت عروض'].includes(x.status) || x.technician_id===state.user.id).length;
    }else if(state.user.role==='customer'){
      state.orderCount = requests.length;
    }
    return {orders:state.orderCount||0, chats:state.chatCount||0, requests, chats};
  }catch(e){ return {orders:state.orderCount||0,chats:state.chatCount||0,requests:[],chats:[]}; }
}

function v17MenuLabel(key,label){
  let badge='';
  if(key==='chats') badge=v13Badge(state.chatCount);
  if(key==='orders') badge=v13Badge(state.orderCount);
  return `${label} ${badge}`;
}

state.orderFilter = state.orderFilter || 'active';
function v18IsCompleted(r){ return ['مكتمل','ملغي'].includes(r.status); }
function v18SplitRequests(rows){
  return {
    active:(rows||[]).filter(r=>!v18IsCompleted(r)),
    done:(rows||[]).filter(r=>v18IsCompleted(r))
  };
}

function v18OrdersView(rows){
  const parts=v18SplitRequests(rows||[]);
  const filter=state.orderFilter||'active';
  const selected=filter==='done'?parts.done:parts.active;
  return `<div class="v18-tabs"><button class="btn ${filter==='active'?'':'ghost'}" onclick="state.orderFilter='active';dashboard()">طلبات نشطة ${v13Badge(parts.active.length)}</button><button class="btn ${filter==='done'?'':'ghost'}" onclick="state.orderFilter='done';dashboard()">طلبات مكتملة/ملغية ${v13Badge(parts.done.length)}</button></div>${reqTable(selected)}`;
}

async function v18DeleteRequest(id){
  if(!confirm('هل تريد حذف/إلغاء هذا الطلب؟ سيبقى محفوظاً في السجل كملغي.')) return;
  try{ await api(`/api/requests/${id}`,{method:'DELETE'}); toast('تم إلغاء الطلب ونقله للسجل'); await v18RefreshCountersAndPage(); }
  catch(e){ toast(e.message); }
}

window.SALLEHLY_VERSION='V20 Market Ready';

function v20SafeTxt(x){return String(x??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]))}
function v20Badge(n){n=Number(n||0);return n>0?`<span class="v20-badge">${n>99?'99+':n}</span>`:''}
function v20StatusClass(s){s=String(s||''); if(s.includes('مكتمل'))return 'done'; if(s.includes('ملغي')||s.includes('رفض'))return 'cancel'; if(s.includes('عرض')||s.includes('بانتظار'))return 'wait'; if(s.includes('اختيار')||s.includes('تنفيذ'))return 'work'; return 'new'}
function v20ServiceIcon(name){const s=(state.meta.services||[]).find(x=>x.name===name);return s?.icon||'🧰'}

function v20LiveServicesStrip(){
  const services=state.meta.services||[];
  if(!services.length) return '';
  const cards=services.map(s=>`<button class="v20-live-card" onclick="v11SelectService('${String(s.name).replace(/'/g,"\\'")}')"><span>${s.icon||'🧰'}</span><b>${v20SafeTxt(s.name)}</b><small>متوفر الآن</small></button>`).join('');
  return `<section class="v20-live-strip"><div class="v20-strip-head"><div><h2>⚡ شريط المهن المباشر</h2><p>كل مهنة تضيفها الإدارة تظهر هنا تلقائياً وتستمر بالدوران بدون توقف</p></div><button class="btn ghost" onclick="go('services')">كل الخدمات</button></div><div class="v20-marquee"><div class="v20-marquee-track">${cards}${cards}${cards}</div></div></section>`;
}

requestForm=function(){
  return `<div class="v20-form-card"><div class="v20-card-head"><div><span class="eyebrow">طلب جديد</span><h2>🚀 اطلب خدمة الآن</h2><p class="muted">انشر الطلب، ارفع صورة المشكلة اختيارياً، واستقبل عروض السعر والمدة مباشرة.</p></div><span class="v20-pill">Live Offers</span></div>
  <form class="v20-request-form" onsubmit="createReq(event)">
    <div class="field"><label>الخدمة</label><select id="qservice" onchange="syncSearchFromRequest?.()">${(state.meta.services||[]).map(s=>`<option>${s.name}</option>`).join('')}</select></div>
    <div class="field"><label>المحافظة</label><select id="qcity" onchange="bindAreaSelect?.('qcity','qarea','qareaOtherWrap');syncSearchFromRequest?.()">${typeof governorateOptions==='function'?governorateOptions(state.user?.city||'عمان'):(state.meta.cities||[]).map(c=>`<option>${c}</option>`).join('')}</select></div>
    <div class="field"><label>منطقة السكن</label><select id="qarea" onchange="syncSearchFromRequest?.()"></select></div>
    <div class="field hide" id="qareaOtherWrap"><label>اكتب المنطقة</label><input id="qareaOther" placeholder="اكتب اسم المنطقة"></div>
    <div class="field"><label>الوقت المطلوب</label><input id="qtime" placeholder="اليوم مساءً / بكرا صباحاً"></div>
    <div class="field full"><label>وصف المشكلة</label><textarea id="qdesc" required minlength="10" placeholder="مثال: المكيف لا يبرد وأحتاج فني اليوم، نوع الجهاز سبليت..."></textarea></div>
    <div class="field full"><label>صورة المشكلة <em>اختياري</em></label><label class="v20-upload-zone"><input id="problemImage" type="file" accept="image/png,image/jpeg,image/webp" onchange="previewProblemImage()"><span class="cam">📷</span><b>اختر صورة أو اسحبها هنا</b><small>JPG / PNG / WEBP حتى 3MB</small></label><div id="problemPreview" class="v20-preview"></div></div>
    <div class="field full v20-location-row"><button type="button" class="btn ghost" onclick="useGPS('request')">📍 تحديد موقعي الحالي</button><small class="muted">الموقع يساعد الفنيين على معرفة قربك وتقدير السعر قبل إرسال العرض.</small><div id="requestMap" class="v20-map-preview">${typeof mapBox==='function'?mapBox(state.gps?.lat,state.gps?.lng):''}</div></div>
    <button class="btn v20-submit">🚀 نشر الطلب واستقبال عروض الفنيين</button>
  </form></div>`;
};

previewProblemImage=function(){
  const file=document.getElementById('problemImage')?.files?.[0];
  const box=document.getElementById('problemPreview'); if(!box) return;
  if(!file){box.innerHTML='';return;}
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)){box.innerHTML='<small class="danger-text">نوع الصورة غير مسموح</small>';return;}
  const url=URL.createObjectURL(file);
  box.innerHTML=`<div class="v20-preview-card"><img src="${url}" alt="معاينة صورة المشكلة"><div><b>${v20SafeTxt(file.name)}</b><small>${Math.round(file.size/1024)} KB</small><button type="button" class="btn ghost mini" onclick="problemImage.value='';problemPreview.innerHTML=''">إزالة</button></div></div>`;
};

createReq=async function(e){
  e.preventDefault();
  try{
    const fd=new FormData();
    fd.append('service',document.getElementById('qservice')?.value||'');
    fd.append('city',document.getElementById('qcity')?.value||'');
    let area=(typeof selectedArea==='function'?selectedArea('qarea','qareaOther'):(document.getElementById('qarea')?.value||''));
    fd.append('area',area||'');
    fd.append('preferred_time',document.getElementById('qtime')?.value||'');
    fd.append('description',document.getElementById('qdesc')?.value||'');
    fd.append('lat',state.gps?.lat||''); fd.append('lng',state.gps?.lng||'');
    const img=document.getElementById('problemImage')?.files?.[0]; if(img) fd.append('problem_image',img);
    const btn=e.submitter||document.querySelector('.v20-submit'); if(btn){btn.disabled=true;btn.textContent='⏳ جاري نشر الطلب...'}
    await api('/api/requests',{method:'POST',body:fd});
    toast('تم نشر الطلب مباشرة — بانتظار عروض الفنيين'); try{v10Sound?.('request')}catch(_){ }
    state.tab='orders'; state.orderFilter='active'; await dashboard();
  }catch(err){toast(err.message)}
};

function v20SearchPanel(){
  return `<div class="v20-search-panel"><div class="v20-card-head"><div><span class="eyebrow">بحث مباشر</span><h2>🔎 ابحث عن فني</h2><p class="muted">فلترة حسب الخدمة، المحافظة، والمنطقة مع عرض التقييم والملف.</p></div></div>
  <div class="v20-search-grid"><div class="field"><label>كلمة البحث</label><input id="searchTechQ" placeholder="تكييف، كهرباء، سباكة..." oninput="v10AutoService?.()" onkeydown="if(event.key==='Enter')searchTechnicians()"></div><div class="field"><label>الخدمة</label><select id="searchService">${(state.meta.services||[]).map(s=>`<option>${s.name}</option>`).join('')}</select></div><div class="field"><label>المحافظة</label><select id="searchCity" onchange="bindAreaSelect?.('searchCity','searchArea')">${typeof governorateOptions==='function'?governorateOptions(state.user?.city||'عمان'):(state.meta.cities||[]).map(c=>`<option>${c}</option>`).join('')}</select></div><div class="field"><label>المنطقة</label><select id="searchArea"></select></div><button class="btn" onclick="searchTechnicians()">بحث</button><button class="btn ghost" onclick="useGPS('search')">📍 حسب موقعي</button></div></div><div id="techSearchResults" class="v20-tech-results"></div>`;
}
techSearchBox=v20SearchPanel;

function techCard(t, service, city, area){
  const avatar=t.avatar_url?`<img class="v20-tech-avatar" src="${t.avatar_url}" onerror="this.outerHTML='<div class=\'v20-tech-avatar fallback\'>ف</div>'">`:`<div class="v20-tech-avatar fallback">ف</div>`;
  const online=(Number(t.balance||0)>0 || Number(t.free_orders_used||0)<2);
  return `<div class="v20-tech-card">${avatar}<div class="v20-tech-info"><h3>${v20SafeTxt(t.name)}</h3><div>${stars(t.rating_avg)} <small>${t.rating_count||0} تقييم</small></div><div class="v20-chip-row"><span>📍 ${v20SafeTxt(t.city||city||'')}</span><span>✅ ${t.completed_jobs||0} عمل</span><span class="${online?'green-text':'danger-text'}">${online?'متاح':'بحاجة رصيد'}</span></div><p><b>الخدمات:</b> ${v20SafeTxt(t.services||'-')}</p><p><b>المناطق:</b> ${v20SafeTxt(t.areas||area||'-')}</p></div><div class="v20-tech-actions"><button class="btn ghost" onclick='openTechDetails(${JSON.stringify(t).replace(/'/g,"&#39;")}, ${JSON.stringify(service)}, ${JSON.stringify(city)}, ${JSON.stringify(area)})'>ملف الفني</button><button class="btn" onclick="directRequest(${t.id},'${String(service).replaceAll("'",'')}','${String(city).replaceAll("'",'')}','${String(area).replaceAll("'",'')}')">طلب خدمة</button></div></div>`;
}

async function searchTechnicians(){
  try{
    const q=document.getElementById('searchTechQ')?.value?.trim()||'';
    const service=document.getElementById('searchService')?.value||q||state.meta.services?.[0]?.name||'';
    const city=document.getElementById('searchCity')?.value||state.user?.city||'عمان';
    const area=document.getElementById('searchArea')?.value||'';
    const box=document.getElementById('techSearchResults'); if(box) box.innerHTML='<div class="v20-skeleton">جاري البحث عن الفنيين المناسبين...</div>';
    const j=await api(`/api/technicians?q=${encodeURIComponent(q)}&service=${encodeURIComponent(service)}&city=${encodeURIComponent(city)}&area=${encodeURIComponent(area)}&lat=${state.gps?.lat||''}&lng=${state.gps?.lng||''}`);
    const techs=j.technicians||[];
    if(!box) return;
    box.innerHTML=techs.length?techs.map(t=>techCard(t,service,city,area)).join(''):`<div class="dash-card empty">لا يوجد فنيين مناسبين الآن. جرّب خدمة أو منطقة ثانية.</div>`;
  }catch(e){toast(e.message)}
}

function v20Timeline(r){
  const steps=['بانتظار العروض','وصلت عروض','تم اختيار عرض','قيد التنفيذ','مكتمل'];
  const idx=Math.max(0,steps.findIndex(s=>String(r.status||'').includes(s)));
  return `<div class="v20-timeline">${steps.map((s,i)=>`<span class="${i<=idx?'active':''}">${s}</span>`).join('')}</div>`;
}

reqTable=function(rows){
  if(!rows||!rows.length) return '<div class="empty">لا توجد طلبات في هذا القسم</div>';
  return `<div class="v20-request-list">${rows.map(r=>`<article class="v20-request-card ${v20StatusClass(r.status)}"><div class="v20-request-head"><div><h3>${v20ServiceIcon(r.service)} #${r.id} - ${v20SafeTxt(r.service)}</h3><p>${v20SafeTxt(r.city)}${r.area?' - '+v20SafeTxt(r.area):''} • ${v20SafeTxt(r.preferred_time||'وقت غير محدد')}</p></div><span class="v20-status ${v20StatusClass(r.status)}">${v20SafeTxt(r.status)}</span></div>${v20Timeline(r)}<div class="v20-request-body">${r.problem_image_url?`<img class="v20-problem-img" src="${_safeSrc(r.problem_image_url)}" alt="صورة المشكلة">`:''}<p>${v20SafeTxt(r.description||'')}</p></div>${r.lat&&r.lng?`<details class="v20-map-details"><summary>📍 عرض موقع العميل</summary>${typeof mapBox==='function'?mapBox(r.lat,r.lng):''}</details>`:''}<div class="v20-request-meta"><span>👤 العميل: ${v20SafeTxt(r.customer_name||state.user?.name||'-')}</span><span>👨‍🔧 الفني: ${v20SafeTxt(r.technician_name||'-')}</span><span>💰 السعر: ${r.offer_price? r.offer_price+' د.أ':'بانتظار عرض'}</span><span>⏱️ المدة: ${v20SafeTxt(r.arrival_time||'-')}</span></div><div class="actions v20-actions">${actions(r)}</div><div id="offers-${r.id}" class="offers-box v20-offers-box"></div></article>`).join('')}</div>`;
};

offerCards=function(offers,req){
  if(!offers||!offers.length) return '<div class="empty small">لا توجد عروض بعد. سيظهر العرض هنا فوراً عند إرساله من الفني.</div>';
  return `<div class="v20-offers-list"><h3>العروض المستلمة (${offers.length})</h3>${offers.map(o=>`<div class="v20-offer ${o.status}">${o.avatar_url?`<img class="miniAvatar" src="${o.avatar_url}">`:'<div class="miniAvatar fallback">ف</div>'}<div class="v20-offer-info"><b>${v20SafeTxt(o.technician_name)}</b><small>📍 ${v20SafeTxt(o.technician_city||'')} • ${v20SafeTxt(o.technician_areas||'')}</small><span>${stars(o.rating_avg)} • ${o.completed_jobs||0} عمل مكتمل</span><p>${v20SafeTxt(o.note||'لا توجد ملاحظة')}</p></div><div class="v20-offer-price"><b>${o.price} د.أ</b><span>${v20SafeTxt(o.duration)}</span><em>${o.status==='accepted'?'مقبول':o.status==='rejected'?'مرفوض':'بانتظار قرار العميل'}</em>${state.user.role==='customer'&&o.status==='pending'&&req.customer_id===state.user.id?`<button class="btn green mini" onclick="decideOffer(${o.id},'accepted',${req.id})">قبول العرض</button><button class="btn red mini" onclick="decideOffer(${o.id},'rejected',${req.id})">رفض</button>`:''}</div></div>`).join('')}</div>`;
};


function v20CustomerStats(requests=[]){
  const active=requests.filter(r=>!['مكتمل','ملغي'].includes(r.status)).length;
  const done=requests.filter(r=>r.status==='مكتمل').length;
  return [{label:'طلبات نشطة',value:active,up:'مباشر',icon:'🛠️'},{label:'دردشات',value:state.chatCount||0,up:'غير مقروءة',icon:'💬'},{label:'مكتملة',value:done,up:'سجل',icon:'✅'},{label:'الخدمات',value:(state.meta.services||[]).length,up:'متاحة',icon:'📦'}];
}

reqTable=function(rows){
  if(!rows || !rows.length) return '<div class="empty">لا توجد طلبات</div>';
  return `<div class="request-list v21-request-list">${rows.map(r=>`<div class="request-card v21-request-card">
    <div class="request-head"><div><b>#${r.id} - ${v15EscapeHtml(r.service||'-')}</b><p class="muted">${v15EscapeHtml(r.city||'-')}${r.area?' - '+v15EscapeHtml(r.area):''} • ${v15EscapeHtml(r.preferred_time||'بدون وقت محدد')}</p></div><span class="status">${v15EscapeHtml(r.status||'-')}</span></div>
    ${r.problem_image_url?`<img class="problem-img" src="${_safeSrc(r.problem_image_url)}" alt="صورة المشكلة">`:''}
    <p>${v15EscapeHtml(r.description||'')}</p>
    <div class="request-meta"><span>الفني: ${v15EscapeHtml(r.technician_name||'-')}</span><span>العميل: ${v15EscapeHtml(r.customer_name||'-')}</span><span>السعر: ${r.offer_price? v15EscapeHtml(r.offer_price)+' د.أ':'-'}</span><span>المدة: ${v15EscapeHtml(r.arrival_time||'-')}</span></div>
    <div class="actions">${actions(r)}</div><div id="offers-${r.id}" class="offers-box"></div>
  </div>`).join('')}</div>`;
}

admin=async function(){
  state.user = (await api('/api/me')).user;
  const menu=[['dash','لوحة الإدارة'],['users','المستخدمين'],['orders','الطلبات'],['topups','شحن الفنيين'],['services','المهن والخدمات'],['packages','الباقات'],['support','الدعم'],['violations','محاولات الشات']];
  let c='';
  try{
    if(state.tab==='users'){
      const j=await api('/api/admin/users');
      c=dashboardHero('إدارة المستخدمين','كل حسابات العملاء والفنيين مع التفعيل والتعطيل',[{label:'المستخدمين',value:j.users.length,up:'إجمالي',icon:'👥'},{label:'الفنيين',value:j.users.filter(u=>u.role==='technician').length,up:'فني',icon:'👨‍🔧'},{label:'العملاء',value:j.users.filter(u=>u.role==='customer').length,up:'عميل',icon:'🙂'},{label:'نشط',value:j.users.filter(u=>u.is_active).length,up:'حساب',icon:'✅'}])+usersTable(j.users);
    }else if(state.tab==='orders'){
      const j=await api('/api/requests'); const s=v21StatusCounts(j.requests||[]);
      c=dashboardHero('إدارة الطلبات','افتح أي طلب، راجع العروض، الشات، الصورة، والحالة',[{label:'كل الطلبات',value:s.all,up:'إجمالي',icon:'🛒'},{label:'مفتوحة',value:s.open,up:'طلبات',icon:'⚡'},{label:'قيد التنفيذ',value:s.active,up:'طلبات',icon:'🔧'},{label:'مكتملة',value:s.done,up:'طلبات',icon:'✅'}])+`<div class="dash-card"><h2>كل الطلبات</h2>${reqTable(j.requests||[])}</div>`;
    }else if(state.tab==='topups'){
      const j=await api('/api/topups');
      c=dashboardHero('شحن الفنيين','راجع إثباتات الدفع وفعّل الرصيد',[{label:'طلبات الشحن',value:j.topups.length,up:'إجمالي',icon:'🚚'},{label:'بانتظار',value:j.topups.filter(t=>t.status==='pending').length,up:'مراجعة',icon:'⏳'},{label:'موافق عليها',value:j.topups.filter(t=>t.status==='approved').length,up:'عملية',icon:'✅'},{label:'مرفوضة',value:j.topups.filter(t=>t.status==='rejected').length,up:'عملية',icon:'❌'}])+topupTable(j.topups);
    }else if(state.tab==='services'){
      c=dashboardHero('المهن والخدمات','أي مهنة تضيفها تظهر مباشرة في الشريط المتحرك والطلبات',[{label:'الخدمات',value:state.meta.services.length,up:'متاحة',icon:'💼'},{label:'الشريط',value:'Live',up:'مباشر',icon:'⚡'},{label:'بحث',value:'فعال',up:'للعميل',icon:'🔎'},{label:'حالة',value:'جاهز',up:'نظام',icon:'✅'}])+`<div class="dash-grid two"><div class="dash-card v6-form">${servicesAdmin()}</div>${promoBox('إضافة خدمة جديدة','بعد الإضافة ستظهر في القوائم وشريط المهن المباشر تلقائياً')}</div>${categoriesBox()}`;
    }else if(state.tab==='packages'){
      c=dashboardHero('إدارة الباقات','أنشئ باقات شحن للفنيين وحدد العمولة',[{label:'الباقات',value:state.meta.packages.length,up:'متاحة',icon:'📦'},{label:'الدفع',value:'بنكي',up:'تحويل',icon:'🏦'},{label:'العمولة',value:'2 د.أ',up:'افتراضي',icon:'💳'},{label:'حالة',value:'فعال',up:'جاهز',icon:'✅'}])+packagesAdmin();
    }else if(state.tab==='support'){
      const j=await api('/api/support');
    
      c=dashboardHero(
        'الدعم الفني',
        'كل تذاكر الدعم من العملاء والفنيين',
        [
          {label:'التذاكر',value:j.tickets.length,up:'إجمالي',icon:'🎧'},
          {label:'مفتوحة',value:j.tickets.filter(t=>t.status==='open').length,up:'جديدة',icon:'📩'},
          {label:'مستخدمين',value:new Set(j.tickets.map(t=>t.user_id)).size,up:'تواصلوا',icon:'👥'},
          {label:'جاهز',value:'24/7',up:'دعم',icon:'✅'}
        ]
      )+`
      <div class="dash-card">
        <h2>تذاكر الدعم</h2>
        ${j.tickets.length?`
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>المستخدم</th>
                  <th>النوع</th>
                  <th>العنوان</th>
                  <th>التفاصيل</th>
                  <th>الحالة</th>
                  <th>التاريخ</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                ${j.tickets.map(t=>`
                  <tr>
                    <td>${t.id}</td>
                    <td>${v15EscapeHtml(t.user_name||'-')}<br><small>${v15EscapeHtml(t.email||'')}</small></td>
                    <td>${v15EscapeHtml(t.type||'-')}</td>
                    <td>${v15EscapeHtml(t.title||'-')}</td>
                    <td>${v15EscapeHtml(t.body||'-')}</td>
                    <td>${t.status==='closed'?'مغلقة':'مفتوحة'}</td>
                    <td>${v15EscapeHtml(t.created_at||'')}</td>
                    <td>
                      <button class="btn mini" onclick="supportChat(${t.id})">فتح محادثة</button>
                      ${t.status==='open'
                        ? `<button class="btn red mini" onclick="closeSupportTicket(${t.id})">إنهاء</button>`
                        : ''
                      }
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `:'<div class="empty">لا توجد تذاكر</div>'}
      </div>`;
    }else if(state.tab==='violations'){
      const j=await api('/api/chat-violations');
      c=dashboardHero('محاولات التواصل الخارجي','أي رقم أو واتساب أو إيميل يتم تسجيله هنا',[{label:'المحاولات',value:j.violations.length,up:'آخر 200',icon:'🛡️'},{label:'الشات',value:'محمي',up:'فعال',icon:'💬'},{label:'العمولة',value:'محفوظة',up:'منصة',icon:'💰'},{label:'الأمان',value:'Live',up:'مباشر',icon:'⚡'}])+`<div class="dash-card"><h2>السجل</h2>${j.violations.length?`<div class="table-wrap"><table><thead><tr><th>#</th><th>المستخدم</th><th>الطلب</th><th>السبب</th><th>المحتوى</th><th>الوقت</th></tr></thead><tbody>${j.violations.map(v=>`<tr><td>${v.id}</td><td>${v15EscapeHtml(v.user_name||'-')}<br><small>${v15EscapeHtml(v.user_email||'')}</small></td><td>#${v.request_id}<br><small>${v15EscapeHtml(v.service||'')}</small></td><td>${v15EscapeHtml(v.reason||'')}</td><td>${v15EscapeHtml(v.body||'')}</td><td>${v15EscapeHtml(v.created_at||'')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">لا توجد محاولات ممنوعة</div>'}</div>`;
    }else{
      const j=await api('/api/admin/stats'); const s=j.stats;
      c=dashboardHero('مرحباً بك في لوحة الإدارة','تحكم كامل في المنصة من مكان واحد',[{label:'العملاء',value:s.customers||0,up:'حساب',icon:'🙂'},{label:'الفنيين',value:s.technicians||0,up:'حساب',icon:'👨‍🔧'},{label:'الطلبات',value:s.requests||0,up:'إجمالي',icon:'🛒'},{label:'مكتملة',value:s.completed||0,up:'طلب',icon:'✅'}])+`<div class="dash-grid"><div>${activityBox()}</div><div class="dash-card v6-form">${servicesAdmin()}</div>${promoBox('لوحة إدارة جاهزة','المستخدمين، الطلبات، الشحن، الخدمات، الدعم، ومحاولات التواصل الخارجي')}</div>${categoriesBox()}${chartsBox()}`;
    }
  }catch(err){ c=`<div class="dash-card"><h2>حدث خطأ</h2><p class="muted">${v15EscapeHtml(err.message||'تعذر تحميل الصفحة')}</p><button class="btn" onclick="state.tab='dash';dashboard()">رجوع للوحة</button></div>`; }
  layout('لوحة الإدارة',menu,c);
}
window.supportChat = async function(id){
  const j = await api(`/api/support/${id}/messages`);

  app.innerHTML = `
    <div class="page">
      <button class="btn ghost" onclick="state.tab='support';dashboard()">رجوع للدعم</button>
      <div class="dash-card" style="margin-top:16px">
        <h2>محادثة الدعم #${id}</h2>
        <p class="muted">${v15EscapeHtml(j.ticket.title||'')}</p>

        <div id="supportMessages" class="chat-box" style="min-height:280px;max-height:420px;overflow:auto;margin:16px 0">
          ${(j.messages||[]).map(m=>`
            <div class="msg ${m.sender_role==='admin'?'me':''}">
              <b>${v15EscapeHtml(m.sender_name||'-')}</b>
              <p>${v15EscapeHtml(m.body||'')}</p>
              <small>${v15EscapeHtml(m.created_at||'')}</small>
            </div>
          `).join('') || '<div class="empty">لا توجد رسائل بعد</div>'}
        </div>

        ${j.ticket.status==='open'?`
          <div class="form">
            <textarea id="supportMsgBody" placeholder="اكتب ردك هنا..." style="min-height:90px"></textarea>
            <button class="btn" onclick="sendSupportMessage(${id})">إرسال</button>
            <button class="btn red" onclick="closeSupportTicket(${id})">إنهاء الدردشة</button>
          </div>
        `:'<div class="empty">هذه الدردشة منتهية</div>'}
      </div>
    </div>
  `;
}

window.sendSupportMessage = async function(id){
  const body = document.getElementById('supportMsgBody')?.value?.trim();
  if(!body) return toast('اكتب رسالة');

  await api(`/api/support/${id}/messages`, {
    method:'POST',
    body:JSON.stringify({body})
  });

  toast('تم إرسال الرسالة');
  supportChat(id);
}

window.closeSupportTicket = async function(id){
  if(!confirm('إنهاء هذه الدردشة؟')) return;

  await api(`/api/support/${id}/status`, {
    method:'POST',
    body:JSON.stringify({status:'closed'})
  });

  toast('تم إنهاء الدردشة');
  state.tab='support';
  dashboard();
}
logout=async function(){
  try{ await api('/api/auth/logout',{method:'POST'}); }catch(e){}
  localStorage.removeItem('pendingService'); delete localStorage.token; state.user=null; state.tab='dash'; activeChatId=null;
  if(chatTimer){ clearInterval(chatTimer); chatTimer=null; }
  toast('تم تسجيل الخروج');
  login();
};


function v22Money(n){ return (Number(n||0)).toFixed(2).replace('.00','')+' د.أ'; }
function v22UnreadBadge(n){ n=Number(n||0); return n>0?`<span class="badge-dot">${n}</span>`:''; }
function v22TechMetrics(me, requests=[]){
  const open=requests.filter(r=>['بانتظار العروض','وصلت عروض'].includes(r.status)).length;
  const active=requests.filter(r=>r.technician_id===me.id && !['مكتمل','ملغي'].includes(r.status)).length;
  return [
    {label:'طلبات متاحة',value:open,up:'Live',icon:'🛠️'},
    {label:'دردشات',value:state.chatCount||0,up:'غير مقروءة',icon:'💬'},
    {label:'الرصيد',value:v22Money(me.balance),up:'متاح',icon:'💳'},
    {label:'طلب نشط',value:active,up:'قيد العمل',icon:'⚡'}
  ];
}
function v22Safe(v){ return (typeof v15EscapeHtml==='function'?v15EscapeHtml(String(v??'')):String(v??'')); }
async function v22Counters(){ try{ return await v17LoadCounters(); }catch(e){ return {requests:[],chats:[]}; } }
function v22TechWelcome(me, requests){
  return dashboardHero('لوحة الفني','كل شيء يعمل من هنا: الطلبات، الدردشات، الشحن، الرصيد والسجل.',v22TechMetrics(me,requests))+
  v20LiveServicesStrip()+
  `<div class="v22-grid">
    <div class="dash-card v22-action" onclick="state.tab='orders';dashboard()"><span>🛠️</span><h3>الطلبات المتاحة</h3><p>شاهد الطلبات المناسبة لمهنتك ومناطقك وقدم عرض سعر ومدة.</p></div>
    <div class="dash-card v22-action" onclick="state.tab='chats';dashboard()"><span>💬</span><h3>الدردشات ${v22UnreadBadge(state.chatCount)}</h3><p>كل محادثاتك مع العملاء تظهر هنا مع عداد الرسائل الجديدة.</p></div>
    <div class="dash-card v22-action" onclick="state.tab='balance';dashboard()"><span>💳</span><h3>الرصيد والباقات</h3><p>اشحن رصيدك واختر باقة مناسبة لتفعيل استقبال الطلبات.</p></div>
    <div class="dash-card v22-action" onclick="state.tab='ledger';dashboard()"><span>📘</span><h3>سجل الرصيد</h3><p>تابع خصم العمولة وعمليات الشحن بشكل واضح.</p></div>
  </div><div class="dash-card"><h2>آخر الطلبات المناسبة</h2>${reqTable((requests||[]).slice(0,6))}</div>`;
}
function v22TechOrders(me, requests){
  const split=typeof v18SplitRequests==='function'?v18SplitRequests(requests):{active:requests,done:[]};
  const filter=state.orderFilter||'active';
  const selected=filter==='done'?split.done:split.active;
  return dashboardHero('طلبات الفني','طلبات العملاء تظهر هنا مباشرة. أرسل عرض السعر والمدة وانتظر موافقة العميل.',v22TechMetrics(me,requests))+
    v20LiveServicesStrip()+
    `<div class="dash-card"><div class="v22-head"><div><h2>الطلبات المتاحة والحالية</h2><p class="muted">إذا قبل العميل عرضك يفتح الشات ويتحول الطلب لقيد التنفيذ.</p></div><button class="btn ghost" onclick="dashboard()">تحديث الآن</button></div>
    <div class="v18-tabs"><button class="btn ${filter==='active'?'':'ghost'}" onclick="state.orderFilter='active';dashboard()">نشطة ${v22UnreadBadge(split.active.length)}</button><button class="btn ${filter==='done'?'':'ghost'}" onclick="state.orderFilter='done';dashboard()">مكتملة/ملغية ${v22UnreadBadge(split.done.length)}</button></div>${reqTable(selected)}</div>`;
}
async function v22TechTopups(me){
  const j=await api('/api/topups');
  return dashboardHero('طلبات الشحن','تابع حالة طلبات الشحن وإثباتات الدفع التي رفعتها للإدارة.',[
    {label:'طلبات الشحن',value:j.topups.length,up:'إجمالي',icon:'🚚'},
    {label:'بانتظار',value:j.topups.filter(t=>t.status==='pending').length,up:'مراجعة',icon:'⏳'},
    {label:'الرصيد',value:v22Money(me.balance),up:'حالي',icon:'💳'},
    {label:'الباقات',value:state.meta.packages.length,up:'متاحة',icon:'📦'}
  ])+`<div class="dash-card"><div class="v22-head"><h2>طلبات الشحن</h2><button class="btn" onclick="state.tab='balance';dashboard()">شحن جديد</button></div>${topupTable(j.topups)}</div>`;
}
async function v22TechLedger(me){
  const j=await api('/api/ledger');
  return dashboardHero('سجل الرصيد','كل عمليات الشحن والخصم والعمولة محفوظة هنا.',[
    {label:'عمليات',value:j.ledger.length,up:'مسجلة',icon:'📘'},
    {label:'الرصيد',value:v22Money(me.balance),up:'حالي',icon:'💳'},
    {label:'أعمال مكتملة',value:me.completed_jobs||0,up:'طلب',icon:'✅'},
    {label:'تقييم',value:stars(me.rating_avg),up:'فني',icon:'⭐'}
  ])+`<div class="dash-card"><h2>السجل المالي</h2>${ledgerTable(j.ledger)}</div>`;
}
function v22TechBalance(me){
  return dashboardHero('الرصيد والباقات','اشحن الرصيد من خلال باقة، ثم ارفع إثبات الدفع للإدارة.',[
    {label:'رصيدك',value:v22Money(me.balance),up:'متاح',icon:'💳'},
    {label:'طلبات مجانية',value:(me.free_quota_used ?? (me.free_orders_used||0))+'/2',up:'مستخدمة',icon:'🎁'},
    {label:'الباقات',value:state.meta.packages.length,up:'متاحة',icon:'📦'},
    {label:'حالة الحساب',value:'فعال',up:'جاهز',icon:'✅'}
  ])+balancePage(me);
}

requestForm=function(){
  return `<div class="card bluehint offer-request v22-request-form"><h2>طلب خدمة جديد</h2><p class="muted">حدد الخدمة والمنطقة، أضف وصف المشكلة، والصورة اختيارية لكنها تساعد الفني يعطيك سعر أدق.</p>
  <form class="form two" onsubmit="createReq(event)">
    <div class="field"><label>الخدمة</label><select id="qservice">${state.meta.services.map(s=>`<option>${v22Safe(s.name)}</option>`).join('')}</select></div>
    <div class="field"><label>المحافظة</label><select id="qcity">${typeof governorateOptions==='function'?governorateOptions(state.user?.city||'عمان'):state.meta.cities.map(c=>`<option>${v22Safe(c)}</option>`).join('')}</select></div>
    <div class="field"><label>منطقة السكن</label><select id="qarea"></select></div>
    <div class="field"><label>الوقت المطلوب</label><input id="qtime" placeholder="مثال: اليوم مساءً"></div>
    <div class="field" style="grid-column:1/-1"><label>وصف المشكلة</label><textarea id="qdesc" required minlength="10" placeholder="مثال: المكيف لا يبرد وأحتاج فني اليوم"></textarea></div>
    <div class="field" style="grid-column:1/-1"><label>📷 صورة المشكلة <span class="muted">اختياري</span></label><label class="v22-upload"><input id="problemImage" type="file" accept="image/png,image/jpeg,image/webp" onchange="previewProblemImage()"><span>اضغط لاختيار صورة أو اسحبها هنا</span><small>JPG / PNG / WEBP حتى 3MB</small></label><div id="problemPreview"></div></div>
    <div class="field" style="grid-column:1/-1"><button type="button" class="btn ghost" onclick="useGPS('request')">📍 تحديد موقعي الحالي</button><small class="muted">الموقع يساعد الفنيين على معرفة قربك قبل تقديم العرض.</small><div id="requestMap">${typeof mapBox==='function'?mapBox(state.gps?.lat,state.gps?.lng):''}</div></div>
    <button class="btn big" type="submit">🚀 نشر الطلب واستقبال العروض</button>
  </form></div>`;
};
createReq=async function(e){
  e.preventDefault();
  try{
    const fd=new FormData();
    fd.append('service',document.getElementById('qservice').value);
    fd.append('city',document.getElementById('qcity').value);
    fd.append('area',document.getElementById('qarea')?.value||'');
    fd.append('preferred_time',document.getElementById('qtime').value||'');
    fd.append('description',document.getElementById('qdesc').value.trim());
    fd.append('lat',state.gps?.lat||''); fd.append('lng',state.gps?.lng||'');
    const img=document.getElementById('problemImage')?.files?.[0];
    if(img) fd.append('problem_image',img);
    await api('/api/requests',{method:'POST',body:fd});
    toast('تم نشر الطلب بنجاح، وسيظهر للفنيين مباشرة');
    state.tab='orders'; state.orderFilter='active'; dashboard();
  }catch(err){ toast(err.message); }
};
previewProblemImage=function(){
  const file=document.getElementById('problemImage')?.files?.[0], box=document.getElementById('problemPreview');
  if(!box) return; if(!file){ box.innerHTML=''; return; }
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)){ box.innerHTML=''; toast('نوع الصورة غير مسموح'); return; }
  if(file.size>3*1024*1024){ box.innerHTML=''; toast('حجم الصورة كبير، الحد الأقصى 3MB'); return; }
  box.innerHTML=`<img class="problem-preview v22-preview" src="${URL.createObjectURL(file)}" alt="معاينة صورة المشكلة"><button type="button" class="btn ghost mini" onclick="document.getElementById('problemImage').value='';document.getElementById('problemPreview').innerHTML=''">إزالة الصورة</button>`;
};

;(function(){
  const V24 = {};
  window.v24Safe = function(v){
    try { return (typeof v15EscapeHtml==='function') ? v15EscapeHtml(String(v ?? '')) : String(v ?? '').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
    catch(e){ return String(v ?? ''); }
  };
  window.v24Badge = function(n){ n=Number(n||0); return n>0?`<span class="badge-dot v24-badge">${n>99?'99+':n}</span>`:''; };
  window.v24Money = function(n){ return (Number(n||0)).toFixed(2).replace('.00','')+' د.أ'; };
  window.v24BackToDashboard = function(){ activeChatId=null; if(chatTimer){clearInterval(chatTimer); chatTimer=null;} dashboard(); };

  // More accurate chat guard: blocks outside-contact only, allows normal messages.
  window.v24ChatBlockReason = function(text){
    const raw=String(text||'');
    if(/^\[location\]-?\d{1,2}\.\d+,-?\d{1,3}\.\d+$/.test(raw)) return '';
    if(/^\[audio\]/.test(raw)) return '';
    const ar='٠١٢٣٤٥٦٧٨٩', fa='۰۱۲۳۴۵۶۷۸۹';
    const lower=raw.toLowerCase()
      .replace(/[٠-٩]/g,ch=>String(ar.indexOf(ch)))
      .replace(/[۰-۹]/g,ch=>String(fa.indexOf(ch)))
      .replace(/[oO]/g,'0');
    const compact=lower.replace(/[^0-9a-z\u0600-\u06FF+@.]/g,'');
    const links=['wa.me','whatsapp','watsapp','واتساب','واتس','وتساب','telegram','t.me','تلجرام','تليجرام','تيليجرام','facebook','fb.com','messenger','instagram','insta','snapchat','discord','discord.gg'];
    for(const w of links){ if(lower.includes(w) || compact.includes(String(w).toLowerCase().replace(/[^0-9a-z\u0600-\u06FF+@.]/g,''))) return 'وسيلة تواصل خارجية'; }
    if(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(raw)) return 'بريد إلكتروني';
    const digits=lower.replace(/[^0-9+]/g,'');
    const plain=lower.replace(/[^0-9]/g,'');
    if(/(\+?962|00962)?0?7[789]\d{7}/.test(digits)) return 'رقم هاتف';
    if(/^(9627|009627|07|7)[789]?\d{7,8}$/.test(plain) && plain.length>=9) return 'رقم هاتف';
    if(plain.length>=10 && /(07|9627|009627)/.test(plain)) return 'رقم هاتف';
    return '';
  };

  window.v24Toast = function(msg){ try{ toast(msg); }catch(e){ alert(msg); } };

  // Replace chat UI with guaranteed working open/read/send behavior for customer + technician.
  window.chat = async function(id){
    try{
      activeChatId = Number(id);
      if(chatTimer){ clearInterval(chatTimer); chatTimer=null; }
      setupSocket?.();
      if(socket){ socket.emit('join-request', activeChatId); }
      const j = await api(`/api/requests/${activeChatId}/messages`);
      app.innerHTML = `<div class="page chat-page v24-chat-page">
        <button class="btn ghost" onclick="if(socket&&activeChatId)socket.emit('leave-request',activeChatId);v24BackToDashboard()">← رجوع</button>
        <div class="card chat-card v24-chat-card">
          <div class="v24-chat-head"><div><h2>المحادثة للطلب #${activeChatId}</h2><p class="muted">التواصل داخل صلّحلي فقط لحماية حق العميل والفني والمنصة.</p></div><span class="v24-live-pill"><i></i> Live</span></div>
          <div class="chat-protection-note">🛡️ مسموح بالرسائل العادية. ممنوع فقط إرسال أرقام الهاتف، الإيميلات، واتساب، تيليجرام وروابط التواصل الخارجي.</div>
          <div class="chat v24-chat-box" id="chatbox"></div>
          <form class="chat-input-row v24-chat-form" onsubmit="sendMsg(event,${activeChatId})">
            <input id="msg" autocomplete="off" placeholder="اكتب رسالة عادية داخل صلّحلي...">
            <button class="btn send-text-btn" type="submit">إرسال</button>
          </form>
          <div class="chat-icon-tools v24-tools">
            <button type="button" class="round-action location-action" onclick="sendLocation(${activeChatId})" title="إرسال الموقع">📍</button>
            <button type="button" id="micBtn" class="round-action mic-action" onclick="toggleRec(${activeChatId})" title="تسجيل صوت">🎙️</button>
            <button type="button" id="sendVoiceBtn" class="round-action send-voice-action hide" onclick="stopRec(${activeChatId})" title="إرسال الصوت">➤</button>
            <span id="recordingLabel" class="recording-label hide">● جاري التسجيل...</span>
          </div>
        </div>
      </div>`;
      renderMessages(j.messages||[]);
      await v24RefreshBadges();
      chatTimer=setInterval(async()=>{ if(activeChatId) await refreshChat(); },2500);
    }catch(err){
      v24Toast('تعذر فتح المحادثة: '+(err.message||err));
      dashboard();
    }
  };

  window.sendMsg = async function(e,id){
    e.preventDefault();
    const input=document.getElementById('msg');
    const text=(input?.value||'').trim();
    if(!text) return;
    const reason=v24ChatBlockReason(text);
    if(reason){
      input.classList.add('blocked-input'); setTimeout(()=>input.classList.remove('blocked-input'),900);
      return v24Toast('⚠️ ممنوع إرسال '+reason+' داخل الشات. اكتب رسالتك داخل صلّحلي بدون وسائل تواصل خارجية.');
    }
    try{
      input.value='';
      const j=await api(`/api/requests/${id}/messages`,{method:'POST',body:JSON.stringify({body:text})});
      renderMessages(j.messages||[]);
      try{v10Sound?.('message')}catch(_){ }
      await v24RefreshBadges();
    }catch(err){ v24Toast(err.message||'تعذر إرسال الرسالة'); input.value=text; }
  };

  // If message body is plain, escape it. Only internal [audio]/[location] render specially.
  window.messageBody = function(body){
    body=String(body||'');
    if(body.startsWith('[audio]')){let u=body.replace('[audio]','');return `<audio controls src="${v24Safe(u)}"></audio>`;}
    if(body.startsWith('[location]')){let p=body.replace('[location]','').split(',');let lat=p[0],lng=p[1];return `📍 <a target="_blank" href="https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lng)}">فتح الموقع على الخريطة</a><div>${mapBox(lat,lng)}</div>`;}
    return v24Safe(body).replace(/(https?:\/\/\S+)/g,'<span class="muted">[رابط خارجي محجوب]</span>');
  };

  window.renderMessages = function(messages){
    const box=document.getElementById('chatbox'); if(!box) return;
    box.innerHTML=(messages||[]).map(m=>`<div class="msg ${Number(m.sender_id)===Number(state.user?.id)?'me':''}"><b>${v24Safe(m.sender_name||'مستخدم')}</b><br>${messageBody(m.body)}<br><small>${v24Safe(m.created_at||'')}</small></div>`).join('') || '<div class="empty">لا توجد رسائل بعد. ابدأ المحادثة من داخل صلّحلي.</div>';
    box.scrollTop=box.scrollHeight;
  };

  window.v24RefreshBadges = async function(){
    if(!state.user) return;
    try{
      const c=await api('/api/chats'); state.chatCount=Number(c.total_unread||0);
      syncChatBell();
renderBellBadge();
setTimeout(renderBellBadge,200);
      const r=await api('/api/requests').catch(()=>({requests:[]}));
      const reqs=r.requests||[];
      state.orderCount = state.user.role==='technician' ? reqs.filter(x=>['بانتظار العروض','وصلت عروض'].includes(x.status)).length : reqs.filter(x=>!['مكتمل','ملغي'].includes(x.status)).length;
      document.querySelectorAll('[data-badge="chats"]').forEach(el=>el.innerHTML=v24Badge(state.chatCount));
      document.querySelectorAll('[data-badge="orders"]').forEach(el=>el.innerHTML=v24Badge(state.orderCount));
      const totalAlerts = Number(state.chatCount||0) + Number(state.orderCount||0);
      state.unread = Math.max(
        Number(state.unread || 0),
        Number(state.chatCount || 0)
      );
      
      renderBellBadge();
      setTimeout(renderBellBadge,100);
      setTimeout(renderBellBadge,300);
        }catch(_){ }
  };

  window.v24MenuIcon = function(k){ return ({dash:'🏠',near:'📍',orders:'🛒',chats:'💬',balance:'💳',topups:'🚚',ledger:'📘',settings:'⚙️',support:'🎧'}[k]||'•'); };

  // Strong layout: tabs always clickable, mobile friendly, no hidden admin info.
  window.layout = function(title,menu,content){
    const user=state.user||{};
    const allSystem=[['settings','الإعدادات'],['support','الدعم الفني']];
    const sidebarBtn=(m)=>`<button type="button" class="sidebtn ${state.tab===m[0]?'active':''}" onclick="state.tab='${m[0]}';dashboard();setTimeout(v35ScrollToContent,80)"><b>${m[1]} <span data-badge="${m[0]==='chats'?'chats':m[0]==='orders'?'orders':''}">${m[0]==='chats'?v24Badge(state.chatCount):m[0]==='orders'?v24Badge(state.orderCount):''}</span></b><span class="mi">${v24MenuIcon(m[0])}</span></button>`;
    app.innerHTML=`<div class="admin-shell v24-shell"><aside class="admin-sidebar v24-sidebar"><div class="admin-logo"><img src="/logo.png" alt="صلّحلي" class="logo-img">صلّحلي</div><button class="mobile-menu-close" onclick="document.body.classList.remove('sidebar-open')">×</button><div class="admin-section-label">الرئيسية</div><div class="admin-menu">${menu.map(sidebarBtn).join('')}</div><div class="admin-section-label">النظام</div><div class="admin-menu">${allSystem.map(sidebarBtn).join('')}<button type="button" class="sidebtn logout-side v15-logout-side" onclick="v15LogoutConfirm?.()||logout()"><b>تسجيل خروج</b><span class="mi">🚪</span></button></div><div class="admin-profile"><div class="avatar-sm">${v24Safe((user.name||'ص').slice(0,1))}</div><div><b>${v24Safe(user.name||roleName?.()||'مستخدم')}</b><small>${v24Safe(user.email||'')}</small></div></div></aside><main class="admin-main v24-main"><div class="admin-top"><button class="admin-icon-btn mobile-menu-open" onclick="document.body.classList.add('sidebar-open')">☰</button><div class="admin-search">🔎 <input placeholder="بحث عن فني أو خدمة أو طلب..." onkeydown="if(event.key==='Enter'){state.tab=state.user.role==='customer'?'near':'orders';dashboard();setTimeout(()=>{let q=document.getElementById('searchTechQ'); if(q){q.value=this.value; searchTechnicians?.();}},120)}"></div><div class="admin-actions"><button class="admin-icon-btn bell-btn" onclick="v24RefreshBadges()">🔔 ${v24Badge(state.chatCount)}</button><button class="admin-icon-btn" onclick="v10ToggleTheme?.()">🌙</button><button class="admin-icon-btn clean-logout v15-top-logout" onclick="v15LogoutConfirm?.()||logout()">🚪 تسجيل خروج</button></div></div>${typeof v20LiveServicesStrip==='function'?v20LiveServicesStrip():''}<div class="v24-content">${content}</div></main></div>`;
    v10ApplyTheme?.(); v24RefreshBadges();
  };

  window.v24Metrics = function(me, reqs){
    reqs=reqs||[]; const open=reqs.filter(r=>['بانتظار العروض','وصلت عروض'].includes(r.status)).length; const active=reqs.filter(r=>Number(r.technician_id)===Number(me.id)&&!['مكتمل','ملغي'].includes(r.status)).length;
    return [{label:'طلبات متاحة',value:open,up:'Live',icon:'🛠️'},{label:'دردشات',value:state.chatCount||0,up:'غير مقروءة',icon:'💬'},{label:'الرصيد',value:v24Money(me.balance),up:'متاح',icon:'💳'},{label:'طلب نشط',value:active,up:'قيد العمل',icon:'⚡'}];
  };

  window.techDash = async function(){
    try{
      await v24RefreshBadges();
      const me=(await api('/api/me')).user; state.user=me;
      const menu=[['dash','الرئيسية'],['orders','الطلبات'],['chats','الدردشات'],['balance','الرصيد والباقات'],['topups','طلبات الشحن'],['ledger','سجل الرصيد']];
      let content='';
      if(state.tab==='orders'){
        const j=await api('/api/requests');
        content=dashboardHero('طلبات الفني','الطلبات المناسبة تظهر مباشرة. قدم عرض سعر ومدة، وبعد موافقة العميل تفتح المحادثة.',v24Metrics(me,j.requests||[]))+`<div class="dash-card"><div class="v24-head"><h2>الطلبات المتاحة والحالية</h2><button class="btn ghost" onclick="dashboard()">تحديث الآن</button></div>${reqTable(j.requests||[])}</div>`;
      }else if(state.tab==='chats'){
        content=dashboardHero('الدردشات','كل محادثاتك مع العملاء هنا، والعداد الأحمر يختفي بعد قراءة المحادثة.',v24Metrics(me,[]))+await chatsPage();
      }else if(state.tab==='balance'){
        content=(typeof v22TechBalance==='function')?v22TechBalance(me):balancePage(me);
      }else if(state.tab==='topups'){
        const j=await api('/api/topups'); content=dashboardHero('طلبات الشحن','تابع طلبات شحن الرصيد.',v24Metrics(me,[]))+topupTable(j.topups||[]);
      }else if(state.tab==='ledger'){
        const j=await api('/api/ledger'); content=dashboardHero('سجل الرصيد','كل عمليات الرصيد والعمولة محفوظة.',v24Metrics(me,[]))+ledgerTable(j.ledger||[]);
      }else if(state.tab==='settings'){
        content=dashboardHero('الإعدادات','تعديل الاسم، الهاتف، المنطقة، وكلمة السر.',v24Metrics(me,[]))+settingsPage();
      }else if(state.tab==='support'){
        content=dashboardHero('الدعم الفني','تواصل مع إدارة صلحلي من داخل المنصة.',v24Metrics(me,[]))+supportPage();
      }else{
        const j=await api('/api/requests');
        content=dashboardHero('لوحة الفني','إدارة احترافية للطلبات، العروض، الدردشات، الشحن والرصيد.',v24Metrics(me,j.requests||[]))+`<div class="v22-grid v24-grid"><div class="dash-card v22-action" onclick="state.tab='orders';dashboard()"><span>🛠️</span><h3>الطلبات</h3><p>شاهد الطلبات المناسبة وقدم عروض سعر.</p></div><div class="dash-card v22-action" onclick="state.tab='chats';dashboard()"><span>💬</span><h3>الدردشات ${v24Badge(state.chatCount)}</h3><p>افتح محادثات العملاء مباشرة.</p></div><div class="dash-card v22-action" onclick="state.tab='balance';dashboard()"><span>💳</span><h3>الرصيد</h3><p>اشحن الرصيد واختر الباقات.</p></div><div class="dash-card v22-action" onclick="state.tab='ledger';dashboard()"><span>📘</span><h3>السجل</h3><p>تابع الخصومات والعمولات.</p></div></div><div class="dash-card"><h2>آخر الطلبات</h2>${reqTable((j.requests||[]).slice(0,5))}</div>`;
      }
      layout('لوحة الفني',menu,content);
      if(state.tab==='settings') bindAreaSelect?.('setCity','setArea');
    }catch(err){
      app.innerHTML=`<div class="page"><div class="card"><h2>حدث خطأ في لوحة الفني</h2><p>${v24Safe(err.message||err)}</p><button class="btn" onclick="dashboard()">إعادة المحاولة</button></div></div>`;
    }
  };

  // Customer dashboard with clear upload image and nicer mobile layout.
  window.custDash = async function(){
    await v24RefreshBadges();
    const menu=[['dash','طلب جديد'],['near','البحث عن فني'],['orders','طلباتي'],['chats','الدردشات']];
    let content='';
    if(state.tab==='orders'){
      const j=await api('/api/requests'); content=dashboardHero('طلباتي','تابع الطلبات والعروض والدردشات بشكل مباشر',v20CustomerStats?.(j.requests||[])||[])+`<div class="dash-card"><h2>طلباتي</h2>${typeof v18OrdersView==='function'?v18OrdersView(j.requests||[]):reqTable(j.requests||[])}</div>`;
    }else if(state.tab==='chats'){
      content=dashboardHero('الدردشات','كل محادثاتك مع الفنيين هنا.',v20CustomerStats?.([])||[])+await chatsPage();
    }else if(state.tab==='near'){
      content=dashboardHero('البحث عن فني','ابحث حسب الخدمة والمنطقة وشاهد التقييم والملف قبل الطلب',v20CustomerStats?.([])||[])+v20SearchPanel();
    }else if(state.tab==='settings'){
      content=dashboardHero('الإعدادات','تغيير الاسم، المنطقة، الهاتف، وكلمة السر',v20CustomerStats?.([])||[])+settingsPage();
    }else if(state.tab==='support'){
      content=dashboardHero('الدعم الفني','أرسل مشكلة أو اقتراح لإدارة صلحلي.',v20CustomerStats?.([])||[])+supportPage();
    }else{
      const j=await api('/api/requests').catch(()=>({requests:[]}));
      content=dashboardHero('لوحة العميل','انشر طلبك بصورة اختيارية واستقبل عروض الفنيين مباشرة',v20CustomerStats?.(j.requests||[])||[])+`<div class="v20-main-grid v24-customer-grid"><div>${requestForm()}</div><div>${v20SearchPanel()}</div></div>`;
    }
    layout('لوحة العميل',menu,content);
    if(['dash','near'].includes(state.tab)){ bindAreaSelect?.('qcity','qarea','qareaOtherWrap'); bindAreaSelect?.('searchCity','searchArea'); }
    if(state.tab==='near') setTimeout(()=>searchTechnicians?.(),100);
    if(state.tab==='settings') bindAreaSelect?.('setCity','setArea');
  };

  // Bind socket live updates once.
  window.v24BindRealtime = function(){
    setupSocket?.(); if(!socket || socket.__v24Bound) return; socket.__v24Bound=true;
    socket.on('messages-updated', async data=>{
      if(activeChatId && Number(data.requestId)===Number(activeChatId)){
        renderMessages(data.messages || []);
      }
    
      if(state.user){
        v10Sound('notify');
    
        state.chatCount = Number(state.chatCount || 0) + 1;
    
        syncChatBell();
        renderBellBadge();
    
        toast('وصلتك رسالة جديدة');
      }
    });
    socket.on('chat-badges-updated', async ()=>{
      state.chatCount = Number(state.chatCount || 0) + 1;
    
      syncChatBell();
      renderBellBadge();
    });
    
    socket.on('requests-updated', ()=>{
      v10Sound('notify');
      if(state.user && !activeChatId && ['orders','dash'].includes(state.tab)) dashboard();
    });
    
    socket.on('new-request-created', ()=>{
      v10Sound('notify');
      v24RefreshBadges();
    
      if(state.user?.role === 'technician'){
        addBellNotification('request','طلب جديد','وصل طلب جديد من عميل','orders');
        toast('وصل طلب جديد');
        if(!activeChatId && ['orders','dash'].includes(state.tab)) dashboard();
      }
    });
    
    socket.on('offer-created', ()=>{
      v10Sound('notify');
      v24RefreshBadges();
    
      if(state.user?.role === 'customer'){
        addBellNotification('offer','عرض جديد','وصل عرض جديد على أحد طلباتك','orders');
        toast('وصل عرض جديد');
        if(!activeChatId && ['orders','dash'].includes(state.tab)) dashboard();
      }
    });

    socket.on('request-status-updated', ()=>{
      v10Sound('notify');
      v24RefreshBadges();
      if(state.user && !activeChatId && ['orders','dash','chats'].includes(state.tab)) dashboard();
    });
  };
  const oldDashboard=window.dashboard;
  window.dashboard=function(){ v24BindRealtime(); return oldDashboard(); };
  const oldInit=window.init;
  window.init=async function(){ await oldInit(); v24BindRealtime(); setInterval(()=>{ if(state.user && !activeChatId) v24RefreshBadges(); },3000); };

  const css=`
  .mobile-menu-open,.mobile-menu-close{display:none}.v24-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.v24-chat-card{max-width:980px;margin:auto}.v24-chat-head{display:flex;justify-content:space-between;align-items:center;gap:14px}.v24-live-pill{display:inline-flex;gap:8px;align-items:center;background:#eef8ff;border:1px solid #bdd9ff;color:#1d47d8;padding:8px 12px;border-radius:999px;font-weight:900}.v24-live-pill i{width:9px;height:9px;background:#16c784;border-radius:50%;box-shadow:0 0 0 5px rgba(22,199,132,.12)}.v24-chat-box{height:430px}.blocked-input{animation:v24Shake .35s;border-color:#f43f5e!important}@keyframes v24Shake{0%,100%{transform:translateX(0)}25%{transform:translateX(6px)}75%{transform:translateX(-6px)}}.v24-badge{vertical-align:middle}.v24-content{min-width:0}.v24-grid .dash-card{cursor:pointer}.chat-protection-note{margin:12px 0;padding:12px;border-radius:16px;background:#eef6ff;border:1px solid #cfe0ff;color:#1640a6;font-weight:800}.chat-input-row input{min-height:54px}.chat-input-row button{min-height:54px}.v24-sidebar .sidebtn{cursor:pointer}.v24-sidebar .sidebtn:hover{transform:translateX(-2px)}.problem-img,.problem-preview{max-width:320px;width:100%;border-radius:18px;object-fit:cover;border:1px solid #d9e5f8}.v22-upload{transition:.2s}.v22-upload:hover{transform:translateY(-2px);box-shadow:0 18px 44px rgba(47,104,255,.14)}
  @media(max-width:900px){body{overflow-x:hidden}.v24-shell{display:block!important}.v24-sidebar{position:fixed!important;top:0;right:0;bottom:0;width:min(86vw,340px)!important;z-index:999;transform:translateX(110%);transition:.25s;border-radius:0!important;overflow:auto}.sidebar-open .v24-sidebar{transform:translateX(0)}.sidebar-open:before{content:'';position:fixed;inset:0;background:rgba(3,10,31,.42);z-index:998}.mobile-menu-close{display:grid;position:absolute;left:16px;top:14px;width:38px;height:38px;border:0;border-radius:12px;background:rgba(255,255,255,.12);color:#fff;font-size:26px}.mobile-menu-open{display:grid!important}.v24-main{padding:12px!important}.admin-top{grid-template-columns:auto 1fr!important;gap:10px!important}.admin-search{grid-column:1/-1;order:2}.admin-actions{grid-column:1/-1;order:3;display:grid!important;grid-template-columns:repeat(3,1fr);gap:8px}.admin-actions .admin-icon-btn{width:100%;justify-content:center}.dashboard-hero,.v6-hero{border-radius:24px!important;padding:20px!important}.hero-stats,.stats-grid,.cards4{grid-template-columns:1fr 1fr!important}.v20-main-grid,.v24-customer-grid,.dash-grid,.grid,.form.two{grid-template-columns:1fr!important}.v24-chat-box{height:52vh}.v24-chat-form{display:grid!important;grid-template-columns:1fr!important}.request-card,.v21-request-card{padding:14px!important}.request-head{display:block!important}.request-meta{grid-template-columns:1fr!important}.v20-live-card{min-width:210px!important}.v22-grid{grid-template-columns:1fr!important}.admin-profile{margin-bottom:20px}.table{min-width:700px}.table-wrap{overflow:auto}.chat-icon-tools{justify-content:center}.problem-img,.problem-preview{max-width:100%}}
  @media(max-width:520px){.hero-stats,.stats-grid,.cards4{grid-template-columns:1fr!important}.dashboard-hero h1{font-size:32px!important}.admin-actions{grid-template-columns:1fr 1fr}.admin-actions .clean-logout{grid-column:1/-1}.btn,.admin-icon-btn{min-height:48px}.v24-chat-head{display:block}.chat-protection-note{font-size:13px}.v20-live-card{min-width:185px!important}.auth-card{padding:20px!important}.sidebtn{min-height:54px!important}.v24-main{padding-bottom:80px!important}}
  `;
  const st=document.createElement('style'); st.textContent=css; document.head.appendChild(st);
})();

;(function(){
  window.v25Esc = window.v24Safe || function(s){return String(s||'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]))};

  window.v25InsufficientBalanceModal = function(msg){
    document.querySelectorAll('.v25-modal-backdrop').forEach(x=>x.remove());
    const d=document.createElement('div');
    d.className='v25-modal-backdrop';
    d.innerHTML=`<div class="v25-balance-modal">
      <div class="v25-modal-icon">💳</div>
      <h2>رصيدك غير كافي</h2>
      <p>${v25Esc(msg||'بعد أول طلبين مجانيين يجب شحن الرصيد قبل تقديم عرض جديد.')}</p>
      <div class="v25-modal-actions">
        <button class="btn ghost" onclick="document.querySelector('.v25-modal-backdrop')?.remove()">لاحقاً</button>
        <button class="btn" onclick="document.querySelector('.v25-modal-backdrop')?.remove();state.tab='balance';dashboard()">الانتقال إلى الباقات والشحن</button>
      </div>
      <small>سيتم تحويلك تلقائياً خلال ثواني إذا لم تضغط أي خيار.</small>
    </div>`;
    document.body.appendChild(d);
    setTimeout(()=>{ if(document.body.contains(d)){ d.remove(); state.tab='balance'; dashboard(); } }, 2600);
  };

  window.sendOffer = async function(e,id){
    e.preventDefault();
    const btn=e.submitter || e.target.querySelector('button[type="submit"],button.btn');
    if(btn){btn.disabled=true;btn.textContent='جاري إرسال العرض...';}
    try{
      await api(`/api/requests/${id}/offer`,{method:'POST',body:JSON.stringify({offer_price:offerPrice.value,duration:arrivalTime.value,note:offerNote.value||''})});
      toast('تم إرسال العرض، بانتظار موافقة العميل');
      state.tab='orders';
      dashboard();
    }catch(err){
      const m=err.message||'حدث خطأ';
      if(m.includes('رصيدك غير كافي') || m.includes('غير كاف')) v25InsufficientBalanceModal(m);
      else toast(m);
    }finally{
      if(btn){btn.disabled=false;btn.textContent='إرسال العرض للعميل';}
    }
  };

  window.v25TopServicesTicker = function(){
    const base=(state.meta.services&&state.meta.services.length?state.meta.services:[{name:'كهربائي',icon:'⚡'},{name:'سباك',icon:'🚰'},{name:'تكييف',icon:'❄️'}]);
    const services=[...base,...base,...base];
    return `<div class="v25-top-services">
      <div class="v25-top-head"><div><span class="eyebrow">Live</span><h2>الخدمات الأكثر طلباً</h2><p>تتحرك مباشرة وتحدث حسب المهن المضافة من الأدمن.</p></div><b>🔥 الأكثر نشاطاً</b></div>
      <div class="v25-top-marquee"><div class="v25-top-track">
        ${services.map((s,i)=>`<div class="v25-top-card" onclick="state.tab=state.user?.role==='customer'?'dash':'orders';dashboard()"><span>${v25Esc(s.icon||'🛠️')}</span><div><b>${v25Esc(s.name||s)}</b><small>${320-((i%8)*19)} طلب هذا الشهر • فنيين متاحين</small></div></div>`).join('')}
      </div></div>
    </div>`;
  };

  const oldCharts = window.chartsBox;
  window.chartsBox = function(){
    return v25TopServicesTicker()+`<div class="dash-grid"><div class="dash-card"><h2>أداء الشهر</h2><div class="chart-fake"></div></div><div class="dash-card"><h2>توزيع الطلبات</h2><div class="donut-fake"></div><div class="mini-list" style="margin-top:18px"><div class="mini-list-row"><span>مكتملة</span><b>65%</b></div><div class="mini-list-row"><span>قيد التنفيذ</span><b>25%</b></div><div class="mini-list-row"><span>ملغاة</span><b>10%</b></div></div></div></div>`;
  };

  const oldV20Strip = window.v20LiveServicesStrip;
  window.v20LiveServicesStrip = function(){
    const html = oldV20Strip ? oldV20Strip() : '';
    return html.replace('v20-marquee-track','v20-marquee-track v25-slow-strip');
  };

  const oldTechBalance = window.v22TechBalance;
  window.v22TechBalance = function(me){
    return `<div class="v25-balance-alert-sm">⚠️ <b>أول طلبين مجاناً</b> — بعدها يلزم رصيد لتقديم عروض.</div>` + (oldTechBalance ? oldTechBalance(me) : balancePage(me));
  };
})();

/* V26 location sender override */
window.sendLocation = async function(id){
  if(!navigator.geolocation) return toast('المتصفح لا يدعم تحديد الموقع');
  toast('جاري تحديد موقعك...');
  navigator.geolocation.getCurrentPosition(async pos=>{
    const lat=pos.coords.latitude.toFixed(6), lng=pos.coords.longitude.toFixed(6);
    try{
      const j=await api(`/api/requests/${id}/messages`,{method:'POST',body:JSON.stringify({body:`[location]${lat},${lng}`})});
      renderMessages(j.messages||[]);
      toast('تم إرسال الموقع داخل الشات');
    }catch(e){ toast(e.message||'تعذر إرسال الموقع'); }
  },()=>toast('لم يتم السماح بالوصول للموقع. فعّل Location من المتصفح.'),{enableHighAccuracy:true,timeout:12000});
};


;(function(){
  const esc = window.v15EscapeHtml || ((s)=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])));
  const cleanText = (s)=>String(s||'').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,'').trim();

  window.__SALLEHLY_PATCH_VERSION__ = 'v33-support-real-final';

  window.sallehlySupportContentV33 = function(){
    return `<section class="v33-support-page">
      <div class="dash-card v33-support-main">
        <span class="eyebrow">مركز الدعم</span>
        <h2>الدعم الفني</h2>
        <p class="muted">هذه صفحة الدعم الخاصة بالعميل. ليست صفحة طلب جديد. اكتب المشكلة وسيتم إرسالها للإدارة.</p>
        <form class="form v33-support-form" onsubmit="sendSupport(event)">
          <div class="field"><label>نوع المشكلة</label><select id="supportType"><option value="مشكلة طلب">مشكلة طلب</option><option value="مشكلة حساب">مشكلة حساب</option><option value="مشكلة دفع أو رصيد">مشكلة دفع أو رصيد</option><option value="مشكلة في الموقع">مشكلة في الموقع</option><option value="اقتراح تحسين">اقتراح تحسين</option></select></div>
          <div class="field"><label>عنوان المشكلة</label><input id="supportTitle" required minlength="3" maxlength="120" placeholder="مثال: زر الدردشة لا يعمل"></div>
          <div class="field full"><label>التفاصيل</label><textarea id="supportBody" required minlength="10" maxlength="2000" placeholder="اشرح المشكلة بشكل واضح..."></textarea></div>
          <button class="btn" type="submit">إرسال طلب الدعم</button>
        </form>
      </div>
      <div class="dash-card v33-support-side">
        <h2>مساعدة سريعة</h2>
        <div class="faq-list">
          <details open><summary>كيف أتابع الطلب؟</summary><p>من صفحة طلباتي يمكنك مشاهدة الحالة والعروض والدردشة.</p></details>
          <details><summary>الدردشة لا تظهر؟</summary><p>الدردشة تظهر بعد قبول عرض الفني.</p></details>
          <details><summary>الموقع لا يرسل؟</summary><p>اسمح للمتصفح باستخدام الموقع ثم جرّب مرة أخرى.</p></details>
        </div>
      </div>
    </section>`;
  };

  window.supportPage = function(){ return window.sallehlySupportContentV33(); };

  window.sendSupport = async function(e){
    e.preventDefault();
    const btn=e.submitter;
    try{
      if(btn){btn.disabled=true; btn.textContent='جاري الإرسال...';}
      const type=document.getElementById('supportType')?.value || 'عام';
      const title=(document.getElementById('supportTitle')?.value||'').trim();
      const body=(document.getElementById('supportBody')?.value||'').trim();
      if(title.length<3) throw new Error('اكتب عنوان المشكلة');
      if(body.length<10) throw new Error('اكتب تفاصيل أوضح');
      await api('/api/support',{method:'POST',body:JSON.stringify({type,title,body})});
      toast?.('تم إرسال طلب الدعم للإدارة بنجاح');
      e.target.reset();
    }catch(err){ toast?.(err.message || 'تعذر إرسال طلب الدعم'); }
    finally{ if(btn){btn.disabled=false; btn.textContent='إرسال طلب الدعم';} }
  };

  window.renderCustomerSupportV33 = function(){
    state.tab='support';
    const menu=[['dash','طلب جديد'],['near','البحث عن فني'],['orders','طلباتي'],['chats','الدردشات'],['support','الدعم الفني']];
    const content = (window.dashboardHero ? dashboardHero('الدعم الفني','أرسل مشكلتك للإدارة مباشرة.',[]) : '') + window.sallehlySupportContentV33();
    window.layout('لوحة العميل', menu, content);
  };

  window.v13Ticker = function(){ return ''; };
  window.v20LiveServicesStrip = function(){ return ''; };

  window.v33RequestJobsStrip = function(){
    const services=(state.meta&&Array.isArray(state.meta.services)&&state.meta.services.length)?state.meta.services:[];
    const safe=services.length?services:[{name:'كهربائي',icon:''},{name:'سباك',icon:''},{name:'تكييف',icon:''},{name:'نجار',icon:''}];
    const cards=safe.map(s=>{const name=esc(s.name||'خدمة'); const raw=String(s.name||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); return `<button type="button" class="v33-job-card" onclick="if(document.getElementById('qservice')){document.getElementById('qservice').value='${raw}';document.getElementById('qservice').scrollIntoView({behavior:'smooth',block:'center'});}"><span>${esc(s.icon||'')}</span><b>${name}</b><small>متوفر الآن</small></button>`;}).join('');
    return `<section class="v33-job-strip"><div class="v33-strip-head"><h2>شريط المهن</h2><p>كل مهنة يضيفها الأدمن تظهر هنا تلقائياً داخل صفحة طلب جديد.</p></div><div class="v33-marquee"><div class="v33-track">${cards}${cards}${cards}</div></div></section>`;
  };

  window.layout = function(title,menu,content){
    document.body.classList.add('dashboard-mode');
    const user=state.user||{};
    const hasSupport=(menu||[]).some(m=>m[0]==='support');
    const system = hasSupport ? [['settings','الإعدادات']] : [['settings','الإعدادات'],['support','الدعم الفني']];
    const btn=(m)=>{
      const isSupport=m[0]==='support' && user.role==='customer';
      const click=isSupport ? 'renderCustomerSupportV33()' : `state.tab='${m[0]}';dashboard()`;
      return `<button type="button" class="sidebtn ${state.tab===m[0]?'active':''}" onclick="${click}"><b>${cleanText(m[1])}</b></button>`;
    };
    app.innerHTML=`<div class="admin-shell v33-shell"><aside class="admin-sidebar v33-sidebar"><div class="admin-logo"><img src="/logo.png" alt="صلّحلي" class="logo-img">صلّحلي</div><button class="mobile-menu-close" onclick="document.body.classList.remove('sidebar-open')">×</button><div class="admin-section-label">الرئيسية</div><div class="admin-menu">${(menu||[]).map(btn).join('')}</div><div class="admin-section-label">النظام</div><div class="admin-menu">${system.map(btn).join('')}<button type="button" class="sidebtn logout-side" onclick="v15LogoutConfirm?.()||logout()"><b>تسجيل خروج</b></button></div><div class="admin-profile"><div class="avatar-sm">${esc((user.name||'ص').slice(0,1))}</div><div><b>${esc(user.name||'مستخدم')}</b><small>${esc(user.email||'')}</small></div></div></aside><main class="admin-main v33-main"><div class="admin-top"><button class="admin-icon-btn mobile-menu-open" onclick="document.body.classList.add('sidebar-open')">القائمة</button><div class="admin-search"><input placeholder="بحث عن فني أو خدمة أو طلب..."></div><div class="admin-actions"><button class="admin-icon-btn" onclick="v24RefreshBadges?.()">التنبيهات</button><button class="admin-icon-btn" onclick="v10ToggleTheme?.()">الوضع</button><button class="admin-icon-btn clean-logout" onclick="v15LogoutConfirm?.()||logout()">تسجيل خروج</button></div></div><div class="v33-content">${content}</div></main></div>`;
    window.v10ApplyTheme?.();
  };

  window.custDash = async function(){
    const menu=[['dash','طلب جديد'],['near','البحث عن فني'],['orders','طلباتي'],['chats','الدردشات'],['support','الدعم الفني']];
    let content='';
    if(state.tab==='support'){
      content=(window.dashboardHero?dashboardHero('الدعم الفني','أرسل مشكلتك للإدارة مباشرة.',[]): '') + window.sallehlySupportContentV33();
    }else if(state.tab==='orders'){
      const j=await api('/api/requests');
      content=(window.dashboardHero?dashboardHero('طلباتي','تابع طلباتك والعروض والدردشات.',window.v20CustomerStats?.(j.requests||[])||[]): '') + `<div class="dash-card"><h2>طلباتي</h2>${typeof window.v18OrdersView==='function'?window.v18OrdersView(j.requests||[]):reqTable(j.requests||[])}</div>`;
    }else if(state.tab==='chats'){
      content=(window.dashboardHero?dashboardHero('الدردشات','كل المحادثات مع الفنيين هنا.',[]): '') + await chatsPage();
    }else if(state.tab==='near'){
      content=(window.dashboardHero?dashboardHero('البحث عن فني','ابحث حسب الخدمة والمنطقة وشاهد التقييم.',[]): '') + (window.v20SearchPanel?window.v20SearchPanel():nearbyPage());
    }else if(state.tab==='settings'){
      content=(window.dashboardHero?dashboardHero('الإعدادات','عدّل بيانات حسابك.',[]): '') + settingsPage();
    }else{
      const j=await api('/api/requests').catch(()=>({requests:[]}));
      content=(window.dashboardHero?dashboardHero('لوحة العميل','انشر طلبك واستقبل عروض الفنيين مباشرة.',window.v20CustomerStats?.(j.requests||[])||[]): '') + window.v33RequestJobsStrip() + `<div class="v20-main-grid v24-customer-grid"><div>${requestForm()}</div><div>${window.v20SearchPanel?window.v20SearchPanel():nearbyPage()}</div></div>`;
    }
    window.layout('لوحة العميل', menu, content);
    if(['dash','near'].includes(state.tab)){ window.bindAreaSelect?.('qcity','qarea','qareaOtherWrap'); window.bindAreaSelect?.('searchCity','searchArea'); }
    if(state.tab==='near') setTimeout(()=>window.searchTechnicians?.(),100);
    if(state.tab==='settings') window.bindAreaSelect?.('setCity','setArea');
  };

  window.dashboard = function(){
    if(!state.user) return login();
    if(state.user.role==='admin') return admin();
    if(state.user.role==='technician') return techDash();
    return window.custDash();
  };

  const st=document.createElement('style');
  st.textContent=`
    .v33-sidebar .mi,.v33-sidebar .sidebtn span.mi,.v33-sidebar .sidebtn>span:not(.badge){display:none!important}.v33-sidebar .sidebtn{justify-content:center!important;text-align:center!important}.v33-sidebar .sidebtn b{font-size:18px!important}.v33-content>.v20-live-strip,.v33-content>.v13-ticker,.v33-content>.v31-job-strip,.v33-content>.v32-job-strip{display:none!important}.v33-support-page{display:grid;grid-template-columns:1.35fr .85fr;gap:22px}.v33-support-main textarea{min-height:190px}.v33-support-form .full{grid-column:1/-1}.v33-job-strip{background:linear-gradient(135deg,#101d55,#6430d5);border-radius:28px;padding:24px;margin:18px 0 24px;color:#fff;overflow:hidden;box-shadow:0 18px 50px rgba(40,35,120,.18)}.v33-strip-head{margin-bottom:16px}.v33-strip-head h2{margin:0;font-size:28px}.v33-strip-head p{margin:6px 0 0;color:rgba(255,255,255,.78)}.v33-marquee{overflow:hidden}.v33-track{display:flex;gap:16px;width:max-content;animation:v33Scroll 85s linear infinite}.v33-job-card{min-width:245px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.10);color:#fff;border-radius:20px;padding:16px 18px;display:flex;align-items:center;gap:12px;cursor:pointer}.v33-job-card span{width:48px;height:48px;border-radius:16px;display:grid;place-items:center;background:rgba(255,255,255,.13);font-size:22px}.v33-job-card b{font-size:18px}.v33-job-card small{color:#bdf7ff}@keyframes v33Scroll{from{transform:translateX(0)}to{transform:translateX(33.333%)}}@media(max-width:900px){.v33-support-page,.v20-main-grid,.v24-customer-grid{grid-template-columns:1fr!important}.v33-job-card{min-width:220px}.v33-job-strip{padding:18px;border-radius:22px}.admin-shell{display:block!important}.admin-sidebar{position:relative!important;width:100%!important;min-height:auto!important}.admin-main{padding:14px!important}.admin-menu{grid-template-columns:repeat(2,minmax(0,1fr))!important}.admin-top{grid-template-columns:1fr!important}.stats-grid,.hero-stats{grid-template-columns:1fr 1fr!important}}@media(max-width:520px){.v33-job-card{min-width:200px;padding:13px}.v33-track{animation-duration:95s}.stats-grid,.hero-stats{grid-template-columns:1fr!important}.admin-menu{grid-template-columns:1fr!important}.dash-card{padding:16px!important}.dashboard-hero{padding:18px!important}.admin-actions{display:grid!important;grid-template-columns:1fr!important}.admin-search input{width:100%!important}}
  `;
  document.head.appendChild(st);
})();


;(function(){
  window.__SALLEHLY_MAP_PATCH_VERSION__ = 'v34-real-maps-fix';
  const esc = window.v15EscapeHtml || ((s)=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])));
  const maps = window.__sallehlyLeafletMaps = window.__sallehlyLeafletMaps || {};
  const jordanCenter = [31.9539, 35.9106];

  function validCoord(lat,lng){
    lat = Number(lat); lng = Number(lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }
  function mapsUrl(lat,lng){ return `https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lng)}`; }

  window.sallehlyInitMap = function(id, lat, lng, label){
    setTimeout(()=>{
      const el = document.getElementById(id);
      if(!el || !validCoord(lat,lng)) return;
      if(typeof L === 'undefined'){
        el.innerHTML = `<div class="map-fallback"><b>تعذر تحميل الخريطة</b><small>تأكد أن السيرفر يسمح بتحميل Leaflet/OpenStreetMap.</small><a target="_blank" rel="noopener" href="${mapsUrl(lat,lng)}">فتح الموقع على Google Maps</a></div>`;
        return;
      }
      try{
        if(maps[id]){ maps[id].remove(); delete maps[id]; }
        const map = L.map(id, {scrollWheelZoom:false, zoomControl:true}).setView([Number(lat), Number(lng)], 15);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);
        L.marker([Number(lat), Number(lng)]).addTo(map).bindPopup(esc(label || 'الموقع المحدد'));
        maps[id] = map;
        setTimeout(()=>map.invalidateSize(), 120);
      }catch(e){
        console.error('Sallehly map error:', e);
        el.innerHTML = `<div class="map-fallback"><b>حدث خطأ في عرض الخريطة</b><a target="_blank" rel="noopener" href="${mapsUrl(lat,lng)}">فتح الموقع على Google Maps</a></div>`;
      }
    }, 80);
  };

  window.mapBox = function(lat,lng,label='موقع العميل'){
    if(!validCoord(lat,lng)) return `<div class="mapbox empty">لم يتم تحديد الموقع بعد</div>`;
    const safeLat = Number(lat).toFixed(6), safeLng = Number(lng).toFixed(6);
    const id = 'map_' + Math.random().toString(36).slice(2,10);
    setTimeout(()=>window.sallehlyInitMap(id, safeLat, safeLng, label), 0);
    return `<div class="map-wrap"><div id="${id}" class="mapbox real-map" data-lat="${safeLat}" data-lng="${safeLng}"></div><div class="map-actions"><a class="maplink" target="_blank" rel="noopener" href="${mapsUrl(safeLat,safeLng)}">فتح الموقع على خرائط Google</a></div></div>`;
  };

  window.useGPS = function(mode='near'){
    if(!navigator.geolocation){ toast?.('المتصفح لا يدعم تحديد الموقع GPS'); return; }
    if(location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'){
      toast?.('تحديد الموقع يحتاج HTTPS عند رفع الموقع على السيرفر');
    }
    toast?.('جاري تحديد موقعك... اسمح للمتصفح باستخدام الموقع');
    navigator.geolocation.getCurrentPosition(pos=>{
      const lat = Number(pos.coords.latitude).toFixed(6);
      const lng = Number(pos.coords.longitude).toFixed(6);
      state.gps = {lat,lng};
      try{ localStorage.sallehly_last_gps = JSON.stringify(state.gps); }catch(e){}
      const c = typeof cityFromGPS==='function' ? cityFromGPS(Number(lat), Number(lng)) : 'عمان';
      const ncity=document.getElementById('ncity'), qcity=document.getElementById('qcity');
      if(ncity) ncity.value=c;
      if(qcity) qcity.value=c;
      const nearMap=document.getElementById('nearMap'), requestMap=document.getElementById('requestMap');
      if(nearMap) nearMap.innerHTML = window.mapBox(lat,lng,'موقعك الحالي');
      if(requestMap) requestMap.innerHTML = window.mapBox(lat,lng,'موقع العميل');
      toast?.('تم تحديد موقعك وعرض الخريطة بنجاح');
      if(mode==='near') window.loadNearby?.();
    }, err=>{
      const messages={1:'لم يتم السماح بالوصول للموقع. فعّل Location من المتصفح.',2:'تعذر معرفة موقعك حاليًا.',3:'انتهت مهلة تحديد الموقع، جرّب مرة ثانية.'};
      toast?.(messages[err.code] || 'تعذر تحديد الموقع');
    }, {enableHighAccuracy:true, timeout:15000, maximumAge:60000});
  };

  const oldRequestForm = window.requestForm;
  window.requestForm = function(){
    const html = oldRequestForm ? oldRequestForm() : '';
    setTimeout(()=>{
      try{
        if(!state.gps && localStorage.sallehly_last_gps) state.gps = JSON.parse(localStorage.sallehly_last_gps);
        if(state.gps && document.getElementById('requestMap')) document.getElementById('requestMap').innerHTML = window.mapBox(state.gps.lat,state.gps.lng,'موقع العميل');
      }catch(e){}
    },100);
    return html;
  };

  const oldNearbyPage = window.nearbyPage;
  window.nearbyPage = function(){
    const html = oldNearbyPage ? oldNearbyPage() : '';
    setTimeout(()=>{
      try{
        if(!state.gps && localStorage.sallehly_last_gps) state.gps = JSON.parse(localStorage.sallehly_last_gps);
        if(state.gps && document.getElementById('nearMap')) document.getElementById('nearMap').innerHTML = window.mapBox(state.gps.lat,state.gps.lng,'موقعك الحالي');
      }catch(e){}
    },100);
    return html;
  };

  const oldMsgBody = window.messageBody;
  window.messageBody = function(body){
    body=String(body||'');
    if(body.startsWith('[location]')){
      const p=body.replace('[location]','').split(',');
      const lat=p[0], lng=p[1];
      return validCoord(lat,lng) ? `📍 تم إرسال موقع<div>${window.mapBox(lat,lng,'موقع مرسل في المحادثة')}</div>` : '📍 موقع غير صالح';
    }
    return oldMsgBody ? oldMsgBody(body) : esc(body);
  };

  const st=document.createElement('style');
  st.textContent=`
    .map-wrap{width:100%;margin-top:12px}.mapbox.real-map{width:100%;height:270px;min-height:230px;border:1px solid var(--line,#dbe4f0);border-radius:18px;overflow:hidden;background:#eef5ff;position:relative;z-index:1}.map-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px}.maplink{font-weight:900;color:var(--blue,#2563eb);text-decoration:none}.map-fallback{height:100%;min-height:190px;display:grid;place-items:center;text-align:center;gap:8px;padding:16px;background:#f8fafc;border-radius:18px;color:#0f172a}.map-fallback a{color:#2563eb;font-weight:900}.leaflet-container{font-family:Tajawal,Arial,sans-serif}.msg .mapbox.real-map{height:210px;min-height:190px}@media(max-width:700px){.mapbox.real-map{height:230px;min-height:210px}.msg .mapbox.real-map{height:190px}}
  `;
  document.head.appendChild(st);
})();


function v35ScrollToContent(){
  try{
    const main=document.querySelector('.admin-main,.v24-main');
    if(main && window.innerWidth<=900) main.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){}
}
window.addEventListener('error', function(e){
  try{
    if(String(e.message||'').includes('Failed to fetch')){
      toast('تأكد أنك مشغل المشروع من npm start وليس Live Server فقط');
    }
  }catch(_){}
});

;(function(){
  function safe(s){return String(s??'').replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]});}
  function icon(k){try{return (typeof menuIconV13==='function'?menuIconV13(k):(typeof menuIcon==='function'?menuIcon(k):''))||'';}catch(e){return ''}}
  window.v37CloseDrawer=function(){document.body.classList.remove('v37-menu-open','sidebar-open','open')};
  window.v37OpenDrawer=function(){document.body.classList.add('v37-menu-open')};
  window.v37Go=function(tab){state.tab=tab; v37CloseDrawer(); dashboard(); setTimeout(function(){try{document.querySelector('.v37-content,.admin-main')?.scrollIntoView({behavior:'smooth',block:'start'});}catch(e){}},80)};

  layout=function(title, menu, content){
    document.body.classList.add('dashboard-mode','v37-dashboard');
    const user=state.user||{};
    const sys=[['settings','الإعدادات'],['support','الدعم الفني']];
    const make=function(m){
      const key=String(m[0]); const label=String(m[1]);
      let badge=''; try{ if(key==='chats' && typeof v13Badge==='function') badge=' '+v13Badge(state.chatCount); }catch(e){}
      return `<button type="button" class="sidebtn ${state.tab===key?'active':''}" onclick="v37Go('${safe(key)}')"><b>${safe(label)}${badge}</b><span class="mi">${icon(key)}</span></button>`;
    };
    app.innerHTML=`
      <div class="v37-overlay" onclick="v37CloseDrawer()"></div>
      <div class="admin-shell v37-shell">
        <header class="v37-mobile-header">
          <button type="button" class="v37-menu-btn" onclick="v37OpenDrawer()" aria-label="فتح القائمة">☰</button>
          <div class="v37-brand"><img src="/logo.png" alt="صلّحلي" class="logo-img"><b>صلّحلي</b></div>
          <div class="v37-header-actions">
            <div class="bell-wrap">
  <button type="button" class="bell-btn" onclick="toggleBell()">
    🔔 <span class="bell-count"></span>
  </button>
  <div id="bellMenu" class="bell-menu"></div>
</div>
            <button type="button" onclick="typeof v10ToggleTheme==='function'?v10ToggleTheme():document.body.classList.toggle('dark-dash')">🌙</button>
          </div>
        </header>

        <aside class="admin-sidebar v37-drawer">
          <div class="v37-drawer-title">
            <div class="admin-logo"><img src="/logo.png" alt="صلّحلي" class="logo-img">صلّحلي</div>
            <button type="button" class="v37-close" onclick="v37CloseDrawer()">×</button>
          </div>
          <div class="admin-section-label">الرئيسية</div>
          <div class="admin-menu">${(menu||[]).map(make).join('')}</div>
          <div class="admin-section-label">النظام</div>
          <div class="admin-menu">${sys.map(make).join('')}<button type="button" class="sidebtn logout-side" onclick="v37CloseDrawer();(typeof v15LogoutConfirm==='function'?v15LogoutConfirm():logout())"><b>تسجيل خروج</b><span class="mi">🚪</span></button></div>
          <div class="admin-profile"><div class="avatar-sm">${safe((user.name||'ص').slice(0,1))}</div><div><b>${safe(user.name||roleName())}</b><small>${safe(user.email||roleName())}</small></div></div>
        </aside>

        <main class="admin-main v37-main">
          <div class="admin-top v37-search-row">
            <div class="admin-search">🔎 <input placeholder="بحث عن فني أو خدمة أو طلب..." onkeydown="if(event.key==='Enter'){state.tab=state.user.role==='customer'?'near':'orders';dashboard();setTimeout(()=>{let q=document.getElementById('searchTechQ');if(q){q.value=this.value;if(typeof searchTechnicians==='function')searchTechnicians();}},120)}"></div>
          </div>
          <div class="v37-content">${content}</div>
        </main>
      </div>`;
    try{ if(typeof v10ApplyTheme==='function') v10ApplyTheme(); }catch(e){}
  };

  const css=`
  body.v37-dashboard{overflow-x:hidden!important;background:#eef4ff!important}
  body.v37-dashboard .admin-shell.v37-shell{display:block!important;grid-template-columns:1fr!important;min-height:100vh!important;background:#eef4ff!important}
  body.v37-dashboard .v37-mobile-header{position:sticky!important;top:0!important;z-index:950!important;display:flex!important;align-items:center!important;justify-content:space-between!important;gap:10px!important;padding:12px 14px!important;background:#071331!important;color:#fff!important;border-radius:0 0 24px 24px!important;box-shadow:0 15px 40px rgba(2,6,23,.20)!important;direction:rtl!important}
  .v37-menu-btn{width:48px!important;height:48px!important;border:0!important;border-radius:15px!important;background:linear-gradient(135deg,#7c3aed,#2563eb)!important;color:#fff!important;font-size:27px!important;font-weight:900!important;display:grid!important;place-items:center!important;cursor:pointer!important}
  .v37-brand{display:flex!important;align-items:center!important;gap:9px!important;font-size:23px!important;font-weight:900!important}.v37-brand span,.v37-drawer .admin-logo span{width:42px!important;height:42px!important;border-radius:14px!important;display:grid!important;place-items:center!important;background:linear-gradient(135deg,#7c3aed,#2563eb)!important;color:#fff!important}.v37-header-actions{display:flex!important;gap:8px!important}.v37-header-actions button,.v37-close{width:42px!important;height:42px!important;border:0!important;border-radius:14px!important;background:rgba(255,255,255,.14)!important;color:#fff!important;font-size:20px!important;font-weight:900!important}
  body.v37-dashboard .admin-sidebar.v37-drawer{position:fixed!important;top:0!important;right:-340px!important;left:auto!important;width:min(86vw,330px)!important;height:100vh!important;min-height:100vh!important;max-height:100vh!important;z-index:1002!important;padding:16px!important;background:linear-gradient(180deg,#071331,#0b1a42)!important;border-radius:24px 0 0 24px!important;overflow-y:auto!important;transition:right .28s ease!important;box-shadow:-25px 0 80px rgba(2,6,23,.45)!important;display:block!important}
  body.v37-menu-open .admin-sidebar.v37-drawer{right:0!important}
  .v37-overlay{display:none!important;position:fixed!important;inset:0!important;z-index:1001!important;background:rgba(2,6,23,.48)!important;backdrop-filter:blur(4px)!important}body.v37-menu-open .v37-overlay{display:block!important}
  .v37-drawer-title{display:flex!important;align-items:center!important;justify-content:space-between!important;margin-bottom:12px!important}.v37-drawer .admin-logo{margin:0!important;font-size:24px!important;justify-content:flex-start!important;display:flex!important;align-items:center!important;gap:9px!important}
  body.v37-dashboard .admin-sidebar.v37-drawer .admin-menu{display:grid!important;grid-template-columns:1fr!important;gap:9px!important}.v37-drawer .sidebtn{height:55px!important;min-height:55px!important;border-radius:16px!important;font-size:16px!important;display:flex!important;align-items:center!important;justify-content:space-between!important;padding:0 16px!important;text-align:right!important}.v37-drawer .sidebtn b{font-size:16px!important;white-space:nowrap!important}.v37-drawer .admin-section-label{text-align:right!important;margin:18px 8px 9px!important;color:#8da0cc!important}.v37-drawer .admin-profile{position:static!important;display:flex!important;margin-top:18px!important}
  body.v37-dashboard .admin-main.v37-main{width:100%!important;max-width:430px!important;margin:0 auto!important;padding:10px 10px 18px!important;display:block!important}.v37-search-row{position:relative!important;display:flex!important;height:auto!important;padding:0!important;margin:8px 0 16px!important;background:transparent!important;box-shadow:none!important;border:0!important}.v37-search-row .admin-search{width:100%!important}
  body.v37-dashboard .admin-shell > .admin-sidebar:not(.v37-drawer){display:none!important}body.v37-dashboard .admin-menu:not(.v37-drawer .admin-menu){grid-template-columns:1fr!important}
  @media(max-width:900px){body.v37-dashboard .admin-shell{display:block!important}.v37-mobile-header{display:flex!important}.admin-main.v37-main{padding:10px!important}.admin-menu{grid-template-columns:1fr!important}.admin-top{grid-template-columns:1fr!important}.dash-card{max-width:100%!important}.dashboard-hero{margin-top:0!important}}
  @media(min-width:901px){body.v37-dashboard .admin-main.v37-main{max-width:1180px!important}.v37-mobile-header{border-radius:0!important}.v37-search-row{max-width:700px!important;margin:16px auto!important}}
  `;
  const st=document.createElement('style'); st.id='v37-true-hamburger-css'; st.textContent=css; document.head.appendChild(st);
})();


(function(){
  function publicClean(){
    document.body.classList.remove('open','sidebar-open','v37-menu-open','dashboard-mode','v37-dashboard');
  }
  const oldGo = window.go;
  window.go = function(p){
    p = String(p || 'home');
    if(['home','services','how','tech','contact','login','register'].includes(p)) publicClean();
    if(p==='home') return home();
    if(p==='services') return servicesPage();
    if(p==='how') return howPage();
    if(p==='tech') return techPage();
    if(p==='contact') return contact();
    if(p==='login') return login();
    if(p==='register') return register();
    if(p==='dashboard') return dashboard();
    if(typeof oldGo==='function') return oldGo(p);
  };
  document.addEventListener('click', function(e){
    const el = e.target.closest('[data-route]');
    if(!el) return;
    e.preventDefault();
    window.go(el.getAttribute('data-route') || 'home');
  }, true);
})();

/* ===== V40 PREMIUM PUBLIC HOME + SLOW LIVE SERVICES ===== */
// ── V61: Premium Home Page — Dark Theme ──
;(function(){

  const safe = window.esc || ((v)=>String(v ?? ''));

  const getServices = ()=>{
    const fallback=[
      {name:'كهربائي',icon:'⚡'},{name:'سباك',icon:'🚰'},{name:'تكييف',icon:'❄️'},
      {name:'نجار',icon:'🪚'},{name:'دهان',icon:'🎨'},{name:'صيانة أجهزة',icon:'📺'},
      {name:'تركيب أثاث',icon:'🪑'},{name:'تركيب زجاج',icon:'🪟'}
    ];
    return (state.meta && Array.isArray(state.meta.services) && state.meta.services.length)
      ? state.meta.services.map((s,i)=>({name:s.name||fallback[i%fallback.length].name, icon:s.icon||fallback[i%fallback.length].icon}))
      : fallback;
  };

  const chooseService = (name)=>{
    localStorage.pendingService = String(name||'');
    go(state.user ? 'dashboard' : 'register');
  };
  window.v40ChooseService = chooseService;

  window.home = home = function(){
    document.body.classList.remove('open','sidebar-open','v37-menu-open','dashboard-mode','v37-dashboard');
    const services = getServices();
    const pills = services.map((s,i)=>`<button class="v61-pill" onclick="v40ChooseService('${String(s.name).replace(/'/g,"\\'")}')"><span>${safe(s.icon||'🛠️')}</span><b>${safe(s.name)}</b></button>`).join('');
    const mainCards = services.slice(0,6).map((s,i)=>`<button class="v61-service-card" onclick="v40ChooseService('${String(s.name).replace(/'/g,"\\'")}')"><div class="v61-service-icon">${safe(s.icon||'🛠️')}</div><h3>${safe(s.name)}</h3><p>فنيين متاحين قريبين منك</p><span class="v61-service-cta">ابحث عن فني ←</span></button>`).join('');

    app.innerHTML = `
    <div class="v61-home">

      <!-- Particles -->
      <canvas class="v60-canvas" id="v61Canvas"></canvas>
      <div class="v61-bg-gradient"></div>

      <!-- HERO -->
      <section class="v61-hero">
        <div class="v61-hero-content">

          <div class="v61-badge">
            <i class="v61-live-dot"></i>
            خدمات صيانة مباشرة في الأردن
          </div>

          <h1 class="v61-h1">
            خدمات الصيانة<br>
            <span class="v61-gradient-text">صارت أسهل وأرتب</span>
          </h1>

          <p class="v61-lead">اطلب الخدمة، حدّد موقعك، واستقبل عروض الفنيين الموثوقين حسب منطقتك وتقييماتهم.</p>

          <div class="v61-actions">
            <button class="v61-btn-primary" onclick="go('${state.user?'dashboard':'register'}')">
              اطلب خدمة الآن
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
            <button class="v61-btn-ghost" onclick="register('technician')">
              انضم كفني 🔧
            </button>
          </div>

          <div class="v61-stats">
            <div class="v61-stat"><b>⭐ 4.8</b><small>تقييم الفنيين</small></div>
            <div class="v61-stat-div"></div>
            <div class="v61-stat"><b>24/7</b><small>طلبات مباشرة</small></div>
            <div class="v61-stat-div"></div>
            <div class="v61-stat"><b>GPS</b><small>تحديد موقع</small></div>
          </div>
        </div>

        <!-- Phone mockup -->
        <div class="v61-phone">
          <div class="v61-phone-glow"></div>
          <div class="v61-phone-inner">
            <div class="v61-phone-header">
              <div class="v61-phone-dot"></div>
              <span>صلّحلي</span>
              <span class="v61-phone-live">Live</span>
            </div>
            <div class="v61-phone-search">🔎 ابحث عن خدمة أو فني</div>
            ${services.slice(0,3).map((s,i)=>`
            <div class="v61-phone-row">
              <div class="v61-phone-avatar">${safe(s.icon||'🛠️')}</div>
              <div>
                <b>${safe(s.name)}</b>
                <small>${['★★★★★','★★★★½','★★★★☆'][i]} • قريب منك</small>
              </div>
              <button class="v61-phone-btn">اختيار</button>
            </div>`).join('')}
            <div class="v61-phone-map">📍 الفنيين الأقرب حسب منطقتك</div>
          </div>
        </div>
      </section>

      <!-- Live strip -->
      <section class="v61-strip" id="v61Strip">
        <div class="v61-strip-label">🔴 مباشر</div>
        <div class="v61-marquee"><div class="v61-track" id="v61Track">${pills}${pills}${pills}</div></div>
      </section>

      <!-- Services grid -->
      <section class="v61-services">
        <div class="v61-section-head">
          <span class="v61-eyebrow">خدمات جاهزة</span>
          <h2>اختار الخدمة وابدأ الطلب</h2>
          <p>كل خدمة تعرض الفنيين المتاحين حسب منطقتك وتقييماتهم</p>
        </div>
        <div class="v61-services-grid">${mainCards}</div>
      </section>

      <!-- Steps -->
      <section class="v61-steps">
        <div class="v61-section-head">
          <span class="v61-eyebrow">كيف يعمل؟</span>
          <h2>ثلاث خطوات بسيطة</h2>
        </div>
        <div class="v61-steps-grid">
          <div class="v61-step"><span>01</span><h3>أنشئ طلب</h3><p>اكتب المشكلة وحدد المحافظة والموقع</p></div>
          <div class="v61-step"><span>02</span><h3>اختر الفني</h3><p>شاهد الفنيين والتقييمات واختر الأنسب</p></div>
          <div class="v61-step"><span>03</span><h3>ادفع وقيّم</h3><p>بعد الإنجاز ادفع كاش وقيّم الفني</p></div>
        </div>
      </section>

      <!-- CTA -->
      <section class="v61-cta">
        <div class="v61-cta-card">
          <div class="v61-cta-glow"></div>
          <span class="v61-eyebrow">جاهز للبدء؟</span>
          <h2>ابدأ تجربتك مع صلّحلي الآن</h2>
          <p>انضم للمنصة وتواصل مع أفضل الفنيين في منطقتك</p>
          <button class="v61-btn-primary" onclick="go('${state.user?'dashboard':'register'}')">
            ابدأ الآن مجاناً
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
      </section>

    </div>`;

    // Particles
    v61StartParticles();
    window.scrollTo({top:0,behavior:'smooth'});
    // rebuild strip after meta loads if it was empty
    if(!state.meta.services || !state.meta.services.length){
      setTimeout(()=>{
        const track = document.getElementById('v61Track');
        if(track && state.meta.services && state.meta.services.length){
          const newPills = getServices().map(s=>`<button class="v61-pill" onclick="v40ChooseService('${String(s.name).replace(/'/g,"\\'")}')"><span>${safe(s.icon||'🛠️')}</span><b>${safe(s.name)}</b></button>`).join('');
          track.innerHTML = newPills + newPills + newPills;
        }
      }, 1500);
    }
  };

  function v61StartParticles(){
    const canvas = document.getElementById('v61Canvas');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    let W, H, P = [];
    function resize(){ W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight; }
    resize();
    window.addEventListener('resize', resize);
    function Pt(){ this.x=Math.random()*W; this.y=Math.random()*H; this.r=Math.random()*1.5+0.3; this.dx=(Math.random()-0.5)*0.3; this.dy=(Math.random()-0.5)*0.3; this.a=Math.random()*0.4+0.05; this.c=Math.random()>0.5?'124,58,237':'37,99,235'; }
    for(let i=0;i<60;i++) P.push(new Pt());
    let id;
    function draw(){
      if(!document.getElementById('v61Canvas')){ cancelAnimationFrame(id); return; }
      ctx.clearRect(0,0,W,H);
      P.forEach(p=>{ ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fillStyle=`rgba(${p.c},${p.a})`; ctx.fill(); p.x+=p.dx; p.y+=p.dy; if(p.x<0||p.x>W)p.dx*=-1; if(p.y<0||p.y>H)p.dy*=-1; });
      for(let i=0;i<P.length;i++) for(let j=i+1;j<P.length;j++){ const d=Math.hypot(P[i].x-P[j].x,P[i].y-P[j].y); if(d<120){ ctx.beginPath(); ctx.moveTo(P[i].x,P[i].y); ctx.lineTo(P[j].x,P[j].y); ctx.strokeStyle=`rgba(124,58,237,${0.06*(1-d/120)})`; ctx.lineWidth=0.5; ctx.stroke(); } }
      id=requestAnimationFrame(draw);
    }
    draw();
  }

  // CSS
  const s = document.createElement('style');
  s.id = 'v61-css';
  if(!document.getElementById('v61-css')) document.head.appendChild(s);
  s.textContent = `
.v61-home{min-height:100vh;background:#080818;color:#fff;direction:rtl;font-family:'Tajawal','Segoe UI',sans-serif;position:relative;overflow-x:hidden}
.v60-canvas{position:fixed;inset:0;pointer-events:none;z-index:0}
.v61-bg-gradient{position:fixed;inset:0;background:radial-gradient(ellipse at 20% 50%,rgba(124,58,237,0.12) 0%,transparent 60%),radial-gradient(ellipse at 80% 20%,rgba(37,99,235,0.10) 0%,transparent 50%);pointer-events:none;z-index:0}

/* HERO */
.v61-hero{position:relative;z-index:1;min-height:100vh;display:flex;align-items:center;justify-content:space-between;gap:40px;padding:100px 6% 60px;max-width:1200px;margin:0 auto}
.v61-hero-content{flex:1;max-width:560px}
.v61-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(124,58,237,0.15);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;padding:8px 16px;border-radius:999px;font-size:13px;font-weight:600;margin-bottom:24px}
.v61-live-dot{width:8px;height:8px;background:#10b981;border-radius:50%;animation:v61Pulse 2s infinite;flex-shrink:0}
@keyframes v61Pulse{0%,100%{box-shadow:0 0 0 0 rgba(16,185,129,0.4)}50%{box-shadow:0 0 0 6px rgba(16,185,129,0)}}
.v61-h1{font-size:clamp(36px,5vw,58px);font-weight:900;line-height:1.15;margin:0 0 20px;letter-spacing:-1px}
.v61-gradient-text{background:linear-gradient(135deg,#a78bfa,#60a5fa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.v61-lead{color:rgba(255,255,255,0.55);font-size:17px;line-height:1.7;margin:0 0 32px}
.v61-actions{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:36px}
.v61-btn-primary{display:inline-flex;align-items:center;gap:8px;padding:0 28px;height:52px;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;border:none;border-radius:14px;font-size:16px;font-weight:700;font-family:inherit;cursor:pointer;box-shadow:0 8px 28px rgba(124,58,237,0.4);transition:all 0.25s}
.v61-btn-primary:hover{transform:translateY(-2px);box-shadow:0 14px 36px rgba(124,58,237,0.55)}
.v61-btn-ghost{padding:0 24px;height:52px;background:transparent;border:1px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.8);border-radius:14px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;transition:all 0.25s}
.v61-btn-ghost:hover{background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.3);color:#fff}
.v61-stats{display:flex;align-items:center;gap:16px}
.v61-stat{text-align:center}.v61-stat b{display:block;color:#fff;font-size:20px;font-weight:900}.v61-stat small{color:rgba(255,255,255,0.4);font-size:12px}
.v61-stat-div{width:1px;height:36px;background:rgba(255,255,255,0.1)}

/* PHONE */
.v61-phone{position:relative;flex-shrink:0;width:280px}
.v61-phone-glow{position:absolute;inset:-20px;background:radial-gradient(circle,rgba(124,58,237,0.2),transparent 70%);pointer-events:none}
.v61-phone-inner{background:rgba(255,255,255,0.06);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,0.1);border-radius:28px;padding:20px;display:flex;flex-direction:column;gap:10px;box-shadow:0 24px 60px rgba(0,0,0,0.4)}
.v61-phone-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.v61-phone-dot{width:10px;height:10px;background:#10b981;border-radius:50%}
.v61-phone-header span:nth-child(2){font-weight:900;flex:1}
.v61-phone-live{background:rgba(16,185,129,0.2);color:#10b981;font-size:11px;padding:2px 8px;border-radius:999px}
.v61-phone-search{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:10px 14px;color:rgba(255,255,255,0.4);font-size:13px}
.v61-phone-row{display:flex;align-items:center;gap:10px;padding:8px;background:rgba(255,255,255,0.04);border-radius:12px}
.v61-phone-avatar{width:36px;height:36px;background:linear-gradient(135deg,rgba(124,58,237,0.3),rgba(37,99,235,0.3));border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.v61-phone-row div{flex:1}.v61-phone-row b{display:block;font-size:13px}.v61-phone-row small{color:rgba(255,255,255,0.4);font-size:11px}
.v61-phone-btn{background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;border:none;border-radius:8px;padding:5px 12px;font-size:12px;font-family:inherit;cursor:pointer;flex-shrink:0}
.v61-phone-map{background:rgba(37,99,235,0.15);border:1px solid rgba(37,99,235,0.25);border-radius:12px;padding:10px 14px;color:#60a5fa;font-size:13px;text-align:center}

/* STRIP */
.v61-strip{position:relative;z-index:1;padding:24px 0;border-top:1px solid rgba(255,255,255,0.06);border-bottom:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);display:flex;align-items:center;gap:20px;overflow:hidden}
.v61-strip-label{flex-shrink:0;color:#ef4444;font-size:12px;font-weight:800;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);padding:4px 12px;border-radius:999px;margin-right:20px;margin-left:16px}
.v61-marquee{overflow:hidden;flex:1;direction:ltr}
.v61-track{display:flex;gap:10px;animation:v61Scroll 30s linear infinite;width:max-content;will-change:transform}
@keyframes v61Scroll{from{transform:translateX(0)}to{transform:translateX(-33.33%)}}
.v61-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:999px;color:rgba(255,255,255,0.7);font-size:13px;font-family:inherit;cursor:pointer;white-space:nowrap;transition:all 0.2s;flex-shrink:0;direction:rtl}
.v61-pill:hover{background:rgba(124,58,237,0.2);border-color:rgba(124,58,237,0.4);color:#fff}

/* SERVICES */
.v61-services{position:relative;z-index:1;padding:80px 6%;max-width:1200px;margin:0 auto}
.v61-section-head{text-align:center;margin-bottom:48px}
.v61-eyebrow{display:inline-block;background:linear-gradient(135deg,rgba(124,58,237,0.2),rgba(37,99,235,0.2));border:1px solid rgba(124,58,237,0.3);color:#a78bfa;padding:5px 14px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:1px;margin-bottom:14px}
.v61-section-head h2{font-size:clamp(24px,3.5vw,38px);font-weight:900;margin:0 0 12px;letter-spacing:-0.5px}
.v61-section-head p{color:rgba(255,255,255,0.45);font-size:15px}
.v61-services-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:16px}
.v61-service-card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:24px 18px;text-align:center;cursor:pointer;transition:all 0.25s;font-family:inherit;color:#fff;display:flex;flex-direction:column;align-items:center;gap:10px;position:relative;overflow:hidden}
.v61-service-card::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(124,58,237,0),rgba(37,99,235,0));transition:0.3s}
.v61-service-card:hover{background:rgba(124,58,237,0.12);border-color:rgba(124,58,237,0.3);transform:translateY(-4px);box-shadow:0 16px 40px rgba(124,58,237,0.2)}
.v61-service-icon{font-size:36px;width:64px;height:64px;background:rgba(255,255,255,0.08);border-radius:18px;display:flex;align-items:center;justify-content:center}
.v61-service-card h3{font-size:15px;font-weight:700;margin:0}
.v61-service-card p{color:rgba(255,255,255,0.4);font-size:12px;margin:0;line-height:1.5}
.v61-service-cta{color:#7c3aed;font-size:12px;font-weight:700}

/* STEPS */
.v61-steps{position:relative;z-index:1;padding:60px 6%;max-width:900px;margin:0 auto}
.v61-steps-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:40px}
.v61-step{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:28px 22px;text-align:center}
.v61-step span{display:inline-block;font-size:32px;font-weight:900;background:linear-gradient(135deg,#7c3aed,#2563eb);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:10px}
.v61-step h3{font-size:17px;font-weight:700;margin:0 0 8px}
.v61-step p{color:rgba(255,255,255,0.4);font-size:13px;margin:0;line-height:1.6}

/* CTA */
.v61-cta{position:relative;z-index:1;padding:60px 6% 100px}
.v61-cta-card{max-width:680px;margin:0 auto;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.25);border-radius:28px;padding:48px 40px;text-align:center;position:relative;overflow:hidden}
.v61-cta-glow{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:300px;height:300px;background:radial-gradient(circle,rgba(124,58,237,0.2),transparent 70%);pointer-events:none}
.v61-cta-card h2{font-size:clamp(22px,3vw,32px);font-weight:900;margin:12px 0 14px}
.v61-cta-card p{color:rgba(255,255,255,0.5);font-size:15px;margin:0 0 28px}
.v61-cta-card .v61-btn-primary{margin:0 auto}

/* Responsive */
@media(max-width:900px){.v61-hero{flex-direction:column;padding:100px 5% 48px;text-align:center}.v61-hero-content{max-width:100%}.v61-phone{width:100%;max-width:320px}.v61-actions{justify-content:center}.v61-stats{justify-content:center}}
@media(max-width:600px){.v61-steps-grid{grid-template-columns:1fr}.v61-services-grid{grid-template-columns:repeat(2,1fr)}.v61-cta-card{padding:32px 20px}}
`;

})();



// ── V60: Premium Login — Stripe/Vercel level ──
;(function(){

login = function(){
  state.tab = 'dash';
  document.body.classList.remove('dashboard-mode','v37-dashboard','sidebar-open','open');

  app.innerHTML = `
  <div class="v60-page" id="v60Page">

    <!-- Floating particles canvas -->
    <canvas class="v60-canvas" id="v60Canvas"></canvas>

    <!-- Video background -->
    <video class="v60-video" id="v60Video" autoplay muted loop playsinline>
      <source src="/videos/login.mp4" type="video/mp4">
    </video>
    <div class="v60-overlay"></div>

    <!-- Content -->
    <div class="v60-wrap">

      <!-- Logo -->
      <div class="v60-brand">
        <div class="v60-brand-icon">
          <img src="/logo.png" alt="صلّحلي" onerror="this.parentNode.innerHTML='🔧'">
        </div>
        <span class="v60-brand-name">صلّحلي</span>
      </div>

      <!-- Glass card -->
      <div class="v60-card" id="v60Card">

        <!-- Glow ring -->
        <div class="v60-glow"></div>

        <!-- Header -->
        <div class="v60-head">
          <h1 class="v60-title">أهلاً بك في صلّحلي</h1>
          <p class="v60-sub">منصة الصيانة المنزلية الأولى في الأردن</p>
        </div>

        <!-- Error box -->
        <div class="v60-error" id="v60Error" style="display:none">
          <span class="v60-error-icon">⚠️</span>
          <span id="v60ErrorMsg"></span>
        </div>

        <!-- Form -->
        <form class="v60-form" onsubmit="v60DoLogin(event)" novalidate>

          <div class="v60-field">
            <label class="v60-label">البريد الإلكتروني</label>
            <div class="v60-input-wrap">
              <svg class="v60-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 7 10-7"/></svg>
              <input id="v60Email" class="v60-input" type="email" autocomplete="email"
                placeholder="example@email.com" required
                oninput="v60ClearError()">
            </div>
          </div>

          <div class="v60-field">
            <div class="v60-label-row">
              <label class="v60-label">كلمة المرور</label>
              <a href="#" class="v60-forgot" onclick="toast('تواصل مع الإدارة لإعادة تعيين كلمة المرور');return false">نسيت كلمة المرور؟</a>
            </div>
            <div class="v60-input-wrap">
              <svg class="v60-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <input id="v60Pass" class="v60-input" type="password" autocomplete="current-password"
                placeholder="••••••••" required
                oninput="v60ClearError()">
              <button type="button" class="v60-eye" id="v60EyeBtn"
                onclick="v60TogglePass()" aria-label="إظهار كلمة المرور">
                <svg id="v60EyeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>
          </div>

          <button class="v60-btn" type="submit" id="v60Btn">
            <span id="v60BtnText">تسجيل الدخول</span>
            <svg id="v60Spinner" class="v60-spinner" style="display:none" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" stroke-width="3"/>
              <path d="M12 2a10 10 0 0 1 10 10" stroke="white" stroke-width="3" stroke-linecap="round"/>
            </svg>
            <svg id="v60Arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>

        </form>

        <div class="v60-divider"><span>أو</span></div>

        <button class="v60-secondary" onclick="register('customer')">
          إنشاء حساب جديد
        </button>

        <p class="v60-hint">🔐 حساب الإدارة يُضبط من السيرفر فقط</p>

      </div><!-- /card -->

      <!-- Trust badges -->
      <div class="v60-trust">
        <span>🔒 اتصال آمن</span>
        <span>⚡ خدمة فورية</span>
        <span>🏆 فنيون موثوقون</span>
      </div>

    </div><!-- /wrap -->
  </div>`;

  // Start particles
  v60Particles();
  // Card entrance animation
  requestAnimationFrame(()=>{
    const card = document.getElementById('v60Card');
    if(card){ card.style.opacity='0'; card.style.transform='translateY(30px) scale(0.97)';
      setTimeout(()=>{ card.style.transition='all 0.7s cubic-bezier(0.22,1,0.36,1)';
        card.style.opacity='1'; card.style.transform='translateY(0) scale(1)'; }, 50);
    }
    const brand = document.querySelector('.v60-brand');
    if(brand){ brand.style.opacity='0'; brand.style.transform='translateY(-20px)';
      setTimeout(()=>{ brand.style.transition='all 0.6s cubic-bezier(0.22,1,0.36,1)';
        brand.style.opacity='1'; brand.style.transform='translateY(0)'; }, 0);
    }
  });
};

window.v60ClearError = function(){
  const e = document.getElementById('v60Error');
  if(e) e.style.display = 'none';
};

window.v60TogglePass = function(){
  const inp = document.getElementById('v60Pass');
  const icon = document.getElementById('v60EyeIcon');
  if(!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  if(icon) icon.innerHTML = show
    ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
    : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
};

window.v60DoLogin = async function(e){
  e.preventDefault();
  const emailVal = (document.getElementById('v60Email')?.value || '').trim();
  const passVal  = document.getElementById('v60Pass')?.value || '';
  const btn      = document.getElementById('v60Btn');
  const btnText  = document.getElementById('v60BtnText');
  const spinner  = document.getElementById('v60Spinner');
  const arrow    = document.getElementById('v60Arrow');
  const errBox   = document.getElementById('v60Error');
  const errMsg   = document.getElementById('v60ErrorMsg');

  if(!emailVal || !passVal){
    if(errBox && errMsg){ errMsg.textContent='يرجى تعبئة جميع الحقول'; errBox.style.display='flex'; }
    return;
  }

  // Loading state
  if(btn) btn.disabled = true;
  if(btnText) btnText.textContent = 'جاري تسجيل الدخول...';
  if(spinner) spinner.style.display = 'block';
  if(arrow)   arrow.style.display   = 'none';

  try{
    const j = await api('/api/auth/login',{
      method:'POST',
      body: JSON.stringify({ email: emailVal, password: passVal })
    });
    state.user = j.user;
    // Success animation
    if(btn){ btn.style.background = 'linear-gradient(135deg,#059669,#10b981)'; }
    if(btnText) btnText.textContent = '✓ تم تسجيل الدخول';
    setTimeout(()=>{ toast?.('مرحباً ' + (j.user?.name||'') + ' 👋'); dashboard(); }, 400);
  } catch(err){
    if(errBox && errMsg){
      errMsg.textContent = err.message || 'بيانات غير صحيحة';
      errBox.style.display = 'flex';
      // Shake animation
      const card = document.getElementById('v60Card');
      if(card){ card.style.animation='v60Shake 0.4s ease'; setTimeout(()=>card.style.animation='',400); }
    }
    if(btn) btn.disabled = false;
    if(btnText) btnText.textContent = 'تسجيل الدخول';
    if(spinner) spinner.style.display = 'none';
    if(arrow)   arrow.style.display   = 'block';
    if(btn) btn.style.background = '';
  }
};

// Also override doLogin to use v60 error box if on login page
const __v60OldDoLogin = window.doLogin;
window.doLogin = async function(e){
  if(document.getElementById('v60Email')) return v60DoLogin(e);
  if(typeof __v60OldDoLogin === 'function') return __v60OldDoLogin(e);
};

// Floating particles
function v60Particles(){
  const canvas = document.getElementById('v60Canvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];

  function resize(){ W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);

  function Particle(){
    this.x = Math.random() * W;
    this.y = Math.random() * H;
    this.r = Math.random() * 2 + 0.5;
    this.dx = (Math.random() - 0.5) * 0.4;
    this.dy = (Math.random() - 0.5) * 0.4;
    this.alpha = Math.random() * 0.5 + 0.1;
    this.color = Math.random() > 0.5 ? '124,58,237' : '37,99,235';
  }

  for(let i=0; i<80; i++) particles.push(new Particle());

  let animId;
  function draw(){
    if(!document.getElementById('v60Canvas')){ cancelAnimationFrame(animId); return; }
    ctx.clearRect(0,0,W,H);
    particles.forEach(p=>{
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      ctx.fillStyle = `rgba(${p.color},${p.alpha})`;
      ctx.fill();
      p.x += p.dx; p.y += p.dy;
      if(p.x<0||p.x>W) p.dx*=-1;
      if(p.y<0||p.y>H) p.dy*=-1;
    });
    // Draw connections
    for(let i=0; i<particles.length; i++){
      for(let j=i+1; j<particles.length; j++){
        const dist = Math.hypot(particles[i].x-particles[j].x, particles[i].y-particles[j].y);
        if(dist < 100){
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(124,58,237,${0.08*(1-dist/100)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
    animId = requestAnimationFrame(draw);
  }
  draw();
}

// CSS
const st = document.createElement('style');
st.id = 'v60-login-css';
if(!document.getElementById('v60-login-css')) document.head.appendChild(st);
st.textContent = `
.v60-page{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;overflow:hidden;background:#080818;direction:rtl;font-family:'Tajawal','Segoe UI',sans-serif}
.v60-canvas{position:fixed;inset:0;pointer-events:none;z-index:0}
.v60-video{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;opacity:0.35}
.v60-overlay{position:fixed;inset:0;z-index:2;background:linear-gradient(135deg,rgba(8,8,24,0.75) 0%,rgba(15,10,40,0.65) 50%,rgba(8,8,24,0.80) 100%)}
.v60-wrap{position:relative;z-index:3;width:100%;max-width:460px;display:flex;flex-direction:column;align-items:center;gap:20px}
.v60-brand{display:flex;align-items:center;gap:12px;color:#fff;font-size:24px;font-weight:900;letter-spacing:-0.5px}
.v60-brand-icon{width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,#7c3aed,#2563eb);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 32px rgba(124,58,237,0.5);overflow:hidden}
.v60-brand-icon img{width:100%;height:100%;object-fit:cover;border-radius:inherit}
.v60-brand-name{background:linear-gradient(135deg,#a78bfa,#60a5fa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.v60-card{width:100%;padding:40px 36px;border-radius:28px;background:rgba(255,255,255,0.06);backdrop-filter:blur(32px);-webkit-backdrop-filter:blur(32px);border:1px solid rgba(255,255,255,0.1);box-shadow:0 32px 80px rgba(0,0,0,0.5),0 0 0 1px rgba(124,58,237,0.1),inset 0 1px 0 rgba(255,255,255,0.08);position:relative;overflow:hidden}
.v60-card::before{content:'';position:absolute;top:-50%;right:-50%;width:200%;height:200%;background:radial-gradient(ellipse at 70% 20%,rgba(124,58,237,0.08) 0%,transparent 60%);pointer-events:none}
.v60-glow{position:absolute;top:0;right:0;width:200px;height:200px;background:radial-gradient(circle,rgba(124,58,237,0.15),transparent 70%);pointer-events:none;border-radius:50%;transform:translate(30%,-30%)}
@supports not (backdrop-filter:blur(32px)){.v60-card{background:rgba(15,10,40,0.95)}}
.v60-head{text-align:center;margin-bottom:28px}
.v60-title{color:#fff;font-size:26px;font-weight:900;margin:0 0 8px;letter-spacing:-0.5px}
.v60-sub{color:rgba(255,255,255,0.5);font-size:14px;margin:0;line-height:1.6}
.v60-error{display:none;align-items:center;gap:10px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;border-radius:14px;padding:12px 16px;font-size:13px;margin-bottom:20px;animation:v60FadeIn 0.3s ease}
.v60-error-icon{font-size:16px;flex-shrink:0}
.v60-form{display:flex;flex-direction:column;gap:16px}
.v60-field{display:flex;flex-direction:column;gap:8px}
.v60-label-row{display:flex;justify-content:space-between;align-items:center}
.v60-label{color:rgba(255,255,255,0.8);font-size:13px;font-weight:700}
.v60-forgot{color:#60a5fa;font-size:12px;text-decoration:none;transition:color 0.2s}
.v60-forgot:hover{color:#a78bfa}
.v60-input-wrap{position:relative;display:flex;align-items:center}
.v60-ico{position:absolute;right:14px;width:17px;height:17px;color:rgba(255,255,255,0.35);pointer-events:none;flex-shrink:0}
.v60-input{width:100%;height:52px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:14px;color:#fff;padding:0 44px 0 48px;font-size:15px;font-family:inherit;outline:none;transition:all 0.25s;box-sizing:border-box;text-align:right}
.v60-input::placeholder{color:rgba(255,255,255,0.25);font-size:13px}
.v60-input:focus{border-color:#7c3aed;background:rgba(124,58,237,0.1);box-shadow:0 0 0 4px rgba(124,58,237,0.15)}
.v60-input:hover:not(:focus){border-color:rgba(255,255,255,0.2)}
.v60-eye{position:absolute;left:12px;background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.4);padding:6px;display:flex;align-items:center;justify-content:center;border-radius:8px;transition:all 0.2s}
.v60-eye:hover{color:#a78bfa;background:rgba(124,58,237,0.15)}
.v60-btn{width:100%;height:54px;border:none;border-radius:16px;background:linear-gradient(135deg,#7c3aed 0%,#2563eb 100%);color:#fff;font-size:16px;font-weight:800;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;margin-top:6px;box-shadow:0 8px 28px rgba(124,58,237,0.4);transition:all 0.25s;position:relative;overflow:hidden}
.v60-btn::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,0.1),transparent);pointer-events:none}
.v60-btn:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 14px 36px rgba(124,58,237,0.55)}
.v60-btn:active:not(:disabled){transform:translateY(0)}
.v60-btn:disabled{opacity:0.75;cursor:not-allowed;transform:none}
.v60-spinner{animation:v60Spin 0.8s linear infinite;width:20px;height:20px}
@keyframes v60Spin{to{transform:rotate(360deg)}}
.v60-divider{display:flex;align-items:center;gap:12px;margin:20px 0;color:rgba(255,255,255,0.2);font-size:13px}
.v60-divider::before,.v60-divider::after{content:'';flex:1;height:1px;background:rgba(255,255,255,0.08)}
.v60-secondary{width:100%;height:50px;background:transparent;border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.75);border-radius:14px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;transition:all 0.25s}
.v60-secondary:hover{background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.2);color:#fff}
.v60-hint{text-align:center;font-size:12px;color:rgba(255,255,255,0.2);margin:16px 0 0}
.v60-trust{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}
.v60-trust span{color:rgba(255,255,255,0.3);font-size:12px;display:flex;align-items:center;gap:4px}
@keyframes v60FadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
@keyframes v60Shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}
@media(max-width:520px){.v60-card{padding:28px 20px;border-radius:22px}.v60-title{font-size:22px}.v60-trust{gap:10px}}
`;

})();
