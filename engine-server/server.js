// BTC FlowDesk PRO independent PAPER engine (REST polling, server-side)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ENGINE_API_TOKEN = process.env.ENGINE_API_TOKEN || '';
const PORT = Number(process.env.PORT || 3002);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DELTA_URL = 'https://api.india.delta.exchange/v2/tickers?contract_types=call_options,put_options&underlying_asset_symbols=BTC';
const POLL_MS = 5000, ENGINE_MS = 1000, FRESH_MS = 12000;
fs.mkdirSync(DATA_DIR, { recursive: true });

const defaults = { enabled:false, quantity:1, decayPct:20, risePct:7, takeProfitPct:50, stopLossMultiple:2, feeRate:0, globalLoss:0, globalProfit:0, expiryKey:'' };
let state = { config:{...defaults}, position:null, realized:0, journal:[], locked:false, lastFeedAt:0, lastFeedError:'', spot:null, tickers:[], expiries:[] };
function load(){ try { const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); state={...state,...s,config:{...defaults,...s.config}}; } catch{} }
function save(){ const tmp=STATE_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,STATE_FILE); }
function num(v){const n=Number(v);return Number.isFinite(n)?n:NaN}
function strike(o){let n=num(o.strike_price??o.strike);if(Number.isFinite(n))return n;const m=String(o.symbol||'').match(/^[CP]-BTC-(\d+(?:\.\d+)?)-/);return m?Number(m[1]):NaN}
function type(o){const s=String(o.contract_type||o.symbol||'').toLowerCase();return s.includes('put')||s.startsWith('p-btc-')?'put':s.includes('call')||s.startsWith('c-btc-')?'call':''}
function bid(o){return num(o?.quotes?.best_bid)} function ask(o){return num(o?.quotes?.best_ask)}
function quoteFresh(o){return o && Number(o._receivedAt)>0 && Date.now()-o._receivedAt<=FRESH_MS && bid(o)>0 && ask(o)>0 && ask(o)>=bid(o)}
function expiry(o){return o.expiry_date||o.expiry||o.contract_expiry}
function expiries(){const all=[...new Set(state.tickers.map(expiry).filter(Boolean))].sort();return all}
function selectedExpiry(){const list=expiries();if(state.config.expiryKey&&list.includes(state.config.expiryKey))return state.config.expiryKey;return list[0]||''}
function choosePair(expKey=selectedExpiry()){
 const spot=num(state.spot);if(!(spot>0))return null;
 const list=state.tickers.filter(o=>String(expiry(o)??'')===String(expKey??'')&&quoteFresh(o));
 const puts=list.map(o=>({o,k:strike(o),d:(spot-strike(o))/spot})).filter(x=>type(x.o)==='put'&&Number.isFinite(x.k)&&x.k<spot&&x.d>=.05&&x.d<=.09);
 const calls=list.map(o=>({o,k:strike(o),d:(strike(o)-spot)/spot})).filter(x=>type(x.o)==='call'&&Number.isFinite(x.k)&&x.k>spot&&x.d>=.05&&x.d<=.09);
 let best=null;
 for(const p of puts)for(const c of calls){
  const pb=bid(p.o),cb=bid(c.o);if(!(pb>0&&cb>0))continue;
  const avg=(pb+cb)/2,score=Math.abs(pb-cb)/Math.max(avg,1e-9),td=Math.abs(p.d*100-7)+Math.abs(c.d*100-7);
  if(!best||score<best.score-1e-9||(Math.abs(score-best.score)<1e-9&&td<best.td))best={p:p.o,c:c.o,score,td};
 }
 return best;
}
function getQuote(symbol){return state.tickers.find(o=>o.symbol===symbol)}
function pnl(){if(!state.position)return null;let gross=0,fees=0;for(const l of state.position.legs){const o=getQuote(l.symbol);if(!quoteFresh(o))return null;gross+=(l.entry-ask(o))*state.position.qty;fees+=(l.entry+ask(o))*state.position.qty*state.config.feeRate;}return {gross,fees,net:gross-fees}}
function writeJournal(action,leg,exitPrice=0,net=0){state.journal.unshift({time:new Date().toISOString(),action,side:leg.side,symbol:leg.symbol,entry:leg.entry,exit:exitPrice,qty:state.position?.qty||state.config.quantity,net});state.journal=state.journal.slice(0,1000)}
function openPosition(source='AUTO'){if(state.position||state.locked||!state.config.enabled)return false;const pair=choosePair();if(!pair)return false;const qty=Math.max(1,Math.floor(num(state.config.quantity)||1));state.position={qty,expiry:expiry(pair.p),expiryKey:expiry(pair.p),openedAt:Date.now(),credit:(bid(pair.p)+bid(pair.c))*qty,adjusting:false,legs:[{side:'SELL PE',symbol:pair.p.symbol,entry:bid(pair.p),entryAt:Date.now()},{side:'SELL CE',symbol:pair.c.symbol,entry:bid(pair.c),entryAt:Date.now()}]};for(const l of state.position.legs)writeJournal(source+' ENTRY',l,0,0);save();return true}
function closePosition(reason){if(!state.position)return false;const result=pnl();if(!result)return false;const old=state.position;for(const l of old.legs){const o=getQuote(l.symbol),ex=ask(o),net=(l.entry-ex)*old.qty-(l.entry+ex)*old.qty*state.config.feeRate;writeJournal(reason+' EXIT',l,ex,net)}state.realized+=result.net;state.position=null;save();return true}
function replacement(side,oldSymbol,target){const list=state.tickers.filter(o=>expiry(o)===state.position.expiryKey&&type(o)===(side==='SELL PE'?'put':'call')&&o.symbol!==oldSymbol&&quoteFresh(o));const candidates=list.filter(o=>{const k=strike(o);return side==='SELL PE'?k<state.spot&&(state.spot-k)/state.spot>=.05&&(state.spot-k)/state.spot<=.09:k>state.spot&&(k-state.spot)/state.spot>=.05&&(k-state.spot)/state.spot<=.09});let best=null;for(const o of candidates){const b=bid(o),score=Math.abs(b-target)/Math.max(target,1e-9),td=Math.abs(Math.abs(strike(o)-state.spot)/state.spot*100-7);if(b>0&&(!best||score<best.score-1e-9||(Math.abs(score-best.score)<1e-9&&td<best.td)))best={o,b,score,td}}return best}
function decayCheck(){const pos=state.position,cfg=state.config;if(!pos||!cfg.enabled||pos.adjusting||pos.legs.length!==2)return;for(const leg of [...pos.legs]){const other=pos.legs.find(x=>x!==leg),o=getQuote(leg.symbol),oo=getQuote(other.symbol);if(!quoteFresh(o)||!quoteFresh(oo))continue;const decay=ask(o)<=leg.entry*(1-cfg.decayPct/100),rise=ask(oo)>=other.entry*(1+cfg.risePct/100);if(decay&&rise){const target=bid(oo),rep=replacement(leg.side,leg.symbol,target);if(!rep)continue;pos.adjusting=true;const exit=ask(o),net=(leg.entry-exit)*pos.qty-(leg.entry+exit)*pos.qty*cfg.feeRate;state.realized+=net;writeJournal('DECAY PROFIT BOOK',leg,exit,net);pos.legs=pos.legs.filter(x=>x!==leg);pos.legs.push({side:leg.side,symbol:rep.o.symbol,entry:rep.b,entryAt:Date.now()});pos.credit+=rep.b*pos.qty;writeJournal('REPLACEMENT ENTRY',pos.legs[pos.legs.length-1],0,0);pos.adjusting=false;save();break;}}
}
function riskChecks(){const cfg=state.config;if(!state.position)return;const r=pnl();if(!r)return;if(cfg.takeProfitPct>0&&r.net>=state.position.credit*cfg.takeProfitPct/100){closePosition('TAKE PROFIT');return;}if(cfg.stopLossMultiple>0&&r.net<=-state.position.credit*cfg.stopLossMultiple){closePosition('COMBINED STOP LOSS');return;}if(cfg.globalProfit>0&&state.realized+r.net>=cfg.globalProfit){state.locked=true;cfg.enabled=false;closePosition('GLOBAL PROFIT SHUTDOWN');save();return;}if(cfg.globalLoss>0&&state.realized+r.net<=-cfg.globalLoss){state.locked=true;cfg.enabled=false;closePosition('GLOBAL LOSS SHUTDOWN');save();}}
let refreshInFlight=false;
async function refresh(){if(refreshInFlight)return;refreshInFlight=true;try{const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);let res;try{res=await fetch(DELTA_URL,{cache:'no-store',signal:ctrl.signal,headers:{Accept:'application/json'}})}finally{clearTimeout(timer)}if(!res.ok)throw Error('Delta API HTTP '+res.status);const json=await res.json();if(!json.success||!Array.isArray(json.result))throw Error('Ticker response invalid');const now=Date.now();state.tickers=json.result.map(o=>({...o,_receivedAt:now}));const spotItem=state.tickers.find(o=>num(o.spot_price)>0);if(spotItem)state.spot=num(spotItem.spot_price);state.expiries=expiries();state.lastFeedAt=now;state.lastFeedError='';if(!state.config.expiryKey)state.config.expiryKey=selectedExpiry();save();}catch(e){state.lastFeedError=String(e.message||e);save()}finally{refreshInFlight=false}}
function engine(){if(!state.config.enabled||state.locked)return;if(!state.lastFeedAt||Date.now()-state.lastFeedAt>FRESH_MS)return;if(!state.position)openPosition();if(state.position){riskChecks();decayCheck();}}
load();
state.config.enabled=false; // Safe restart: recover state, require explicit re-enable
save();
const server=http.createServer((req,res)=>{const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Content-Type':'application/json'};if(req.method==='OPTIONS'){res.writeHead(204,cors);return res.end()}const send=(code,obj)=>{res.writeHead(code,cors);res.end(JSON.stringify(obj))};if(req.url.startsWith('/api/')&&(!ENGINE_API_TOKEN||req.headers.authorization!=='Bearer '+ENGINE_API_TOKEN))return send(403,{error:'Engine API token required'});if(req.url==='/health')return send(200,{ok:true,uptime:process.uptime(),feedAge:state.lastFeedAt?Date.now()-state.lastFeedAt:null,feedError:state.lastFeedError});if(req.url==='/api/status')return send(200,{config:state.config,position:state.position,realized:state.realized,locked:state.locked,spot:state.spot,feedAge:state.lastFeedAt?Date.now()-state.lastFeedAt:null,feedError:state.lastFeedError,expiries:state.expiries,journal:state.journal.slice(0,100)});if(req.method==='POST'&&req.url==='/api/config'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{try{const update=JSON.parse(body);for(const k of Object.keys(defaults))if(k in update)state.config[k]=update[k];state.config.quantity=Math.max(1,Math.floor(num(state.config.quantity)||1));state.config.decayPct=Math.max(1,Math.min(99,num(state.config.decayPct)||20));state.config.risePct=Math.max(.1,Math.min(99,num(state.config.risePct)||7));save();send(200,{ok:true,config:state.config})}catch(e){send(400,{error:e.message})}});return}if(req.method==='POST'&&req.url==='/api/enable'){state.config.enabled=true;state.locked=false;save();return send(200,{ok:true,enabled:true})}if(req.method==='POST'&&req.url==='/api/disable'){state.config.enabled=false;save();return send(200,{ok:true,enabled:false})}if(req.method==='POST'&&req.url==='/api/exit'){const ok=closePosition('MANUAL EXIT');return send(ok?200:409,{ok,error:ok?'':'No fresh exit quotes or open position'})}send(404,{error:'not found'})});
server.listen(PORT,HOST,()=>console.log('FlowDesk Paper Engine listening at http://'+HOST+':'+PORT));
refresh();setInterval(refresh,POLL_MS);setInterval(engine,ENGINE_MS);
process.on('SIGINT',()=>{state.config.enabled=false;save();server.close(()=>process.exit(0))});
process.on('SIGTERM',()=>{state.config.enabled=false;save();server.close(()=>process.exit(0))});
