const $ = (id) => document.getElementById(id);
const stages = ['GENERATE CHALLENGE','EXECUTE OPERATOR','MEASURE PERFORMANCE','EVALUATE RESULTS','PROPOSE IMPROVEMENT','TEST CANDIDATE','ACCEPT OR REJECT','NEXT EPOCH'];
const appState = { history: [], port: null, highlight: null, scenario: null };

$('stageTrack').innerHTML = stages.map((s,i)=>`<div class="stage" data-n="${i+1}">${i+1}. ${s}</div>`).join('');

function status(el, value){
  const node=$(el); const v=String(value||'waiting').toLowerCase();
  node.textContent=v.toUpperCase(); node.className=`agent-status ${v}`;
}
function metric(v, unit=''){ return v == null ? '—' : `${Number(v).toFixed(1)}${unit}`; }
function metrics(baseline, best){
  const rows=[
    ['Avg. vessel turnaround',metric(baseline?.average_turnaround_time,' min'),metric(best?.average_turnaround_time,' min')],
    ['Avg. vessel waiting',metric(baseline?.average_waiting_time,' min'),metric(best?.average_waiting_time,' min')],
    ['Crane utilization',metric(baseline?.crane_utilization,'%'),metric(best?.crane_utilization,'%')],
    ['Completed vessels',baseline?`${baseline.completed_vessels}/${baseline.total_vessels}`:'—',best?`${best.completed_vessels}/${best.total_vessels}`:'—'],
    ['Improvement over baseline','0.0%',metric(best?.improvement_percentage,'%')],
  ];
  $('metricRows').innerHTML=`<div class="metric-row metric-head"><span>METRIC</span><span>BASELINE</span><span>BEST AI</span></div>`+rows.map(r=>`<div class="metric-row"><span>${r[0]}</span><strong>${r[1]}</strong><strong>${r[2]}</strong></div>`).join('');
}
function renderState(s){
  $('epoch').textContent=String(s.epoch||0).padStart(2,'0');
  $('runStatus').textContent=(s.status||'idle').toUpperCase();
  $('modelBadge').textContent=s.agent_mode==='argon'?'ARGON LIVE':'MOCK MODE';
  $('modelBadge').className=`chip ${s.agent_mode==='argon'?'':'amber'}`;
  status('operatorStatus',s.operator?.status); status('evaluatorStatus',s.evaluator?.status);
  const strategy=s.operator?.strategy;
  if(strategy){$('strategyName').textContent=strategy.label;$('strategyVersion').textContent=`VERSION ${String(strategy.version).padStart(2,'0')}`;}
  const d=s.operator?.latest_decision;
  if(d){
    $('berthDecision').textContent=d.berth_assignments?.map(x=>`${x.ship_id} → ${x.berth_id}`).join(', ')||'No berth change';
    $('craneDecision').textContent=d.crane_assignments?.map(x=>`${x.ship_id}: ${x.crane_ids.join(' + ')}`).join(', ')||'No crane change';
    $('operatorReason').textContent=d.reasoning_summary||'—';
  }
  const sc=s.evaluator?.scenario;
  if(sc){$('scenarioName').textContent=sc.name;$('scenarioSeed').textContent=`FIXED SEED ${sc.seed}`;appState.scenario=sc;}
  $('weakness').textContent=s.evaluator?.feedback||'—'; $('proposal').textContent=s.evaluator?.proposal||'—';
  if(s.history) appState.history=s.history;
  if(s.port) appState.port=s.port;
  setStage(s.stage||0,s.progress||0);
  metrics(s.baseline_metrics,s.best_metrics);
  timeline(); chart(); drawPort();
}
function setStage(i,progress){
  document.querySelectorAll('.stage').forEach((el,n)=>el.className=`stage ${n<i?'done':n===i?'active':''}`);
  $('stageLabel').textContent=stages[i]||'READY TO OPTIMIZE'; $('progressLabel').textContent=`${progress}%`; $('progressBar').style.width=`${progress}%`;
}
function timeline(){
  $('historyCount').textContent=`${appState.history.length} COMPLETE`;
  if(!appState.history.length){$('timeline').innerHTML='<p class="empty">Completed experiments will appear here.</p>';return;}
  $('timeline').innerHTML=[...appState.history].reverse().map(r=>{
    const before=r.previous_metrics.average_turnaround_time, after=r.candidate_metrics.average_turnaround_time;
    const delta=((before-after)/before*100).toFixed(1);
    return `<div class="epoch-card"><div class="epoch-num">EPOCH ${String(r.epoch).padStart(2,'0')}</div><div><h3>${r.scenario.name}</h3><p><b>Strategy:</b> ${r.operator_strategy.label}</p><p><b>Evaluator:</b> ${r.evaluator_feedback}</p><p><b>Change:</b> ${r.proposed_modification}</p><p><b>Result:</b> ${before.toFixed(1)} → ${after.toFixed(1)} min (${delta}% change)</p></div><span class="verdict ${r.accepted?'':'rejected'}">${r.accepted?'ACCEPTED':'REJECTED'}</span></div>`;
  }).join('');
}
function chart(){
  const svg=$('chart'), rows=appState.history;
  svg.innerHTML='';
  const W=700,H=260,p={l:52,r:18,t:18,b:34};
  const vals=rows.flatMap(r=>[r.baseline_metrics.average_turnaround_time,r.candidate_metrics.average_turnaround_time,r.strategy_after? r.candidate_metrics.average_turnaround_time:0]).filter(Boolean);
  const min=vals.length?Math.floor(Math.min(...vals)*.85):100,max=vals.length?Math.ceil(Math.max(...vals)*1.08):300;
  const x=i=>p.l+(i/(Math.max(rows.length-1,1)))*(W-p.l-p.r), y=v=>p.t+(max-v)/(max-min)*(H-p.t-p.b);
  let html='';
  for(let i=0;i<5;i++){const v=max-(max-min)*i/4,yy=y(v);html+=`<line class="chart-grid" x1="${p.l}" y1="${yy}" x2="${W-p.r}" y2="${yy}"/><text class="chart-label" x="3" y="${yy+3}">${v.toFixed(0)}m</text>`;}
  if(!rows.length) html+=`<text class="chart-label" x="265" y="130">NO COMPLETED EPOCHS</text>`;
  const path=(values,color,dash='')=>values.length?`<path d="${values.map((v,i)=>`${i?'L':'M'} ${x(i)} ${y(v)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" ${dash}/>`:'';
  const baseline=rows.map(r=>r.baseline_metrics.average_turnaround_time), candidate=rows.map(r=>r.candidate_metrics.average_turnaround_time);
  let best=Infinity; const bests=rows.map(r=>{if(r.accepted)best=Math.min(best,r.candidate_metrics.average_turnaround_time);if(!isFinite(best))best=r.previous_metrics.average_turnaround_time;return best;});
  html+=path(baseline,'#66777a','stroke-dasharray="5 5"')+path(candidate,'#f5c453')+path(bests,'#35e0c1');
  rows.forEach((r,i)=>{html+=`<circle cx="${x(i)}" cy="${y(candidate[i])}" r="3" fill="#f5c453"/><text class="chart-label" x="${x(i)-3}" y="245">${r.epoch}</text>`;});
  svg.innerHTML=html;
}
function addFeed(type,payload){
  const labels={epoch_started:`Epoch ${payload.epoch} started`,evaluator_challenge:`Evaluator created ${payload.scenario?.name}`,operator_decision:'Operator completed a scheduling run',metrics_updated:`Simulation measured ${payload.average_turnaround_time} min turnaround`,strategy_proposed:`Strategy V${payload.version} proposed`,strategy_accepted:`Strategy V${payload.strategy?.version} accepted`,strategy_rejected:`Strategy V${payload.strategy?.version} rejected`,epoch_completed:`Epoch ${payload.epoch} completed`,agent_error:`${payload.agent}: ${payload.message}`,optimization_completed:'Optimization run completed'};
  if(!labels[type])return; const time=new Date().toLocaleTimeString([],{hour12:false});
  const feed=$('feed'); if(feed.querySelector('.empty'))feed.innerHTML='';
  feed.insertAdjacentHTML('afterbegin',`<div class="feed-item"><time>${time}</time><span>${labels[type]}</span></div>`);
  while(feed.children.length>25)feed.lastChild.remove();
}
function handle(event){
  const p=event.payload||{}; addFeed(event.type,p);
  if(event.type==='snapshot')return renderState(p);
  if(event.type==='loop_stage')setStage(p.stage,p.progress);
  if(event.type==='epoch_started'){$('epoch').textContent=String(p.epoch).padStart(2,'0');$('runStatus').textContent='RUNNING';}
  if(event.type==='agent_status')status(`${p.agent}Status`,p.status);
  if(event.type==='evaluator_challenge'){$('scenarioName').textContent=p.scenario.name;$('scenarioSeed').textContent=`FIXED SEED ${p.scenario.seed}`;appState.scenario=p.scenario;drawPort();}
  if(event.type==='evaluator_feedback'){$('weakness').textContent=p.weakness;$('proposal').textContent=p.suggestion;status('evaluatorStatus','evaluating');}
  if(event.type==='operator_decision'){
    const d=p.decision||{}; appState.highlight=d; status('operatorStatus','executing');
    $('berthDecision').textContent=d.berth_assignments?.map(x=>`${x.ship_id} → ${x.berth_id}`).join(', ')||'No berth change';
    $('craneDecision').textContent=d.crane_assignments?.map(x=>x.crane_ids.join(' + ')).join(', ')||'No crane change';$('operatorReason').textContent=d.reasoning_summary||'—';drawPort();
  }
  if(event.type==='strategy_accepted'||event.type==='strategy_rejected')$('latestResult').textContent=event.type==='strategy_accepted'?'Accepted — benchmark improved':'Rejected — incumbent retained';
  if(event.type==='simulation_state'){appState.port=p;drawPort();}
  if(event.type==='epoch_completed'){appState.history.push(p);timeline();chart();fetchState();}
  if(event.type==='optimization_completed'){$('runStatus').textContent='COMPLETED';status('operatorStatus','completed');status('evaluatorStatus','completed');}
}

const canvas=$('portCanvas'),ctx=canvas.getContext('2d');
function resize(){const dpr=devicePixelRatio||1,rect=canvas.getBoundingClientRect();canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);drawPort();}
function iso(x,y,z=0){const w=canvas.clientWidth,h=canvas.clientHeight;return [w*.48+(x-y)*.72,h*.16+(x+y)*.29-z];}
function poly(points,fill,stroke){ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.stroke();}}
function box(x,y,w,d,h,color){const a=iso(x,y),b=iso(x+w,y),c=iso(x+w,y+d),e=iso(x,y+d),at=iso(x,y,h),bt=iso(x+w,y,h),ct=iso(x+w,y+d,h),et=iso(x,y+d,h);poly([at,bt,ct,et],color,'#ffffff18');poly([b,c,ct,bt],'#07101388');poly([c,e,et,ct],'#050a0c99');}
function drawPort(){
  const W=canvas.clientWidth,H=canvas.clientHeight;if(!W)return;ctx.clearRect(0,0,W,H);
  const grad=ctx.createLinearGradient(0,0,0,H);grad.addColorStop(0,'#153941');grad.addColorStop(1,'#071b22');ctx.fillStyle=grad;ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#58aebb14';for(let i=-H;i<W+H;i+=34){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i-H,H);ctx.stroke();}
  box(-235,18,475,125,10,'#26383a');
  const berths=appState.port?.berths||['B1','B2','B3','B4'].map(id=>({id,closed:appState.scenario?.closed_berths?.includes(id),vessel_id:null}));
  berths.forEach((b,i)=>{
    const x=-215+i*112,active=appState.highlight?.berth_assignments?.some(a=>a.berth_id===b.id);box(x,33,95,92,13,b.closed?'#532f35':active?'#286a64':'#34494b');
    const p=iso(x+7,46,16);ctx.font='10px Space Mono';ctx.fillStyle=b.closed?'#ef6b6b':active?'#35e0c1':'#8ba2a3';ctx.fillText(b.id+(b.closed?' · CLOSED':''),...p);
  });
  const vessels=appState.port?.vessels||[];
  vessels.filter(v=>v.status!=='completed').slice(0,10).forEach((v,i)=>{
    const bi=berths.findIndex(b=>b.id===v.berth_id),x=bi>=0?-205+bi*112:-265-(i%3)*60,y=bi>=0?58:175+(i%4)*35;
    const active=appState.highlight?.berth_assignments?.some(a=>a.ship_id===v.id);box(x,y,74,24,12,active?'#a77bf3':'#e3e9e6');
    const p=iso(x+12,y+5,17);ctx.fillStyle=active?'#d8c4ff':'#a9c7c4';ctx.font='8px Space Mono';ctx.fillText(v.id,...p);
  });
  const cranes=appState.port?.cranes||['C1','C2','C3','C4','C5','C6'].map(id=>({id,disabled:appState.scenario?.disabled_cranes?.includes(id)}));
  cranes.forEach((c,i)=>{const x=-220+i*74,y=15,p=iso(x,y,22),active=appState.highlight?.crane_assignments?.some(a=>a.crane_ids.includes(c.id));ctx.strokeStyle=c.disabled?'#ef6b6b':active?'#a77bf3':'#35e0c1';ctx.lineWidth=active?3:2;ctx.beginPath();ctx.moveTo(...p);ctx.lineTo(...iso(x,y,72));ctx.lineTo(...iso(x+35,y+8,72));ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.font='8px Space Mono';ctx.fillText(c.id,p[0]-4,p[1]+13);});
  const now=appState.port?.simulation_time||0;$('simTime').textContent=`${String(Math.floor(now/60)).padStart(2,'0')}:${String(now%60).padStart(2,'0')}`;
}
async function api(path){const r=await fetch(path,{method:'POST'});if(!r.ok)throw new Error(await r.text());return r.json();}
async function fetchState(){const r=await fetch('/api/state');renderState(await r.json());}
$('startBtn').onclick=()=>api('/api/optimization/start?epochs=8');
$('pauseBtn').onclick=async()=>{const paused=$('runStatus').textContent==='PAUSED';await api(paused?'/api/optimization/resume':'/api/optimization/pause');$('runStatus').textContent=paused?'RUNNING':'PAUSED';$('pauseBtn').textContent=paused?'Ⅱ Pause':'▶ Resume';};
$('resetBtn').onclick=()=>api('/api/optimization/reset').then(fetchState);
function connect(){const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/events`);ws.onmessage=e=>handle(JSON.parse(e.data));ws.onclose=()=>setTimeout(connect,1200);const ping=setInterval(()=>{if(ws.readyState===1)ws.send('ping');else clearInterval(ping)},15000);}
window.addEventListener('resize',resize);resize();metrics(null,null);chart();connect();
