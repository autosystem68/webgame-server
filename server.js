// ============================================================
// WEBGAME — MMORPG server-authoritative (Node + ws, single-file theo quy trình tablet-upload)
// 5 class · 8-12 skill/class (combo riêng) · world nhiều vùng · dungeon vé vào
// world boss lịch cố định · NPC/quest · party/guild/chat · loot/enchant/equip
// LƯU TRỮ THẬT: Postgres (Supabase) qua biến môi trường DATABASE_URL — xem hàm dbInit/dbLoad/dbSave
// Chạy:  npm install ws pg   →   node server.js
// ============================================================
const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const dbPool = process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}}) : null;
const W = 800, H = 600, SPD = 250;
// ---- VÙNG BẢN ĐỒ (world nhiều vùng + thị trấn an toàn) ----
const ZONES = {
  town:   {name:'🏘️ Thị Trấn An Bình', w:900,  h:700,  safe:true,  bg:'#1a2318',
    portals:[ {x:820,y:350,r:44,to:'forest',tx:80,ty:500,label:'→ Rừng Ma'},
              {x:80, y:350,r:44,to:'cave',  tx:700,ty:500,label:'→ Hang Băng'},
              {x:450,y:660,r:44,to:'dungeon',tx:120,ty:475,label:'🎫 Mật Thất Cổ (vé)'} ]},
  forest: {name:'🌲 Rừng Ma', w:1500, h:1100, safe:false, bg:'#14100c', tier:1,
    portals:[ {x:40,y:550,r:44,to:'town',tx:760,ty:350,label:'→ Thị Trấn'},
              {x:1440,y:1040,r:44,to:'swamp',tx:120,ty:120,label:'→ Đầm Lầy Nấm Độc'} ]},
  cave:   {name:'❄️ Hang Băng', w:1500, h:1100, safe:false, bg:'#0d1520', tier:2,
    portals:[ {x:1460,y:550,r:44,to:'town',tx:140,ty:350,label:'→ Thị Trấn'} ]},
  dungeon:{name:'🏚️ Mật Thất Cổ', w:1300, h:950, safe:false, bg:'#1a0f1a', tier:3,
    portals:[ {x:40,y:475,r:44,to:'town',tx:400,ty:600,label:'→ Thị Trấn'} ]},
  swamp:  {name:'🍄 Đầm Lầy Nấm Độc', w:1600, h:1200, safe:false, bg:'#0f140f', tier:4,
    portals:[ {x:80,y:80,r:44,to:'forest',tx:1400,ty:1000,label:'→ Rừng Ma'} ]},
};
function zoneOf(p){ return ZONES[p.zone]||ZONES.town; }

// ---- ĐỆ TỬ (PET) — săn từ Boss Thế Giới (Ngọc Rồng), mỗi loại 1 kỹ năng riêng không trùng (Hiệp Sĩ) ----
const PET_TYPES = [
  {id:'wolf',  name:'Sói Hoang',   icon:'🐺', hue:20,  effect:'lifesteal', desc:'Đòn đánh hồi máu cho chủ nhân'},
  {id:'scorp', name:'Bọ Cạp Độc',  icon:'🦂', hue:280, effect:'poison',    desc:'Đòn đánh gây độc, mất máu theo thời gian'},
  {id:'owl',   name:'Cú Băng',     icon:'❄️', hue:195, effect:'root',      desc:'Đòn đánh có cơ hội đóng băng gần như bất động'},
  {id:'dragon',name:'Rồng Con',    icon:'🐲', hue:45,  effect:'stungold',  desc:'Đòn đánh có cơ hội choáng địch + rớt thêm vàng'},
  {id:'bat',   name:'Dơi Máu',     icon:'🦇', hue:330, effect:'bleed',     desc:'Đòn đánh gây chảy máu, chặn hồi máu mục tiêu'},
];
function randPetType(){ return PET_TYPES[Math.floor(Math.random()*PET_TYPES.length)]; }
function petBaseStats(lv){ return { atk: 8+lv*3, hpMul: 1+lv*0.15 }; }
function tickPet(p,id,dt){
  const pet=p.pet;
  if(pet.zone!==p.zone){ pet.zone=p.zone; pet.x=p.x; pet.y=p.y; }
  const tx=p.x-p.fx*36, ty=p.y-p.fy*36;
  pet.x+=(tx-pet.x)*Math.min(1,dt*4); pet.y+=(ty-pet.y)*Math.min(1,dt*4);
  pet.fullness=Math.max(0,(pet.fullness||100)-dt*(100/1800)); // đói dần, hết trong ~30 phút không cho ăn
  pet.atkT=(pet.atkT||0)-dt;
  if(pet.atkT<=0){
    pet.atkT=3.5;
    let best=null,bd=140;
    for(const eid in enemies){const e=enemies[eid];if(e.dead||e.zone!==pet.zone)continue;const d=Math.hypot(e.x-pet.x,e.y-pet.y);if(d<bd){bd=d;best=e;}}
    if(best){
      const eff=(pet.fullness>0)?1:0.5; // đói quá thì giảm hiệu quả, không tắt hẳn
      const dmg=Math.round((pet.atk||8)*eff);
      hurtEnemy(best,dmg,id);
      fxEv('bite',best.x,best.y,0,1,0,0);
      const pt=PET_TYPES.find(t=>t.id===pet.type);
      if(pt.effect==='lifesteal'){ const heal=Math.round(dmg*0.4); p.hp=Math.min(p.maxhp,p.hp+heal); hitEv(p.x,p.y-16,heal,true); }
      else if(pt.effect==='poison'){ const tick=Math.round(dmg*0.3),tgt=best;
        for(let i=1;i<=3;i++) setTimeout(()=>{ if(!tgt.dead) hurtEnemy(tgt,tick,id); }, i*1000); }
      else if(pt.effect==='root'){ best.slowT=2.5; best.slowMul=0.1; }
      else if(pt.effect==='stungold' && Math.random()<0.4){ best.slowT=1.5; best.slowMul=0.03; p.gold+=15; bcast({t:'gold',id,x:p.x,y:p.y,val:15,st:0}); }
      else if(pt.effect==='bleed'){ const tick=Math.round(dmg*0.35),tgt2=best;
        for(let i=1;i<=2;i++) setTimeout(()=>{ if(!tgt2.dead) hurtEnemy(tgt2,tick,id); }, i*800); }
    }
  }
}
function tickSummon(p,id,dt){
  const s=p.summon;
  s.expireT-=dt; if(s.expireT<=0){ p.summon=null; sendTo(id,{t:'toast',text:'Cấm Vệ Quân đã hết hạn triệu hồi.'}); return; }
  if(s.zone!==p.zone){ s.zone=p.zone; s.x=p.x; s.y=p.y; s.orderPhase=null; }
  if(s.orderPhase==='charge'){
    if(s.orderTargetId){ const tgt=enemies[s.orderTargetId]; if(tgt && !tgt.dead){ s.orderX=tgt.x; s.orderY=tgt.y; } else { s.orderTargetId=null; } }
    s.chargeT=(s.chargeT||0)+dt;
    const d=Math.hypot(s.orderX-s.x,s.orderY-s.y);
    if(d>12 && s.chargeT<4){ s.x+=(s.orderX-s.x)/d*260*dt; s.y+=(s.orderY-s.y)/d*260*dt; summonSweep(s,id); }
    else { s.orderPhase='hold'; s.orderHoldT=s.orderHoldDurV||2.5; s.sweepHit=null; s.chargeT=0; fxEv('ring',s.x,s.y,45,0,0,45); }
  } else if(s.orderPhase==='hold'){
    s.orderHoldT-=dt;
    if(s.orderHoldT<=0){ s.orderPhase='return'; s.sweepHit=null; }
  } else if(s.orderPhase==='return'){
    const d=Math.hypot(p.x-s.x,p.y-s.y);
    if(d>35){ s.x+=(p.x-s.x)/d*260*dt; s.y+=(p.y-s.y)/d*260*dt; summonSweep(s,id); }
    else { s.orderPhase=null; }
  } else {
    const tx=p.x+p.fx*30, ty=p.y+p.fy*30;
    s.x+=(tx-s.x)*Math.min(1,dt*4); s.y+=(ty-s.y)*Math.min(1,dt*4);
  }
  const empowered=(s.orderPhase==='hold');
  const moving=(s.orderPhase==='charge'||s.orderPhase==='return');
  const willBuf=(p.commandStateT>0)?(p.commandStateSummonBuf||0):0;
  s.atkT=(s.atkT||0)-dt;
  if(s.atkT<=0 && !moving){
    s.atkT=(empowered?0.55:1.5)/(1+willBuf*0.5);
    const atkRange=empowered?250:170;
    let best=null,bd=atkRange;
    for(const eid in enemies){const e=enemies[eid];if(e.dead||e.zone!==s.zone)continue;if(!getStatus(e,'ravenmark'))continue;const d=Math.hypot(e.x-s.x,e.y-s.y);if(d<atkRange+60){best=e;bd=d;break;}}
    if(!best) for(const eid in enemies){const e=enemies[eid];if(e.dead||e.zone!==s.zone)continue;const d=Math.hypot(e.x-s.x,e.y-s.y);if(d<bd){bd=d;best=e;}}
    if(best){ const dmul=(empowered?1.6:1)*(getStatus(best,'ravenmark')?1.25:1)*(1+willBuf); hurtEnemy(best,s.atk*dmul,id); fxEv('swing',best.x,best.y,45,1,0,0); }
  }
}
function summonSweep(s,id){
  if(!s.sweepHit) s.sweepHit=new Set();
  for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==s.zone)continue;
    if(s.sweepHit.has(eid))continue;
    if(Math.hypot(e.x-s.x,e.y-s.y)<(s.sweepRV||55)){
      hurtEnemy(e,s.sweepDmgV||14,id);
      s.sweepHit.add(eid);
      fxEv('swing',e.x,e.y,45,1,0,0);
    }
  }
}
function doFeedPet(p,id){
  if(!p.pet)return; const cost=30;
  if(p.gold<cost){ sendTo(id,{t:'toast',text:'Cần 30🪙 để cho Đệ Tử ăn'}); return; }
  p.gold-=cost; p.pet.fullness=100;
  p.pet.xp=(p.pet.xp||0)+15;
  while(p.pet.xp>=(p.pet.xpNext||40)){ p.pet.xp-=p.pet.xpNext; p.pet.lv++; p.pet.xpNext=Math.round((p.pet.xpNext||40)*1.3);
    const bs=petBaseStats(p.pet.lv); p.pet.atk=bs.atk; }
  sendTo(id,{t:'toast',text:'🍖 Đệ Tử no rồi, khỏe hơn hẳn!'}); sendInv(p,id);
}
const FUSION_DUR=300, FUSION_CD=900; // 5 phút hợp thể, 15 phút hồi chiêu (đặt ngắn để test — chỉnh dài hơn khi ưng ý)
function doFusion(p,id){
  if(!p.pet)return;
  if(p.fusedT>0){ sendTo(id,{t:'toast',text:'Đang hợp thể, chưa thể hủy giữa chừng.'}); return; }
  if((p.fusionCd||0)>0){ sendTo(id,{t:'toast',text:'Hợp thể còn hồi chiêu '+Math.ceil(p.fusionCd)+'s'}); return; }
  p.fusedT=FUSION_DUR; recompute(p);
  sendTo(id,{t:'toast',text:'⚡ Hợp thể với '+PET_TYPES.find(t=>t.id===p.pet.type).name+'! Sức mạnh tăng vọt trong '+FUSION_DUR+'s.'});
}
function doPermFusion(p,id){
  if(!p.pet)return;
  const bonus=Math.max(3,Math.round(p.pet.lv*0.8));
  p.STR+=bonus; p.VIT+=bonus; p.AGI+=bonus; p.INT+=bonus;
  const petName=PET_TYPES.find(t=>t.id===p.pet.type).name;
  p.pet=null; p.fusedT=0; p.fusionCd=0; recompute(p);
  sendTo(id,{t:'toast',text:'💫 '+petName+' đã hợp thể vĩnh viễn! +'+bonus+' mọi chỉ số mãi mãi.'});
  sendTo(id,{t:'skills',meta:skillMeta(p),passive:PASSIVES[p.cls],full:fullSkillList(p),loadout:p.loadout}); sendInv(p,id);
}
function doBuyHsPetEgg(p,id){
  if(p.hspet){ sendTo(id,{t:'toast',text:'Bạn đã có Thú Cưng rồi.'}); return; }
  if(p.lv<HSPET_MIN_LV){ sendTo(id,{t:'toast',text:'Cần đạt Lv '+HSPET_MIN_LV+' để mua trứng.'}); return; }
  if(p.gold<HSPET_EGG_COST){ sendTo(id,{t:'toast',text:'Cần '+HSPET_EGG_COST+'🪙 để mua trứng.'}); return; }
  p.gold-=HSPET_EGG_COST;
  p.hspet={stat:{STR:0,VIT:0,AGI:0,INT:0},hunger:100};
  sendTo(id,{t:'toast',text:'🥚 Trứng nở rồi! Bạn có Thú Cưng mới.'}); sendInv(p,id); recompute(p);
}
function doFeedHsPet(p,id,itemId){
  if(!p.hspet)return;
  const idx=(p.inv||[]).findIndex(x=>x.id===itemId); if(idx<0)return;
  const it=p.inv[idx]; const stat=HSPET_FOOD_MAP[it.slot]; if(!stat)return;
  const gain=2+(it.tier||1)*2+(it.plus||0);
  p.inv.splice(idx,1); p.hspet.stat[stat]=(p.hspet.stat[stat]||0)+gain; p.hspet.hunger=100;
  recompute(p);
  sendTo(id,{t:'toast',text:'🍎 Thú Cưng ăn xong, +'+gain+' '+stat+' (đồng hành)!'});
  sendInv(p,id);
}
// ---- NPC + NHIỆM VỤ NHẬN/GIAO (khác nhiệm vụ hệ thống: không reset ngày, mở khóa tuần tự) ----
const NPCS = [
  {id:'elder', name:'Trưởng Lão Aldric', icon:'🧙', zone:'town', x:450, y:180, kind:'quest', greet:'Vùng đất này đang gặp nguy. Ngươi có sẵn lòng giúp ta không?'},
  {id:'smith', name:'Thợ Rèn Boran',    icon:'🔨', zone:'town', x:250, y:520, kind:'quest', greet:'Vũ khí sắc bén sẽ quyết định sinh tử. Cường hóa đi, rồi quay lại đây.'},
  {id:'merchant', name:'Thương Nhân Elin', icon:'🛒', zone:'town', x:620, y:420, kind:'shop', greet:'Bình máu, bình mana, hay bán bớt đồ thừa? Cứ xem qua đi.'},
];
const POTIONS = [
  {id:'hp', name:'🧪 Bình Máu', desc:'Hồi ngay 60 HP', cost:15},
  {id:'mp', name:'💧 Bình Mana', desc:'Hồi ngay 40 Mana', cost:12},
];
// ---- THÚ CƯNG (kiểu Hiệp Sĩ) — mua trứng ở NPC, cho ăn theo loại đồ để lên đúng nhóm chỉ số, KHÔNG tự chiến đấu (khác hẳn Đệ Tử) ----
const HSPET_EGG_COST=200, HSPET_MIN_LV=5;
const HSPET_FOOD_MAP={ wpn:'STR', hlm:'VIT', arm:'VIT', glv:'VIT', boot:'VIT', rng:'AGI', neck:'AGI', wing:'INT' };
function hspetStatBonus(hspet,stat){ return Math.floor((hspet.stat[stat]||0)/8); } // mỗi 8 điểm nuôi = +1 chỉ số thật
// ---- THÚ CƯỠI — mua tại NPC (khác Đệ Tử/Pet: không săn, không nuôi), lõi là tăng tốc di chuyển ----
const MOUNTS = [
  {id:'horse', name:'🐴 Ngựa Thường', cost:500,  spdMul:1.15, hp:0,  allStat:0, desc:'+15% tốc độ'},
  {id:'elk',   name:'🦌 Nai Sừng',    cost:2000, spdMul:1.20, hp:30, allStat:0, desc:'+20% tốc độ · +30 Máu'},
  {id:'leo',   name:'🐆 Báo Đốm',     cost:4000, spdMul:1.30, hp:0,  allStat:0, desc:'+30% tốc độ (nhanh nhất)'},
  {id:'dragon',name:'🐉 Long Mã',     cost:8000, spdMul:1.22, hp:60, allStat:5, desc:'+22% tốc độ · +60 Máu · +5 mọi chỉ số'},
];
function sellValue(it){ return Math.max(2, Math.round((it.tier||1)*15 + (it.plus||0)*8)); }
// ---- ĐÁ THUỘC TÍNH (Ngũ Hành) — lớp nâng cấp thứ 2, ĐỘC LẬP với cường hóa +N, gắn qua Thợ Rèn ----
const GEM_TYPES = {
  hoa:  {name:'🔥 Hỏa', desc:'+8% sát thương skill'},
  thuy: {name:'💧 Thủy', desc:'+8% Mana tối đa, giảm nhẹ hồi chiêu'},
  moc:  {name:'🌳 Mộc', desc:'+8% Máu tối đa'},
  tho:  {name:'🪨 Thổ', desc:'-8% sát thương nhận'},
  kim:  {name:'⚔️ Kim', desc:'+8% sát thương đánh thường'},
};
const GEM_SOCKET_COST=150;
function computeGemBonus(p){
  const g={hoa:0,thuy:0,moc:0,tho:0,kim:0};
  for(const s of SLOTS){ const it=p.equip[s]; if(it&&it.gem&&g[it.gem]!==undefined) g[it.gem]++; }
  return g;
}
function doSocketGem(p,id,slot,gemType){
  if(!GEM_TYPES[gemType])return; const it=p.equip[slot]; if(!it)return;
  if((p.gemCount&&p.gemCount[gemType]||0)<=0){ sendTo(id,{t:'toast',text:'Không đủ '+GEM_TYPES[gemType].name+' để gắn'}); return; }
  if(p.gold<GEM_SOCKET_COST){ sendTo(id,{t:'toast',text:'Cần '+GEM_SOCKET_COST+'🪙 để gắn đá'}); return; }
  p.gold-=GEM_SOCKET_COST; p.gemCount[gemType]--;
  it.gem=gemType; recompute(p);
  sendTo(id,{t:'toast',text:'💎 Đã gắn '+GEM_TYPES[gemType].name+' vào '+slot+'!'}); sendInv(p,id);
}
function mountSpdMul(p){ if(!p.mounted)return 1; const mt=MOUNTS.find(x=>x.id===p.mounted); return mt?mt.spdMul:1; }
const NPC_QUESTS = {
  elder: [
    {id:'e1',name:'Diệt 8 quái Rừng Ma',   desc:'Dọn sạch lũ quái đang quấy nhiễu Rừng Ma.',      target:8, checkKey:'killForest', reward:{gold:150,xp:120}},
    {id:'e2',name:'Hạ Boss Rừng Ma',        desc:'Con đầu lĩnh phải bị trừng trị.',                target:1, checkKey:'bossForest', reward:{gold:400,xp:350,stones:6}},
    {id:'e3',name:'Diệt 8 quái Hang Băng',  desc:'Vùng băng giá cũng cần được dọn dẹp.',           target:8, checkKey:'killCave',   reward:{gold:250,xp:220}},
    {id:'e4',name:'Hạ Boss Hang Băng',      desc:'Thử thách cuối cùng của Trưởng Lão.',            target:1, checkKey:'bossCave',   reward:{gold:600,xp:500,stones:10,itemTier:3}},
  ],
  smith: [
    {id:'s1',name:'Cường Hóa Trang Bị',     desc:'Cường hóa một trang bị bất kỳ lên +3 trở lên.',  target:1, checkKey:'plus3',      reward:{gold:200,stones:5}},
  ],
};
function npcProgress(p,def){
  if(def.checkKey==='plus3'){
    for(const s of SLOTS){ if(p.equip[s]&&(p.equip[s].plus||0)>=3)return 1; }
    for(const it of (p.inv||[])){ if((it.plus||0)>=3)return 1; }
    return 0;
  }
  const cum=(p.cum&&p.cum[def.checkKey])||0;
  const snap=p.npcAccepted?p.npcAccepted[def.id]:undefined;
  if(snap===undefined)return 0;
  return Math.max(0,cum-snap);
}
function npcQuestState(p,npcId,idx,def){
  if(p.npcClaimed&&p.npcClaimed[def.id])return 'claimed';
  const chain=NPC_QUESTS[npcId];
  if(idx>0 && !(p.npcClaimed&&p.npcClaimed[chain[idx-1].id]))return 'locked';
  const accepted=p.npcAccepted&&(def.checkKey==='plus3'?p.npcAccepted[def.id]!==undefined:p.npcAccepted[def.id]!==undefined);
  if(!accepted)return 'available';
  return npcProgress(p,def)>=def.target?'claimable':'accepted';
}
function sendNpcData(p,id,npcId){
  const npc=NPCS.find(n=>n.id===npcId); if(!npc)return;
  const chain=NPC_QUESTS[npcId]||[];
  const quests=chain.map((def,idx)=>({id:def.id,name:def.name,desc:def.desc,target:def.target,progress:npcProgress(p,def),reward:def.reward,state:npcQuestState(p,npcId,idx,def)}));
  sendTo(id,{t:'npcdata',npcId,name:npc.name,icon:npc.icon,greet:npc.greet,quests});
}
function doAcceptNpcQ(p,id,npcId,qid){
  const chain=NPC_QUESTS[npcId]; if(!chain)return; const idx=chain.findIndex(q=>q.id===qid); if(idx<0)return; const def=chain[idx];
  if(npcQuestState(p,npcId,idx,def)!=='available')return;
  if(!p.npcAccepted)p.npcAccepted={};
  p.npcAccepted[qid]= def.checkKey==='plus3' ? 1 : ((p.cum&&p.cum[def.checkKey])||0);
  sendNpcData(p,id,npcId);
}
function doClaimNpcQ(p,id,npcId,qid){
  const chain=NPC_QUESTS[npcId]; if(!chain)return; const idx=chain.findIndex(q=>q.id===qid); if(idx<0)return; const def=chain[idx];
  if(npcQuestState(p,npcId,idx,def)!=='claimable')return;
  if(!p.npcClaimed)p.npcClaimed={}; p.npcClaimed[qid]=true;
  const r=def.reward;
  if(r.gold)p.gold+=r.gold; if(r.stones)p.stones=(p.stones||0)+r.stones; if(r.xp)gainXP(p,r.xp);
  if(r.itemTier){ const item=makeItem(r.itemTier); if(p.inv.length<24)p.inv.push(item); }
  bcast({t:'gold',id,x:p.x,y:p.y,val:r.gold||0,st:r.stones||0});
  sendNpcData(p,id,npcId); sendInv(p,id);
}
function sendShopData(p,id){
  sendTo(id,{t:'shopdata',potions:POTIONS,gold:p.gold,
    inv:(p.inv||[]).map(it=>({id:it.id,slot:it.slot,tier:it.tier,plus:it.plus||0,sell:sellValue(it)}))});
}
function doBuyPotion(p,id,kind){
  const pot=POTIONS.find(x=>x.id===kind); if(!pot||p.gold<pot.cost)return;
  p.gold-=pot.cost;
  if(kind==='hp'){ p.hp=Math.min(p.maxhp,p.hp+60); hitEv(p.x,p.y-20,60,true); }
  else { p.mp=Math.min(p.maxmp,p.mp+40); }
  sendShopData(p,id);
}
function doBuyMount(p,id,mountId){
  const mt=MOUNTS.find(x=>x.id===mountId); if(!mt)return;
  if(!p.mounts)p.mounts=[]; if(p.mounts.includes(mountId))return;
  if(p.gold<mt.cost){ sendTo(id,{t:'toast',text:'Không đủ vàng mua '+mt.name}); return; }
  p.gold-=mt.cost; p.mounts.push(mountId);
  sendTo(id,{t:'toast',text:'🎉 Đã mua '+mt.name+'!'}); sendShopData(p,id); sendTo(id,{t:'mounts',owned:p.mounts,mounted:p.mounted});
}
function doToggleMount(p,id,mountId){
  const cur=p.mounted?MOUNTS.find(x=>x.id===p.mounted):null;
  if(p.mounted===mountId){
    if(cur&&cur.allStat){ p.STR-=cur.allStat;p.VIT-=cur.allStat;p.AGI-=cur.allStat;p.INT-=cur.allStat; }
    p.mounted=null;
  } else if(p.mounts && p.mounts.includes(mountId)){
    if(cur&&cur.allStat){ p.STR-=cur.allStat;p.VIT-=cur.allStat;p.AGI-=cur.allStat;p.INT-=cur.allStat; }
    const mt=MOUNTS.find(x=>x.id===mountId);
    if(mt&&mt.allStat){ p.STR+=mt.allStat;p.VIT+=mt.allStat;p.AGI+=mt.allStat;p.INT+=mt.allStat; }
    p.mounted=mountId;
  } else return;
  recompute(p);
  sendTo(id,{t:'mounts',owned:p.mounts,mounted:p.mounted});
  sendTo(id,{t:'skills',meta:skillMeta(p),passive:PASSIVES[p.cls],full:fullSkillList(p),loadout:p.loadout}); sendInv(p,id);
}
function doSellItem(p,id,itemId){
  const idx=(p.inv||[]).findIndex(x=>x.id===itemId); if(idx<0)return;
  const it=p.inv[idx]; p.inv.splice(idx,1); p.gold+=sellValue(it);
  sendInv(p,id); sendShopData(p,id);
}
const PVP = 1.7;   // skill trúng NGƯỜI CHƠI khác thì nhân hệ số này (đánh nhau đau hơn)

// bảng chiêu: cd (giây) + mana
const SK = {
  b:{cd:0.45, mp:0 },
  q:{cd:2.2,  mp:12},
  w:{cd:0.9,  mp:18},
  e:{cd:5.0,  mp:30},
  r:{cd:12.0, mp:55},
};
// 5 class (nguyên mẫu MU đời đầu, tên/skill là của mình)
const CLASSES = {
  war:  {hp:170, mp:80,  spd:250, hue:18,  basic:{type:'melee', range:90,  dmg:22, cd:0.45}},
  mage: {hp:95,  mp:145, spd:236, hue:275, basic:{type:'proj',  range:360, dmg:26, cd:0.62, spd:480, r:8, kind:'orb'}},
  arc:  {hp:120, mp:95,  spd:258, hue:135, basic:{type:'proj',  range:340, dmg:18, cd:0.34, spd:660, r:5, kind:'arrow'}},
  blade:{hp:140, mp:110, spd:250, hue:190, basic:{type:'melee', range:96,  dmg:20, cd:0.45}},
  cmd:  {hp:150, mp:115, spd:242, hue:45,  basic:{type:'proj',  range:230, dmg:20, cd:0.55, spd:560, r:6, kind:'chain'}},
};

// ------------------------------------------------------------
// CLIENT (nhúng thẳng)
// ------------------------------------------------------------
const CLIENT = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>WebGame</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;user-select:none}
  html,body{margin:0;height:100%;background:#14100c;font-family:Trebuchet MS,system-ui,sans-serif;color:#e8d8b8;overflow:hidden}
  #wrap{position:relative;width:100%;height:100dvh;touch-action:none}
  canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  #hud{position:absolute;top:10px;left:12px;font-size:12px;pointer-events:none;z-index:5}
  #hud .nm{font-size:14px;color:#e0b062;font-weight:bold}
  .bar{width:172px;height:11px;margin-top:4px;background:#000a;border:1px solid #0007;border-radius:6px;overflow:hidden;position:relative}
  .bar>i{display:block;height:100%}
  .bar>span{position:absolute;inset:0;text-align:center;font-size:9px;line-height:11px;color:#fff;text-shadow:0 1px 1px #000}
  #hpb{background:linear-gradient(90deg,#8fd08a,#4fa54f)}
  #mpb{background:linear-gradient(90deg,#8fc4ff,#3a7fe0)}
  #info{position:absolute;top:10px;right:12px;font-size:12px;color:#9a8a6a;pointer-events:none;z-index:5}
  #cluster{position:absolute;right:14px;bottom:16px;width:220px;height:200px;z-index:6}
  .sk{position:absolute;border-radius:50%;background:radial-gradient(circle at 35% 30%,#2c2114,#171009);
    border:2px solid #a87b3e;color:#e0b062;display:flex;flex-direction:column;align-items:center;justify-content:center;
    font-weight:bold;box-shadow:0 3px 12px #000a}
  .sk .k{position:absolute;top:2px;left:4px;font-size:10px;line-height:1;background:#000a;border-radius:4px;padding:1px 3px;color:#e0b062}
  .sk .ic{font-size:22px;line-height:1;display:block}
  .sk .l{font-size:7px;color:#9a8a6a;display:block;margin-top:1px}
  .sk .m{position:absolute;bottom:-3px;font-size:8px;color:#8fc4ff;background:#000b;padding:0 3px;border-radius:4px}
  .sk:active{transform:scale(.93)}
  .sk .cd{position:absolute;inset:0;border-radius:50%;background:conic-gradient(#000c var(--d,0deg),transparent 0deg)}
  .sk.nomana{filter:grayscale(.7) brightness(.65)}
  .sk.comboReady{animation:comboPulse .5s ease-in-out infinite; box-shadow:0 0 14px #ffe070}
  @keyframes comboPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
  .sk.empty{border-style:dashed;border-color:#ffd76b88;animation:skPulse 1.8s ease-in-out infinite}
  .sk.empty .k{opacity:.5}
  @keyframes skPulse{0%,100%{box-shadow:0 3px 12px #000a;}50%{box-shadow:0 3px 16px #ffd76b70,0 0 6px #ffd76b50 inset;}}
  .basic{width:72px;height:72px;right:8px;bottom:8px;border-color:#b8514d;color:#ffd9a0}
  #sQ{width:54px;height:54px;right:112px;bottom:16px}
  #sW{width:54px;height:54px;right:99px;bottom:64px}
  #sE{width:54px;height:54px;right:64px;bottom:99px}
  #sR{width:58px;height:58px;right:14px;bottom:112px;border-color:#d9a04a}
  #sSwap{width:46px;height:46px;right:45px;bottom:155px;border-color:#a878ff}
  #st{position:absolute;left:0;right:0;bottom:56px;text-align:center;font-size:10px;color:#7a6a4a;pointer-events:none;z-index:5}
  .menubtn{position:absolute;bottom:52px;width:40px;height:40px;border-radius:10px;z-index:7;display:none;
    background:radial-gradient(circle at 35% 30%,#2c2114,#171009);border:2px solid #a87b3e;color:#e0b062;
    font-size:19px;align-items:center;justify-content:center;box-shadow:0 3px 12px #000a}
  .menubtn.show{display:flex}
  #menuToggle{position:absolute;left:50%;bottom:4px;width:50px;height:50px;border-radius:50%;z-index:7;
    background:radial-gradient(circle at 35% 30%,#3a2a12,#1c1206);border:2px solid #ffd76b;color:#ffe9a8;
    font-size:22px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 14px #ffd76b90,0 3px 12px #000a;
    animation:menuPulse 2.2s ease-in-out infinite}
  #menuToggle.dragging{animation:none;box-shadow:0 0 22px #ffd76b;transform:scale(1.15)}
  @keyframes menuPulse{0%,100%{box-shadow:0 0 10px #ffd76b70,0 3px 12px #000a;}50%{box-shadow:0 0 20px #ffd76bc0,0 3px 12px #000a;}}
  #ver{position:absolute;left:8px;bottom:82px;font-size:10px;color:#7a6a48;z-index:7;pointer-events:none;letter-spacing:.5px}
  #pick{position:absolute;inset:0;z-index:20;background:rgba(10,8,5,0.94);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px}
  #pick h2{color:#e0b062;margin:0 0 4px;font-size:20px}
  #pick p{color:#9a8a6a;margin:0 0 16px;font-size:12px}
  .pc{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;max-width:560px}
  .pcard{width:150px;background:linear-gradient(160deg,#241a10,#160f08);border:2px solid #a87b3e;border-radius:12px;padding:12px;cursor:pointer;text-align:center}
  .pcard:active{transform:scale(.96)}
  .pcard .ic{font-size:30px}
  .pcard .cn{color:#e0b062;font-weight:bold;font-size:15px;margin-top:4px}
  .pcard .cd2{color:#c8b48a;font-size:11px;margin-top:4px;line-height:1.35}
  #chrPanel{position:absolute;inset:0;z-index:18;background:rgba(10,8,5,0.94);display:none;flex-direction:column;align-items:center;padding:44px 14px 14px;overflow-y:auto}
  #chrPanel h3{color:#e0b062;margin:0 0 4px;font-size:17px}
  .pasv{max-width:320px;text-align:center;font-size:11.5px;color:#c8b48a;margin-bottom:12px;line-height:1.4;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:8px}
  .pasv b{color:#ffd76b}
  .statgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;max-width:320px;width:100%;margin-bottom:12px}
  .statrow{display:flex;align-items:center;justify-content:space-between;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:6px 10px}
  .statrow .sn{font-size:12px;color:#e8d8b8}
  .statrow .sv{font-size:14px;color:#ffd76b;font-weight:bold}
  .statrow button{width:26px;height:26px;border-radius:6px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold}
  .statrow button:disabled{opacity:.3}
  .ptsline{font-size:12px;color:#9a8a6a;margin-bottom:10px}
  .skrow2{max-width:340px;width:100%;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:8px 10px;margin-bottom:6px}
  .skrow2.locked{opacity:.45}
  .sk2top{display:flex;align-items:center;gap:8px}
  .sk2top .si{font-size:17px;width:22px}
  .sk2top .sname{flex:1;font-size:12.5px;color:#e8d8b8;font-weight:bold}
  .sk2top .sr{font-size:11px;color:#ffd76b}
  .sk2slots{display:flex;gap:5px;margin-top:6px}
  .slotbtn{width:30px;height:26px;border-radius:6px;border:1px solid #6b5636;background:#120d08;color:#9a8a6a;font-weight:bold;font-size:11px}
  .slotbtn.active{border-color:#ffd76b;color:#ffd76b;background:#3a2a12}
  .rankbtn{flex:1;height:26px;border-radius:6px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold;font-size:11px}
  .rankbtn:disabled{opacity:.3}
  .panelX{position:absolute;top:10px;right:12px;width:34px;height:34px;border-radius:50%;
    background:#241a10;border:1px solid #a87b3e;color:#e0b062;font-size:16px;font-weight:bold;z-index:2}
  #qbtn .dot{position:absolute;top:2px;right:2px;width:10px;height:10px;border-radius:50%;background:#ff5a4a;display:none}
  #qPanel{position:absolute;inset:0;z-index:18;background:rgba(10,8,5,0.94);display:none;flex-direction:column;align-items:center;padding:44px 14px 14px;overflow-y:auto}
  #qPanel h3{color:#e0b062;margin:0 0 10px;font-size:17px}
  .checkbox{max-width:320px;width:100%;background:#241a10;border:1px solid #d9a04a;border-radius:10px;padding:10px;margin-bottom:12px;text-align:center}
  .checkbox .cktitle{color:#ffd76b;font-weight:bold;font-size:13px;margin-bottom:4px}
  .checkbox .ckreward{color:#c8b48a;font-size:11.5px;margin-bottom:8px}
  .checkbox button{padding:8px 22px;border-radius:8px;border:1px solid #ffd76b;background:#3a2a12;color:#ffe9a8;font-weight:bold}
  .checkbox button:disabled{opacity:.35}
  .qrow{max-width:320px;width:100%;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:8px 10px;margin-bottom:6px}
  .qrow .qn{font-size:12px;color:#e8d8b8;margin-bottom:4px}
  .qbar{width:100%;height:8px;background:#000a;border-radius:5px;overflow:hidden;margin-bottom:6px}
  .qbar>i{display:block;height:100%;background:linear-gradient(90deg,#e0b062,#c98a2e)}
  .qrow button{width:100%;padding:6px;border-radius:6px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold;font-size:12px}
  .qrow button:disabled{opacity:.3}
  #socPanel{position:absolute;inset:0;z-index:18;background:rgba(10,8,5,0.94);display:none;flex-direction:column;align-items:center;padding:44px 14px 0}
  #socPanel h3{color:#e0b062;margin:8px 0 10px;font-size:17px}
  .tabs{display:flex;gap:8px;margin-bottom:10px}
  .tabbtn{padding:7px 16px;border-radius:8px;border:1px solid #6b5636;background:#1b140d;color:#c8b48a;font-size:12px;font-weight:bold}
  .tabbtn.on{border-color:#e0b062;color:#e0b062;background:#241a10}
  .chatlog{width:100%;max-width:340px;flex:1;min-height:0;overflow-y:auto;background:#120d08;border:1px solid #6b5636;border-radius:8px;padding:8px;font-size:12px;color:#dccca8;margin-bottom:8px}
  .chatlog .cm{margin-bottom:5px;line-height:1.35}
  .chatlog .cm b{color:#e0b062}
  .chatrow{display:flex;gap:6px;width:100%;max-width:340px;margin-bottom:12px}
  .chatrow input{flex:1;padding:8px;border-radius:8px;border:1px solid #6b5636;background:#1b140d;color:#e8d8b8;font-size:12px}
  .chatrow button{padding:8px 14px;border-radius:8px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold}
  .plist{width:100%;max-width:340px;flex:1;overflow-y:auto}
  .prow{display:flex;align-items:center;justify-content:space-between;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:7px 10px;margin-bottom:6px;font-size:12px;color:#e8d8b8}
  .prow button{padding:5px 12px;border-radius:6px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold;font-size:11px}
  #socClose{margin:10px 0;padding:8px 22px;border-radius:8px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold}
  #inviteBanner{position:absolute;top:56px;left:0;right:0;z-index:22;display:none;justify-content:center}
  #inviteBanner .ibox{background:#241a10;border:1px solid #ffd76b;border-radius:10px;padding:8px 12px;display:flex;align-items:center;gap:10px;font-size:12px;color:#ffe9a8}
  #inviteBanner button{padding:5px 10px;border-radius:6px;border:1px solid #a87b3e;font-weight:bold;font-size:11px}
  #ibAccept{background:#2d4a20;color:#c7f2a0}
  #ibDecline{background:#4a2020;color:#f2a0a0}
  #partyHud{position:absolute;top:66px;left:8px;z-index:5;display:none;flex-direction:column;gap:3px}
  #partyHud .pmr{background:#000a;border:1px solid #6b5636;border-radius:6px;padding:3px 6px;font-size:10px;color:#dccca8;min-width:90px}
  #partyHud .pmr .pb{width:100%;height:5px;background:#000;border-radius:3px;overflow:hidden;margin-top:2px}
  #partyHud .pmr .pb>i{display:block;height:100%;background:#6fce6a}
  #talkBtn{position:absolute;left:0;right:0;bottom:210px;display:none;justify-content:center;z-index:8}
  #talkBtn button{padding:10px 20px;border-radius:20px;border:2px solid #ffd76b;background:#241a10;color:#ffe9a8;font-weight:bold;font-size:13px;box-shadow:0 3px 10px #000a}
  #npcPanel{position:absolute;inset:0;z-index:19;background:rgba(10,8,5,0.95);display:none;flex-direction:column;align-items:center;padding:44px 14px 14px;overflow-y:auto}
  #npcPanel .nphead{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  #npcPanel .nphead .ic{font-size:30px}
  #npcPanel .nphead .nm{color:#e0b062;font-weight:bold;font-size:16px}
  #npcPanel .greet{max-width:320px;text-align:center;font-size:12px;color:#c8b48a;margin-bottom:12px;font-style:italic}
  .nqrow{max-width:340px;width:100%;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:9px 11px;margin-bottom:7px}
  .nqrow.locked{opacity:.4}
  .nqrow .nqn{font-size:12.5px;color:#e8d8b8;font-weight:bold}
  .nqrow .nqd{font-size:11px;color:#9a8a6a;margin:2px 0 6px}
  .nqrow .nqr{font-size:11px;color:#ffd76b;margin-bottom:6px}
  .nqrow button{width:100%;padding:7px;border-radius:6px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold;font-size:12px}
  .nqrow button:disabled{opacity:.35}
  #toast{position:absolute;top:100px;left:0;right:0;z-index:23;display:flex;justify-content:center;pointer-events:none}
  #toast span{background:#241a10;border:1px solid #ffd76b;border-radius:20px;padding:7px 16px;color:#ffe9a8;font-size:12px;font-weight:bold;opacity:0;transition:opacity .3s}
  #shopPanel{position:absolute;inset:0;z-index:19;background:rgba(10,8,5,0.95);display:none;flex-direction:column;align-items:center;padding:44px 14px 14px;overflow-y:auto}
  #shopPanel h3{color:#e0b062;margin:6px 0 10px}
  .shtabs{display:flex;gap:8px;margin-bottom:10px}
  .potrow{max-width:320px;width:100%;display:flex;align-items:center;justify-content:space-between;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:8px 10px;margin-bottom:6px}
  .potrow .pn{font-size:12px;color:#e8d8b8}.potrow .pd{font-size:10px;color:#9a8a6a}
  .potrow button{padding:6px 12px;border-radius:6px;border:1px solid #a87b3e;background:#241a10;color:#ffd76b;font-weight:bold;font-size:11px}
  .potrow button:disabled{opacity:.35}
  .sellrow{max-width:320px;width:100%;display:flex;align-items:center;justify-content:space-between;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:7px 10px;margin-bottom:5px;font-size:11.5px;color:#e8d8b8}
  .sellrow button{padding:5px 10px;border-radius:6px;border:1px solid #a87b3e;background:#241a10;color:#ffd76b;font-weight:bold;font-size:11px}
  #shopgold{color:#ffd76b;font-size:12px;margin-bottom:10px}
  #petPanel{position:absolute;inset:0;z-index:19;background:rgba(10,8,5,0.96);display:none;flex-direction:column;align-items:center;padding:44px 14px 14px;overflow-y:auto}
  .pethead{max-width:320px;width:100%;background:#1b140d;border:1px solid #d9a04a;border-radius:10px;padding:14px;margin-bottom:12px;text-align:center}
  .pethead .pic{font-size:42px}
  .pethead .pn{color:#ffd76b;font-weight:bold;font-size:16px;margin-top:4px}
  .pethead .pd{color:#c8b48a;font-size:11.5px;margin-top:4px}
  .petbar{width:100%;height:10px;background:#000a;border-radius:6px;overflow:hidden;margin-top:8px}
  .petbar>i{display:block;height:100%;background:linear-gradient(90deg,#8fd08a,#4fa54f)}
  #feedBtn{margin-top:10px;padding:9px 24px;border-radius:8px;border:1px solid #ffd76b;background:#3a2a12;color:#ffe9a8;font-weight:bold}
  #feedBtn:disabled{opacity:.4}
  .petempty{max-width:300px;text-align:center;color:#9a8a6a;font-size:12.5px;line-height:1.5}
  #guildPanel{position:absolute;inset:0;z-index:19;background:rgba(10,8,5,0.96);display:none;flex-direction:column;align-items:center;padding:44px 12px 12px;overflow-y:auto}
  #guildPanel h3{color:#e0b062;margin:6px 0 8px}
  .gcreate{max-width:320px;width:100%;background:#1b140d;border:1px solid #6b5636;border-radius:10px;padding:10px;margin-bottom:12px}
  .gcreate input{width:100%;padding:8px;border-radius:8px;border:1px solid #6b5636;background:#120d08;color:#e8d8b8;font-size:12px;margin-bottom:8px;box-sizing:border-box}
  .gcreate button{width:100%;padding:8px;border-radius:8px;border:1px solid #a87b3e;background:#241a10;color:#ffd76b;font-weight:bold;font-size:12px}
  .glistrow{max-width:320px;width:100%;display:flex;justify-content:space-between;align-items:center;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:11.5px;color:#e8d8b8}
  .glistrow button{padding:5px 10px;border-radius:6px;border:1px solid #a87b3e;background:#241a10;color:#ffd76b;font-weight:bold;font-size:11px}
  .ghead{max-width:340px;width:100%;background:#1b140d;border:1px solid #d9a04a;border-radius:10px;padding:10px;margin-bottom:10px}
  .ghead .gn{color:#ffd76b;font-weight:bold;font-size:15px}
  .ghead .glv{color:#9a8a6a;font-size:11px;margin:2px 0 6px}
  .ghead .gmotd{color:#c8b48a;font-size:11px;font-style:italic}
  .gmemrow{max-width:340px;width:100%;display:flex;justify-content:space-between;align-items:center;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:7px 10px;margin-bottom:5px;font-size:11.5px;color:#e8d8b8}
  .gmemrow .gbtns{display:flex;gap:4px}
  .gmemrow .gbtns button{padding:4px 7px;border-radius:5px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-size:10px}
  .gsec{max-width:340px;width:100%;margin-bottom:10px}
  .gsec h4{color:#e0b062;font-size:12px;margin:0 0 6px}
  .gdonrow{display:flex;gap:6px}
  .gdonrow input{flex:1;padding:7px;border-radius:6px;border:1px solid #6b5636;background:#120d08;color:#e8d8b8;font-size:12px}
  .gdonrow button{padding:7px 12px;border-radius:6px;border:1px solid #a87b3e;background:#241a10;color:#ffd76b;font-weight:bold;font-size:11px}
  #inv{position:absolute;inset:0;z-index:18;background:rgba(10,8,5,0.92);display:none;flex-direction:column;align-items:center;padding:44px 14px 14px;overflow-y:auto}
  #inv h3{color:#e0b062;margin:0 0 10px;font-size:17px}
  .eqrow{display:grid;grid-template-columns:52px 52px 52px;gap:6px;margin-bottom:14px;justify-content:center}
  .cellblank{width:52px;height:52px}
  .figc{width:52px;height:52px;display:flex;align-items:center;justify-content:center;font-size:30px;opacity:.75}
  .slot,.cell{width:52px;height:52px;border-radius:9px;border:2px solid #6b5636;background:#1b140d;
    display:flex;align-items:center;justify-content:center;font-size:20px;position:relative;cursor:pointer}
  .slot{border-color:#a87b3e}
  .cell .v,.slot .v{position:absolute;bottom:1px;right:3px;font-size:9px;color:#fff;text-shadow:0 1px 1px #000}
  .grid{display:grid;grid-template-columns:repeat(6,52px);gap:6px;max-height:42vh;overflow:auto;padding:4px}
  #invClose{margin-top:12px;padding:8px 22px;border-radius:8px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold;cursor:pointer}
  .t1{box-shadow:inset 0 0 0 2px #9fe0a0}.t2{box-shadow:inset 0 0 0 2px #6bd0ff}.t3{box-shadow:inset 0 0 0 2px #c77dff}
  .sel{outline:2px solid #ffe0a0;outline-offset:1px}
  .pl{position:absolute;top:0;left:2px;font-size:9px;font-weight:bold;color:#ffd76b;text-shadow:0 1px 2px #000}
  #detail{min-height:56px;margin-top:10px;width:100%;max-width:340px;display:none;flex-direction:column;gap:6px;
    background:#1b140d;border:1px solid #6b5636;border-radius:10px;padding:8px}
  #detail .dtop{font-size:13px;color:#e8d8b8}
  #detail .drow{display:flex;gap:8px}
  #detail button{flex:1;padding:8px;border-radius:8px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold;font-size:12px;cursor:pointer}
  #detail button:disabled{opacity:.4}
  #detail .ench{border-color:#d9a04a;color:#ffd76b}
</style></head><body>
<div id="wrap">
  <button id="bag" class="menubtn">🎒</button>
  <button id="chr" class="menubtn">👤</button>
  <button id="qbtn" class="menubtn">📜<span class="dot" id="qdot"></span></button>
  <button id="socbtn" class="menubtn">👥<span class="dot" id="socdot"></span></button>
  <div id="socPanel">
    <button class="panelX" id="socX">✕</button>
    <h3>Xã Hội</h3>
    <div class="tabs">
      <button class="tabbtn on" id="tabChat">💬 Trò chuyện</button>
      <button class="tabbtn" id="tabParty">👥 Nhóm</button>
    </div>
    <div id="chatView" style="width:100%;display:flex;flex-direction:column;align-items:center;flex:1;min-height:0">
      <div class="chatlog" id="chatlog"></div>
      <div class="chatrow"><input id="chatinput" type="text" maxlength="120" placeholder="Nhắn gì đó..."><button id="chatsend">Gửi</button></div>
    </div>
    <div id="partyView" style="width:100%;display:none;flex-direction:column;align-items:center;flex:1;min-height:0">
      <div class="plist" id="plist"></div>
    </div>
    <button id="socClose">Đóng</button>
  </div>
  <div id="inviteBanner"><div class="ibox"><span id="ibText"></span><button id="ibAccept">Chấp nhận</button><button id="ibDecline">Từ chối</button></div></div>
  <div id="partyHud"></div>
  <button id="guildbtn" class="menubtn">🏯</button>
  <button id="petbtn" class="menubtn">🐾</button>
  <button id="menuToggle">☰</button>
  <div id="petPanel">
    <button class="panelX" id="petX">✕</button>
    <h3 style="color:#e0b062;margin:6px 0 12px">Đệ Tử</h3>
    <div id="petBody" style="width:100%;display:flex;flex-direction:column;align-items:center"></div>
    <button id="petClose" style="margin-top:10px;padding:8px 22px;border-radius:8px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold">Đóng</button>
  </div>
  <div id="guildPanel">
    <button class="panelX" id="guildX">✕</button>
    <h3>Bang Hội</h3>
    <div id="guildBody" style="width:100%;display:flex;flex-direction:column;align-items:center"></div>
    <button id="guildClose" style="margin:10px 0;padding:8px 22px;border-radius:8px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold">Đóng</button>
  </div>
  <div id="talkBtn"><button id="talkBtnInner">💬 Nói chuyện</button></div>

  <div id="npcPanel">
    <button class="panelX" id="npcX">✕</button>
    <div class="nphead"><span class="ic" id="npIcon"></span><span class="nm" id="npName"></span></div>
    <div class="greet" id="npGreet"></div>
    <div id="npQuests" style="width:100%;display:flex;flex-direction:column;align-items:center"></div>
    <button id="npClose" style="margin-top:6px;padding:8px 22px;border-radius:8px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold">Đóng</button>
  </div>
  <div id="toast"><span id="toastTxt"></span></div>
  <div id="shopPanel">
    <button class="panelX" id="shopX">✕</button>
    <h3>🛒 Thương Nhân Elin</h3>
    <div id="shopgold"></div>
    <div class="shtabs">
      <button class="tabbtn on" id="shTabBuy">Mua</button>
      <button class="tabbtn" id="shTabSell">Bán đồ</button>
      <button class="tabbtn" id="shTabMount">Cưỡi</button>
    </div>
    <div id="shopBuy" style="width:100%;display:flex;flex-direction:column;align-items:center"></div>
    <div id="shopSell" style="width:100%;display:none;flex-direction:column;align-items:center;overflow-y:auto"></div>
    <div id="shopMount" style="width:100%;display:none;flex-direction:column;align-items:center"></div>
    <button id="shopClose" style="margin-top:10px;padding:8px 22px;border-radius:8px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold">Đóng</button>
  </div>
  <div id="qPanel">
    <button class="panelX" id="qX">✕</button>
    <h3>Nhiệm Vụ Hằng Ngày</h3>
    <div class="checkbox" id="ckbox"></div>
    <div id="qlist" style="width:100%;display:flex;flex-direction:column;align-items:center"></div>
    <button id="qClose" style="margin-top:6px;padding:8px 22px;border-radius:8px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold">Đóng</button>
  </div>
  <div id="chrPanel">
    <button class="panelX" id="chrX">✕</button>
    <h3>Nhân Vật &amp; Build</h3>
    <div class="pasv" id="pasvBox"></div>
    <div class="ptsline" id="ptsline"></div>
    <div class="statgrid" id="statgrid"></div>
    <div id="skgrid" style="width:100%;display:flex;flex-direction:column;align-items:center"></div>
    <button id="chrClose" style="margin-top:6px;padding:8px 22px;border-radius:8px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-weight:bold">Đóng</button>
  </div>
  <div id="inv">
    <button class="panelX" id="invX">✕</button>
    <h3>Túi đồ &amp; Trang bị</h3>
    <div id="res" style="margin-bottom:8px;font-size:13px;color:#ffd76b">🪙 <span id="rg">0</span> &nbsp;·&nbsp; 🔨 <span id="rs">0</span> đá cường</div>
    <div id="companionStrip" style="display:flex;gap:10px;margin-bottom:12px"></div>
    <div class="eqrow" id="eqrow"></div>
    <div class="grid" id="invgrid"></div>
    <div id="detail"></div>
    <button id="invClose">Đóng</button>
  </div>
  <div id="loginScr" style="position:absolute;inset:0;z-index:21;background:rgba(10,8,5,0.94);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px">
    <h2>Đăng Nhập</h2>
    <p style="color:#9a8a6a;margin-bottom:14px;text-align:center">Tài khoản mới sẽ tự tạo nếu chưa tồn tại</p>
    <input id="userInput" maxlength="20" placeholder="Tên đăng nhập..." style="font-size:16px;padding:10px 14px;border-radius:8px;border:2px solid #a87b3e;background:#171009;color:#e0b062;text-align:center;width:240px;margin-bottom:10px">
    <input id="passInput" type="password" maxlength="40" placeholder="Mật khẩu..." style="font-size:16px;padding:10px 14px;border-radius:8px;border:2px solid #a87b3e;background:#171009;color:#e0b062;text-align:center;width:240px">
    <button id="loginSubmit" style="margin-top:14px;font-size:16px;padding:10px 24px;border-radius:8px;border:2px solid #a87b3e;background:#2c2114;color:#e0b062">Đăng Nhập</button>
    <p id="loginMsg" style="color:#ff8a5a;margin-top:10px;min-height:20px"></p>
  </div>
  <div id="slotScr" style="position:absolute;inset:0;z-index:21;background:rgba(10,8,5,0.94);display:none;flex-direction:column;align-items:center;justify-content:center;padding:16px">
    <h2>Chọn Nhân Vật</h2>
    <div id="slotCards" style="display:flex;gap:14px;margin-top:14px;flex-wrap:wrap;justify-content:center"></div>
  </div>
  <div id="pick" style="display:none">
    <h2>Chọn Class</h2>
    <input id="charNameInput" maxlength="16" placeholder="Đặt tên nhân vật..." style="font-size:16px;padding:8px 12px;border-radius:8px;border:2px solid #a87b3e;background:#171009;color:#e0b062;text-align:center;width:220px;margin-bottom:10px">
    <p>Mỗi class một lối chơi — chọn để vào trận</p>
    <div class="pc" id="pcards"></div>
  </div>
  <canvas id="c"></canvas>

  <div id="hud">
    <div class="nm" id="me">#?</div>
    <div class="bar"><i id="hpb" style="width:100%"></i><span id="hpt">100/100</span></div>
    <div class="bar"><i id="mpb" style="width:100%"></i><span id="mpt">100/100</span></div>
    <div class="bar" style="width:172px;height:7px"><i id="xpb" style="width:0%;background:linear-gradient(90deg,#e0b062,#c98a2e)"></i></div>
    <div id="resBox" style="margin-top:2px"></div>
    <div id="pkBox" style="font-size:10px;color:#ff8a6a;display:none;margin-top:2px"></div>
    <div style="margin-top:3px;font-size:12px"><b id="lvt" style="color:#e0b062">Lv 1</b> &nbsp;·&nbsp; <span style="color:#ffd76b">🪙 <span id="gt">0</span></span> &nbsp;·&nbsp; <span style="color:#cfe0ff">⚔<span id="wt">0</span> 🛡<span id="at">0</span></span></div>
  </div>
  <div id="info"><span id="zonelbl">🏘️ Thị Trấn An Bình · An toàn</span><br><span id="bosslbl" style="color:#ffb0b0"></span><br><span id="cnt">0</span> online<br><span id="dglbl" style="color:#c77dff"></span></div>
  <div id="cluster">
    <div class="sk" id="sSwap" style="display:none;background:radial-gradient(circle,#3a2a5a,#1a1030)"><span class="k">⇄</span><span class="l" id="swapLbl">KIẾM</span><div class="cd"></div></div>
    <div class="sk basic" id="sB"><span class="k">⚔</span><span class="l">THƯỜNG</span><div class="cd"></div></div>
    <div class="sk" id="sQ"><span class="ic"></span><span class="k">Q</span><span class="l">LƯỚT</span><span class="m">12</span><div class="cd"></div></div>
    <div class="sk" id="sW"><span class="ic"></span><span class="k">W</span><span class="l">TIA</span><span class="m">18</span><div class="cd"></div></div>
    <div class="sk" id="sE"><span class="ic"></span><span class="k">E</span><span class="l">NỔ</span><span class="m">30</span><div class="cd"></div></div>
    <div class="sk" id="sR"><span class="ic"></span><span class="k">R</span><span class="l">CUỒNG</span><span class="m">55</span><div class="cd"></div></div>
  </div>
  <div id="st">Đang kết nối...</div>
  <div id="ver">v3.18 · UI túi đồ: icon trang bị PIXEL thật (đổi theo cấp) thay emoji</div>
</div>
<script>
var WW=560, WH=420;
var cv=document.getElementById('c'), ctx=cv.getContext('2d'); ctx.imageSmoothingEnabled=false;
var SPRITE_SHEET=new Image(); var spriteReady=false;
SPRITE_SHEET.onload=function(){spriteReady=true;};
SPRITE_SHEET.src='data:image/png;base64,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';
function drawSprite(tileIdx,dx,dy,dw,dh){
  var cols=12,ts=16; var sx=(tileIdx%cols)*ts, sy=Math.floor(tileIdx/cols)*ts;
  ctx.drawImage(SPRITE_SHEET,sx,sy,ts,ts,Math.round(dx-dw/2),Math.round(dy-dh/2),dw,dh);
}
var CLASS_SPRITE={war:96,cmd:97,arc:98,blade:99,mage:100};
function mkLPC(b64){ var o={img:new Image(),ready:false}; o.img.onload=function(){o.ready=true;}; o.img.src='data:image/png;base64,'+b64; return o; }
var LPC_BALD=mkLPC('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');
var LPC_MAGE=mkLPC('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');
var LPC_GOLD=mkLPC('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');
var CLASS_LPC={war:LPC_BALD, blade:LPC_BALD, arc:LPC_GOLD, cmd:LPC_GOLD, mage:LPC_MAGE};
function mkImg(b64){ var im=new Image(); im.src='data:image/png;base64,'+b64; return im; }
var PD_BASE='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';var PD_MAIL='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';var PD_TAB='iVBORw0KGgoAAAANSUhEUgAAA0AAAAEACAMAAACteuY1AAAAwFBMVEUAAABnWZNTN3IvHECAh72UnsR8g7kAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjLxbHAAAAMHRSTlMA///+////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxVMdxAAAJx0lEQVR42u3b3ZKcOBBEYUkFvP8jr/htmI51BJkYDeZ8EWuvL6qFSko1MHZKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIB/XPzxj3+/Pl1bn+4e/+L+/f4J49i/HH/449+vT2HW2wFoO/+f9XcH0B7/7fnph7LrWZTu3A5w61OY9XYA2s7/u/7eANrjvz5Aw76DUYbh5Aa4vv7eAPy++d8aQHd8ApSHPudY5KHLJe6sT1/1J9fP3YCN5/9dH/cG0F0/ApSHj772/+wG8OrHFTzWn74FMzfwL5t/3H0Amtf/+gCV2sF+al5V+3d2Acz6NK76vv78Q/TPDdB4/qcf4az5fwcgbp0/ASplWoJlHWr/zm4gr37dAlu9dBO63wCN53/6NZY5/8heAO31e3uA6glYm1cbl9cNEHfWTztgXy89xukb8Ov6izv/09dvzv8YwLh5/RHTDh4bmOf1D2EF9/WnlX19EaZgB9Abv/X8DwFI918/AZobOK+jHqC1Xt1Ay29SgK4IgDx+aTz/QwDT/ddPgOb+zR1UA/Sp1xZwrdcDJG/AMMcvjed/CEC6//p5jVDm/qkdjH29soEO44sBcjagOb5bn/f1bgCSe/0kSGvg1ENtBWJfH9oOcMZPV2xgY3y3f4fxvQCUYq8/AdLugDbqM8Qi3AvQZmBtYHP8S+u9AJQW6/96w75/wzMD5FzAcf7Zqu8G6+oH9/xSbuHd9ecZaJhaOL4F7brzP0Zz66dbwE+9FKDOCdCV81d+jr+rV8rDy9/P9SMQQge7avxBtvY3CWsArPoU4xUY9XME5w0wxO3X79cv/T/7Q9z1G2QLgPQIZK8/YqdF/f4T5G9RK8BXzD9d0D/vACzqB9jrh3/nDGDuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwHNFbP/30AkkbwJuPfN/t7ImKOKZCxjmBOz6xvN3F9DeAC//AupymeVok0BzA7sTsBsQbTdw8/m//QZu6V+Xu0gPXEB3AnYD3j7/tweo76cG5l7dP40X0J3AoT4ePv9osAFefwdXG1jVX/tsLmC0SPBhAnYDou0GjvsX0O0ft3Dd3L7axWJu4GiR4MME3AYIHbADeOX8G/SPBNV7hzy2MOcS3gb0E+xOwK1XAuQG0D7B3AU0+0eC6u3DrIS3Af0EuxMQy7d66Qj3Anisl06g3fWb9aRBaeDyEkhb/t0GviDB7gTcevEId08gKwCH6/fqCYO2fuvqFSOB1yTY2n/qVewaEC1OILM+7Otf80sW1C+AlZ7AKxIsvwYZd850/aF/QNE/4IoNXIpcH7vrT049UfACJG/hMHvvrl/MW0C/BV12UC7iXwVwA7jVe+PLd5BBfuxnIP0OfPqACx7CnA+ImN8AiLdwy2sEfQNfEkB5/LK+BlDvYOd6kmDeQeVhEPf/1nz1GWC8g/FPgdC/gdYARosALk9x8vjTDey0gOrowROQd36XMT1Dzvr+WVdSTaC9fiHnZ/cg5QZQD1BY+R2vvi6g/Ag47oCBJFgZmp5k5R1U5vyor4EvSZD5l/G9BDoBnNo/PYnoATbeoSzD8xB0QYjc9wBhPQSktv+iK7wImuVm/2fm8Px7oLa7z1iACBYQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8GyL+/0+31Cev3p5/ajz/aDz/xuM/Pj9d2fUsShc31+/LhfofCTi9AdzxL+7f8XLOB8Bd//Pjvz0/fZc/Pavr3/Vxa31XF9Co/7GBTm9gd/xx/vm6/tUP6MMIwOk42eMToLoB6haaldz1XTypPkX2A/Cb5u8GMEe6c3wC1E0dXIz9O7kBmtfXDeRs4KfP/xiAsQG3jk+A8tjAuYX1t7GdwhGm17vj2xvwa/xId9Z/9y9S2/lnAnTuGXo8tPpu0vfTcX7yA6x6d3w7gD/HP/8S4sf1n/4Aa/xwA+iu/+sDNG+Afu7ftAFC2AB6/ff4LQ6Az/jnXwL+hnr3ADDWn6+gem7VvtVDbPxdOUGb1psB/Jq/sIEvrU83B/B7/QnQ2SN8+fqf76TP74BjvfCDmEN9un0DuuOb9cmtNwNsr//r5ekmemXWC+0/DJ/NDXh+/HDHv6J/40d00y9Ja4ATwMP4BOh8/z87oHT5/vrdBpTqU95tgLh/fL9/XgDTPgDJHb8QiPMHWJ57OD6P5/vrtx2s1qeLAtBo/qXsAugdgFJ+DuNn8iBtv/XHCNItiFmf5g2o1+9uAo0ANJv/WL4FUDsAna+PchifAIkn2PJjOGUJ3Pq0Pb+K9WnbAF4AGs2/7AOYvACmZI7PLZzUwM45w9z6NG/ApT6kLbRtAKG+mOOb849DAMUDcJ2/UH4cvxAgpYN5+jmcuH/d+rTbgNL4nw1gB6DF/MN7iIntDZwYwMP45Efp4E6D+v0GDClA1wVAn3/S5x9NA7j8JM04APHsAEf2AuCeH1dOXwywdwCkxg3Aw79BmT8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwe8T2P/Hoy0/RpJ75vz5Asf5enriAn8tvVP9r5l+a1CNymeUumi5gtLh8v/6yAJdHzh/R5W7tYDxwA3uX79e/fP6oHezz1MC+jwduYPPyzfrW87/i+q168pP72rquqr9qR3DTBfQuP9zpR+MA28vn1hOgMvZuaqF6hFob0F1A7/KjmPV2AN16d/ncegJUch67V38tWgPbLqB3+TVAbr13/WHXm8tnLz8ByrOiNrDtAnqXPwVoqW8RwHRF/Tp/t38EKIlbaHkNpDbQyp+bX+/yo5jTd8+fYte7y2cv/9uVdQ2dr3B9AdwN8Ln8IifImH7YAbTrt+tX7yD85X97gBZOB50FsBYw5ksv4i1IfGZvb2C9fvovvOUL+RbMrX+5+f7fDVByyp3hlyM8xPWPWL4BQg+QFcDw6tN6/c4jzHIGESD1HmrOkHcTbJU7t3DzewD9b9JM5U4AvABu93AhP8MsrwD0v8u21BMgyTA4N8Hbso2bWF/BcRerJ3A42Y9PAKNJAMv6AeoUhiVAxQlQbUAhQNoOynkYMyQeoeu6efcQU4BDj4Cx9BHWpUd4AVwPAH37Rl2++QtEnsSQvfpX5yfKHB7jEX6+kzLa770F8p5+zfy5ARw7GFP/Q/8A4xlwO/x4h2CcoeEUey8gYnuGjQdO/4oPuKI+rK9QstM6f2YEWUIAAAAAAAAAAAAAAAC8xX94r08VVk4RdwAAAABJRU5ErkJggg==';
var PD={base:mkImg(PD_BASE),mail:mkImg(PD_MAIL),tab:mkImg(PD_TAB),helm1:mkImg('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'),helm2:mkImg('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'),helm3:mkImg('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'),ready:false};
var _pdc=0; [PD.base,PD.mail,PD.tab,PD.helm1,PD.helm2,PD.helm3].forEach(function(im){im.onload=function(){_pdc++; if(_pdc>=6)PD.ready=true;};});
var _tintCv=document.createElement('canvas'); _tintCv.width=64; _tintCv.height=64; var _tintCtx=_tintCv.getContext('2d');
function rarityFX(it){ if(!it)return{tint:null,glow:0}; var t=it.tier||1, pl=it.plus||0;
  return {tint:(t>=3?'#c77dff':(t>=2?'#6bd0ff':null)), glow:(t>=3?9:(t>=2?5:0))+Math.min(10,pl*0.8)}; }
function drawArmorLayer(img,col,row,fxo,dx,dy,SZ){ ctx.imageSmoothingEnabled=false;
  if(!fxo.tint){ if(fxo.glow){ctx.save();ctx.shadowColor='#ffe9a0';ctx.shadowBlur=fxo.glow;ctx.drawImage(img,col*64,row*64,64,64,dx,dy,SZ,SZ);ctx.restore();}
    else ctx.drawImage(img,col*64,row*64,64,64,dx,dy,SZ,SZ); return; }
  _tintCtx.clearRect(0,0,64,64); _tintCtx.imageSmoothingEnabled=false; _tintCtx.globalCompositeOperation='source-over'; _tintCtx.globalAlpha=1; _tintCtx.drawImage(img,col*64,row*64,64,64,0,0,64,64);
  _tintCtx.globalCompositeOperation='source-atop'; _tintCtx.globalAlpha=0.4; _tintCtx.fillStyle=fxo.tint; _tintCtx.fillRect(0,0,64,64); _tintCtx.globalAlpha=1; _tintCtx.globalCompositeOperation='source-over';
  ctx.save(); if(fxo.glow){ctx.shadowColor=fxo.tint;ctx.shadowBlur=fxo.glow;} ctx.drawImage(_tintCv,0,0,64,64,dx,dy,SZ,SZ); ctx.restore(); }
var MOB_SPRITE={beast:111,crawler:122,brute:109,ghost:121};
var DRAGON_SHEET=new Image(); var dragonReady=false; DRAGON_SHEET.onload=function(){dragonReady=true;};
DRAGON_SHEET.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAawAAAF5CAYAAADDOx4wAAAACXBIWXMAAAsTAAALEwEAmpwYAAAKT2lDQ1BQaG90b3Nob3AgSUNDIHByb2ZpbGUAAHjanVNnVFPpFj333vRCS4iAlEtvUhUIIFJCi4AUkSYqIQkQSoghodkVUcERRUUEG8igiAOOjoCMFVEsDIoK2AfkIaKOg6OIisr74Xuja9a89+bN/rXXPues852zzwfACAyWSDNRNYAMqUIeEeCDx8TG4eQuQIEKJHAAEAizZCFz/SMBAPh+PDwrIsAHvgABeNMLCADATZvAMByH/w/qQplcAYCEAcB0kThLCIAUAEB6jkKmAEBGAYCdmCZTAKAEAGDLY2LjAFAtAGAnf+bTAICd+Jl7AQBblCEVAaCRACATZYhEAGg7AKzPVopFAFgwABRmS8Q5ANgtADBJV2ZIALC3AMDOEAuyAAgMADBRiIUpAAR7AGDIIyN4AISZABRG8lc88SuuEOcqAAB4mbI8uSQ5RYFbCC1xB1dXLh4ozkkXKxQ2YQJhmkAuwnmZGTKBNA/g88wAAKCRFRHgg/P9eM4Ors7ONo62Dl8t6r8G/yJiYuP+5c+rcEAAAOF0ftH+LC+zGoA7BoBt/qIl7gRoXgugdfeLZrIPQLUAoOnaV/Nw+H48PEWhkLnZ2eXk5NhKxEJbYcpXff5nwl/AV/1s+X48/Pf14L7iJIEyXYFHBPjgwsz0TKUcz5IJhGLc5o9H/LcL//wd0yLESWK5WCoU41EScY5EmozzMqUiiUKSKcUl0v9k4t8s+wM+3zUAsGo+AXuRLahdYwP2SycQWHTA4vcAAPK7b8HUKAgDgGiD4c93/+8//UegJQCAZkmScQAAXkQkLlTKsz/HCAAARKCBKrBBG/TBGCzABhzBBdzBC/xgNoRCJMTCQhBCCmSAHHJgKayCQiiGzbAdKmAv1EAdNMBRaIaTcA4uwlW4Dj1wD/phCJ7BKLyBCQRByAgTYSHaiAFiilgjjggXmYX4IcFIBBKLJCDJiBRRIkuRNUgxUopUIFVIHfI9cgI5h1xGupE7yAAygvyGvEcxlIGyUT3UDLVDuag3GoRGogvQZHQxmo8WoJvQcrQaPYw2oefQq2gP2o8+Q8cwwOgYBzPEbDAuxsNCsTgsCZNjy7EirAyrxhqwVqwDu4n1Y8+xdwQSgUXACTYEd0IgYR5BSFhMWE7YSKggHCQ0EdoJNwkDhFHCJyKTqEu0JroR+cQYYjIxh1hILCPWEo8TLxB7iEPENyQSiUMyJ7mQAkmxpFTSEtJG0m5SI+ksqZs0SBojk8naZGuyBzmULCAryIXkneTD5DPkG+Qh8lsKnWJAcaT4U+IoUspqShnlEOU05QZlmDJBVaOaUt2ooVQRNY9aQq2htlKvUYeoEzR1mjnNgxZJS6WtopXTGmgXaPdpr+h0uhHdlR5Ol9BX0svpR+iX6AP0dwwNhhWDx4hnKBmbGAcYZxl3GK+YTKYZ04sZx1QwNzHrmOeZD5lvVVgqtip8FZHKCpVKlSaVGyovVKmqpqreqgtV81XLVI+pXlN9rkZVM1PjqQnUlqtVqp1Q61MbU2epO6iHqmeob1Q/pH5Z/YkGWcNMw09DpFGgsV/jvMYgC2MZs3gsIWsNq4Z1gTXEJrHN2Xx2KruY/R27iz2qqaE5QzNKM1ezUvOUZj8H45hx+Jx0TgnnKKeX836K3hTvKeIpG6Y0TLkxZVxrqpaXllirSKtRq0frvTau7aedpr1Fu1n7gQ5Bx0onXCdHZ4/OBZ3nU9lT3acKpxZNPTr1ri6qa6UbobtEd79up+6Ynr5egJ5Mb6feeb3n+hx9L/1U/W36p/VHDFgGswwkBtsMzhg8xTVxbzwdL8fb8VFDXcNAQ6VhlWGX4YSRudE8o9VGjUYPjGnGXOMk423GbcajJgYmISZLTepN7ppSTbmmKaY7TDtMx83MzaLN1pk1mz0x1zLnm+eb15vft2BaeFostqi2uGVJsuRaplnutrxuhVo5WaVYVVpds0atna0l1rutu6cRp7lOk06rntZnw7Dxtsm2qbcZsOXYBtuutm22fWFnYhdnt8Wuw+6TvZN9un2N/T0HDYfZDqsdWh1+c7RyFDpWOt6azpzuP33F9JbpL2dYzxDP2DPjthPLKcRpnVOb00dnF2e5c4PziIuJS4LLLpc+Lpsbxt3IveRKdPVxXeF60vWdm7Obwu2o26/uNu5p7ofcn8w0nymeWTNz0MPIQ+BR5dE/C5+VMGvfrH5PQ0+BZ7XnIy9jL5FXrdewt6V3qvdh7xc+9j5yn+M+4zw33jLeWV/MN8C3yLfLT8Nvnl+F30N/I/9k/3r/0QCngCUBZwOJgUGBWwL7+Hp8Ib+OPzrbZfay2e1BjKC5QRVBj4KtguXBrSFoyOyQrSH355jOkc5pDoVQfujW0Adh5mGLw34MJ4WHhVeGP45wiFga0TGXNXfR3ENz30T6RJZE3ptnMU85ry1KNSo+qi5qPNo3ujS6P8YuZlnM1VidWElsSxw5LiquNm5svt/87fOH4p3iC+N7F5gvyF1weaHOwvSFpxapLhIsOpZATIhOOJTwQRAqqBaMJfITdyWOCnnCHcJnIi/RNtGI2ENcKh5O8kgqTXqS7JG8NXkkxTOlLOW5hCepkLxMDUzdmzqeFpp2IG0yPTq9MYOSkZBxQqohTZO2Z+pn5mZ2y6xlhbL+xW6Lty8elQfJa7OQrAVZLQq2QqboVFoo1yoHsmdlV2a/zYnKOZarnivN7cyzytuQN5zvn//tEsIS4ZK2pYZLVy0dWOa9rGo5sjxxedsK4xUFK4ZWBqw8uIq2Km3VT6vtV5eufr0mek1rgV7ByoLBtQFr6wtVCuWFfevc1+1dT1gvWd+1YfqGnRs+FYmKrhTbF5cVf9go3HjlG4dvyr+Z3JS0qavEuWTPZtJm6ebeLZ5bDpaql+aXDm4N2dq0Dd9WtO319kXbL5fNKNu7g7ZDuaO/PLi8ZafJzs07P1SkVPRU+lQ27tLdtWHX+G7R7ht7vPY07NXbW7z3/T7JvttVAVVN1WbVZftJ+7P3P66Jqun4lvttXa1ObXHtxwPSA/0HIw6217nU1R3SPVRSj9Yr60cOxx++/p3vdy0NNg1VjZzG4iNwRHnk6fcJ3/ceDTradox7rOEH0x92HWcdL2pCmvKaRptTmvtbYlu6T8w+0dbq3nr8R9sfD5w0PFl5SvNUyWna6YLTk2fyz4ydlZ19fi753GDborZ752PO32oPb++6EHTh0kX/i+c7vDvOXPK4dPKy2+UTV7hXmq86X23qdOo8/pPTT8e7nLuarrlca7nuer21e2b36RueN87d9L158Rb/1tWeOT3dvfN6b/fF9/XfFt1+cif9zsu72Xcn7q28T7xf9EDtQdlD3YfVP1v+3Njv3H9qwHeg89HcR/cGhYPP/pH1jw9DBY+Zj8uGDYbrnjg+OTniP3L96fynQ89kzyaeF/6i/suuFxYvfvjV69fO0ZjRoZfyl5O/bXyl/erA6xmv28bCxh6+yXgzMV70VvvtwXfcdx3vo98PT+R8IH8o/2j5sfVT0Kf7kxmTk/8EA5jz/GMzLdsAAAAgY0hSTQAAeiUAAICDAAD5/wAAgOkAAHUwAADqYAAAOpgAABdvkl/FRgAAuf5JREFUeNrsnXl8VOXZ/q8zk5BlJjND9oUEQ4ghQJRhMUBFBSqK2ioWXmlftViwi3W3tlJbt9atVtRqbfsKisuvL7xQwFZcsAEFyxZgwAAhhBBJyDJZJ5PJRpI5vz/O3M8858yZLKxJeK7PZz6ZzHLOrOc71/1cz/1IsixDSEhISEhooMsgXgIhISEhIQEsISEhISEhASwhISEhIQEsISEhISEhASwhISEhISEBLCEhISEhASwhISEhISEBLCEhISEhIQEsISEhISEBLCEhISEhIQEsISEhISEhASwhISEhIQEsISEhISEhASwhISEhIQEsISEhISEhASwhISEhISEBLCEhISEhASwhISEhISEBLCEhISEhIQEsISEhISEBLCEhISEhIQEsISEhISEhASwhISEhIQEsISEhISEhASwhISEhIQEsISEhISEhASwhIaHzr7S0NFm8CkICWEJCQgNa1rhYuaysTLLZbAJaQgJYQkJCA1dNtXWSeBWEhqJCxEsgBAAhIeKjMJSUnJwsezwe6Ty/rzIAAcvzqK6urovq+UqyLKoGQgJYQ0mm4Ta5pdElAYDZbFZ9wT0ez7kEipycnIzKykoBLQGscyJREhQSGmq/Qju7mMtq6+qCHBqCa9LTsTg9PQBgZ1tP3j0fycnJ4lewkHBYQsJhCek7G2hKccnJyXJTWyt4p7U8KQk7wsOxorT0XDktuauriz5LwmUJh3X2j1PiLRcSGvSwCpC2LNd2Hg9sPmiJ8Syhsy5REhQSGsSw+tuT9/fpht3t7fggPBwA4PF4zumDqis7IN4ZIQEsISEhtRb/dlmfwJacnHxeHs+K3z2M2LTLxRsjJIAlJCTkh1Bv4xdms1k2m83yAzk57LKSc/ygbv7hD7Hidw+Ld0fonEiMYQkJDVLVlR0I6mbMZrO8OD0dAPDyFWmYtrUdHwD4qKAAOHdjS1LiqEny3568H6syM7GwuPicjmNdbIEDIQEsIaFBq55gtTwpCTt8sPI4HNgRHnOuYQUAsmtiMsKTInHCGi7eIKGzLlESFBIa5C5Lz1nVf/tqBisAeO3cwwoA8GmzCSH5BUjw1jOIiXdJSABLSOgiV9fy3yCiZQLuvW42A0NbVxcuvTIXn3y160I8JGlhcTFKDpTh02YT4qKjxZskJIAlJHSRiwUpwv7zON74LI9d0d3ernZcdjuchpjz+uAcTcpjyE1JEe+UkACWkNDFDCufo0JIfgEAgE8BAsAnX+1ChuZOqzIzmQs7X8oQ75WQAJaQkNBXXV0oOVCGkPwCTNO4KtLarUcBAG92KP/fpIDtvEGLe1xiHEtIAEtI6KL7whoM2FFWqQKRPUgi7+GWFqzdehQvX5GGHeHhyDg/TktaWFzMHpMYxxISwPLJZI2U+ZN4O4WGuGR7Vhb7pwRgKUAeGL74OgDgg/BwBi1yPEWTz73TcjS1BwWpkNDp6oznYfGgaGlqPa/NLml/9Bjo7/l+HENBF3oSpsmSrrx37tKz9t4NxQ70ZU4n0hIS4GrxIGq4DQD4CDnTmvp6LIiJwZr6eiAmBth6FLc88j2cWL4RjqZ2FE3OQdaegnM2sdduDWfhCyGhAeOweDhcKMdDj2Hc4isxYuJYCMd14TQxfZI8MX1Sv157gpXednrbVn/3NZQ0PjEegJIENPngRS6rsrKStWHaV1+PJVVV2PDyPzByyY2wW8PxSAcLa5yT1y/BWy8cltDAAxYBgwfXiIljVeA4H/BoaWqVDq34ClZ7tADXBQTVGOswjLEO6zNITJZ0OSsmWvU/AWxeigF/mNKJiemTZP5y7f4uEslx0dGwmE3sgoPVNfi0Wfl/yYjUAPjsq6/HxJgYNLW1Qg4NwX+Xl2PDy/9AxuVpyIBSUjyX0Mq4PE18MYTOqs7JAo4ma6Q8YuJYWO3KgajJ0YCT+w7rurJzse9xi69k/9O+RZnw3IEKAMZYh2HyFUns8j27q3Ck6RSK6huClvkIVkX1DQAAAhf//7wUA6Yld+CX+aEYYx2GbLNSupyW3IEdlWEo9ITgSNMp7CvdG7CPIVYSZMCymcxwtXhgM5mRFBKCtT+/ESeWb0TWnoBuFrIvGYgtJ8shdXbBYrFgS3IM3uxQgLWvvh6VlZXa+53xY3VNTIbZbkfS+h2od7ng9XrP9j5EL8GLUOfkG93S1CqZrJHyyX2K27rujijgjlwAwGfvN0PP9ZxNoLjW1UJKN8Jqj/adrhTjW2f7h4EPNlpQZUdZlTNXANhdBSBad3yKQFdU38BARUBaDz/EAGD2bXH4A2oxeaIDe/aNx+zb4iCN+xFmH3obv3/FDWDYRff620xmAEBhk4u5mQc6gNcK1ONS5LKsEZFoQiua2lrxZod/IvHEmBgsiIkJuN+Zymy3o+RAGQAgxmZDbUOD+NIIDUyHpXU8gDK+9NTsMFwx5W4AwO78t/Cp08MgxjuwMwWLyRoppwzPgpRuBABdpyfAdWauSgsqFax8Kmxuwp7dVQCAD49Xg6A1MX2STKAiSE1L7mD3e/uoibmzrJhobP6JA9bMmWgq3qK8n5kzIY37kfJT/tDbyFtdi7ePmvD3/TukIeqwZIqHk8MCAFeL8v35ON6GkUtuREh+AUJWbOSdjGw2m2GxWAAATh805mZmYl+9EtRYZlJKiguLi8+WA5JvysnBhivSsHbrUdzn248PWMJhCQ08h6UHHpM1Ul6wAhi3uANTx3fiiZsewhW+2zxxUyDAzsQRkcMbkT6WgYp3W02OBpiskbKA1tmD1Z7dVciebdW9zx2zxzAAkdsiWP3o0hZMnnhQBaQdlZPw4XH/L/LXP5qE+25SrrtnVS7eXLgFVoBBa/LEg9hROWnIv/Y0fhU1LMQHLOXyRzqADfkF6JqSgy4AISs2kluSPB6PTMDi5Xa7AQC0ctVNOTn46Cy5rA9C6wGksRWOhYQGDbC0EHGtq8Wn64BPn3kSUroR190RhesTzLhiyt0MYNcnvIVPnVEB5cPTAYxc2g0p3YgmRwNzW4rjGiugdRqisaIfTJgWYM0Lm5uYyyJ3dcfsMQCUcl9RPTSuyg8radyPYAWQt7oW05I70Lb9BCLMI5VteULw+keTMC25A0eaTgVAywrgvpu2YGL6JFlvLGuoq7DJhbVb2zGfnMfiG3lowe12w2KxIMLnOMldXZOejtvb27G4rha3t5sAP7RO1w3JqzIzYbZfipIDZShsbRVfGKHBCSweWgCQMjwLcmk3Pn3GhU/hAuAHGLmvJ27y3/dbtz3TL3gxlzVxLOTSbuUb6AOXgNaZS1t+YxC7wl8aJFgVNjch29yFI5yrImfEl/dIOyrDAg/KnhAUHg3B/hO7UGQeiSN/s2PzTxRoNRVvwZ594zFEE4NyRloq3J6Wnl1NeDiw9Siuj1Ju55qYDNu+StbBva2hAREhIWjr6oLFByvq9Sd1duG/y8sRHhGOm3JyUNjaipKSktNyW/OvupS5PnSeEl8UobOqcz6GFUwEE94JqR6Yxn2RnvnoFdWYV0+wMVkjZYuUjChblGq75LQAkSI82/rBhGny5CuSsGd3laps2HK4HICS7iNQadVUvAWvfzQJ6yu82H/CgQjzyIBARqEnBL/77T5cdlcybh6ViDcXKsto7Nk3Hjsqw7C+wstc4BAZw2LAopJgqm/OVXmjS3XDZ8OUEtz1US0w2+3wOByw7auEUVOaiwgJwTXp6cxpkSbGxGDLSeV9alG23Z/vhNy1+EZ0TcnB/D9vBADsqqiAxWyC29MixrCEBjewCCgpw7NguzWOwUMPXgBw/RM2PHHTQ/0Gl4DW+dWyH98qU6R9jHUYjjSdYsD50aUtmH1bnP99GPcjyIfeZmNXe/aNVwUuSHy8naLsq77ehYWX5arcGt2f3N9QAZY2zp463IbyRhf7S8q22nB7ezt2hIfjHp9JTfDWw7ZP6T3IgyshOhpNbUrJbuaIVGQAWH6yHCti47AjPBwlALgWT719LxisNrz8DzyuRNhRWlqKGJsCVwEsoUEPLB5aFENnv7Z14EW3+fixe9llFNZY8dAuXXARsAAIaJ0HGQwGecJIO+alGJijIsi8uXAXc1a9warN4x/D0ksT0rwsPrQBAL9/xY3ffpU/VIClSgeSKCUYNSwkwGXx0KLegXZrON7sYKsOwxgejvCIcMxUJhsjA0pn9YXFxViVmYnro1owqSkC1Q315LR6go0KVhS0KGxyofRkBdJHpPAO66xCSwBLAOuCQ4uHSE/w4h0XQYsc1+lC69CKrwSwzhBUAPCHKZ2YPPEgu47KddpyIA8rghrF33lg8dACwFzV20dN+H+/jVSNgf37iRfxy/xQ7CvdKw0FYFE5kPoHErB4p0WisuFNVhumtbfjA1+HdsC/1McH4eHMOfGTiqkMeFNODjLgh5v2eKF9fEWTc5BxeRo8Dgcyv2lnizby5UDOYQlgCZ2RBsQ3OlgMncTO25XrKKzx2fvP4JVfJHEJw1fwWT+CFHyCkFo6iRDG6cOKXFDAGNW+Wua0gPGYjC0BMNPCSg9apLePmpBt7sKPLm1BU/Eu2DShDXJ3Q0V67iqY3J4WfARgWlg4bvdBCwDg+5sBpR0TX/IzDbdhyYhUPJ0eiU+bFaeVkZGBQ48uQPhPX4BpuI2cFh/EkDMyMlj7Jdu+SmRkZDB3Ve9yscfeW2BESGhQAUsLkJ5ktUcDdv//T+V14Cm8hSum3I0nbnqIReIFtM4frBZelqsbUyfNvu1tFlcn57Vn33gACAorAPB6vZLBYJAjzCN9Y1rR3LjYMKASAMZjdubb7D7ffuZXmH3obeqkMZjfQznYWlLktHi3xcPB7WnBB77SIPUMXOPreEGO6/b2drysLDOCiSXlKAFwe2cMMsKB5ORk7LW2sRWNWxpdrLluS6NLVZLxOBxwGpTOGdmRkdhXX4/q6moBK6GhDSyty+I1dXxnj/f91NmJTz96RYnDc25L2wKKLwcGA+XU8Z04JD4X/YIVjSORmoq3AMVbVODSKxECYL0AtfJ6vVJP0KLQBSoBrK7F5IkHMetvdmz+yR1Iec6fLhzszorKgVHDQthEYZvJjDKnE1B3aGeqd7mwC0Dh8OG4yeeqEKNAZU19Petu4Whqx/yrLsU+H7QAYF9EJA4n+mF0U04O1v78RvzqzxvxWkEBDy7lu9dswgfhikujvoQGg4GFLejxGAwG6icoJDQ0HJbKRfUCqusTlNIIH3nnRW5rwQ/yAq7TujgaG2tyNADjo7D4lVzhsvoAqwkj7Sz5J417PyBEMRkKuABoOlmoYUWJQN5daeGlhdaEkXYGrcKjIdhROQnzUpT9fng98Mv8wf8apw634ZDPoTSf6gpoyaSntIQEBol6lwsfpafjpshIBUY+oCwEW3kYJQfKkHF5GmZ2KK7r+qgW1gEeAG5HO3Na7X99DO3/8x5LHZaUlOAD3zgYF85QgYlKg6KfoNCQBZYeqAhQwSDFt3ZinTOm3I01fwcW/CAPbrkSUcjSLTlK6UbmsnYeDMXU8Z1seRIBLX1REpCPqfNgevuoibVL+s1DFpW7IlgNT7ACTbU9wkoPWvxjoFLiEer6/rUS0BjkoQtVOjBqWAiaT3WxoEWZU11m48uCPMy8Xi9KSkqwJjkZC2JiAN9SIy2NLnwQroxxOZraWZlwR3g4rkeLClp2azhrYhuSX4DwH98JcONaHxUUKEGNtFRUNzer3KHOjxzhsoSGBrBoWRCCFQ+oniD10B+rVJ0sAAB3AMh/KwBaFY1FGHfrlX43peO6yGVdd0cUVuwTH5Bg2n/Cgc0/AQAFUHtW1zL3VOjJZeNMlOijbhQ0ZjX5iiR88PkJFmHvi7xer2SypMv88iN8enCMNTHoUiODTeNSU9j58Ynx2FFWGRC4GJ8Yj4PVNWg+1RVQSgT8ybzKykq8Xl2NxMREJEbHoNrntjJ8ZUL7gTIW0Li9M4Y5q+ujWvBpE9hCjB6HA+FT/I4qIyMDJSUlDFoELINBCb3Q+BVBSsBKaEgAi2D11OwwAGFBIUUuaufBUJYW5GHjTxZ2Km6Lg9biV5S5WodWfAXtWl1aCZfVN1HZjwcRADZpmNauIljxzqrkRGufnJVWLe5SSbtCMT8GNlR6CRKMUjXjVOMT47G1QBllPVhdo3tfm8kMt6cFcdHRqjKcb90rmIbbEBERwS6npez31dfjcCLgNMTA4VvdnqB1jzUcTsRgJJSU4Ys/vxHhP31BBS0trCxmE2obGthlQkJnqgExcVh7GXW/ILe182Aou861rjbAFWnnbVFZUTvONTJzIdt+sInKpOvuUAIaKx7aJeZm6b1vlnT5scticd9Nexm8aOKvdqFF0o7KMFSbYpAxMhJ7dlfhw+PVPY5bnfGvscFZEpTjoqPx1G23Ys32XQEuKmpYCAPWPdcqUwd2lFWyBR35kiA5HBpHIoeTkZHBxrWm+Zrf0iTil8MUgNEcLpq/ReVBR5MyKfnlK9LQNSUH4T99AWazGR6PelyN5o8RMDl4inlYQqetC/7Tp6WpVdKeKhqLcGjFV1jx0C58+owLTY4GdpLSjewUDFbBSomLX1EWkaxoLIJc2q2Cn3/5EWV7n72vlDfIZYmPCvehMRhkckvknAAwSJG0sDKNVQ6KJSdacaTplC6saIyK9nEx6rYp/nkb2aPS2fmoYSEYnxgPAKoUHqAENGiMi1yWVnxrphIAH7W2YnFdLVoaXbgkOR4fFRTgkQ5lLOt2DlTXRynjWuTE7gkDG9cimc3q/fG9D4WEhgyweoNYRWMRTu47DLm0O6DHYDBYkbsKliBMGZ6lcmxNjgZV0IOHFjktAS0/rCLMI9HmOYEjTaewozJMBS097agMw+Tc8ciOsiJjZCQanU2qXoHkqLxer0SThSPMIy9aaGWPSkfh8VL2P7kr+quFFYkgRdCymE0qd9Xtg1BJSQkKW1vxrMGAFbFKaOaNz/JY5wuC1NOh9b0+1gdycuDxeJCQkICMjAwVuMQcLKGzrQFfM+EXgASAFASW8/oCq935b2HFQ7tUsGI1mNJuFZx2HgyF1R7NyoTjFl+JQyu+uig+ELR0PS8eLuSAKGJeaE30TeANDitAWWKExq305l3piaB1NsqDg0SqycLkpniHxUs7hqWUA82YlpbMQhrpI1JQerIiYEfVDfXYMSIVT4fWwzUxGSmlrdjnm1zM63GvF2g2+RraevGswQBHkxLIOLF8I4PWawUFMJvNSEhIQKvOOlhpCQlUEjyT9bb6d3A7SyXheCm2Xz+cauS6Aft5PVvP5UKVYwdNkZ8mFlc0FkFvcrEWVtqYu958rGDQYm5rfBTb7lCeTKyFFD8GBQCFvvSdFmCKy4oGwDemDcMLX1cDo/wgM41NRcmJVjQ6m9g2+HIgXwYk98b/vZgUrByoBZjFbELzqS4GJ5qnRWNYFIUnt1VSVo646Gi0yl5YI5Txq+UnyzEtNg63PPI9NOUXIO0TB7acLEfU9XPx5EFlovezBmVyMbYexfyrLsXarUdht4bDiXClLdPuMgatFaWlcDqdiIyMDAhb7C0sxIwbb8KWDzcoAEtLkysrKwfFgT0++bLA40VCXPA7O/LkgQIwLaDi7LOD3lZy1gZeWPm1PJBAPKhGpQlacmm3qj2TNgr/zEev+IIaSppwxb5deORPf0Pbwa/x5v/8GSnDs1DRWKTaNq3NRQnBi8lNaQEFqH89ZZu7kG02sBQg4HMBvrlP81Ji2XjVbx6yAK/ADy0Ad0RZgZHKuMmOo7UBLkr1HrtLFUdtSZdp7tXFVg5cs30Xmk91BQCLXBV1wEgdbkP2qHQWyogaFoIyZwsOVtcwuO0oq8Tc7Evx5skKFoAgYM0ckYrFJ8sxP78AXVNyUAbAuu4/eD/SDVyRhrW+BSFLDpSxhSEXFhf7H8yeArgmJuPJzhiUALBYlPl2breblRe5JUqw5vWnCVZYkDsFr63/cMC1z6IDPEHK2NgINDYG3lDvMgDdw4ez+zKocQA7Hwd9HlIEKAYjZ63ynPqopIhUdA8froLXhQTXoJ1ZyUOFQEUd2/nIOs2nWvXkMmzfrXxheGgRqE7uOwyLlAyrPZqlEvVSikMJVvxS9UBg+yS+pEfgKvSEqNa5avOcwLTkKO6+M/GbhyyYtroDN39ajZtHJbJyIDks7fgViS/9kQO7mMqBBoMBhcdLGXwAqMaySMECDeMT49F8qgvljS4GrKhhIThYXaPqNNHU1spSgYASoEhwOGC227EvIxVdU3IQkl+gzL/ytvi6sdcjZMVGVB/fi8O7d+DD1Z9jxed5sO2rRNHkGGUCsq+cWBITg8LWVnw8PBIfQekK/0Wp8jy2rv0rKisrseLzvAH3+sdLsQFuih2s+yBjY6MaBr7z8cmXQU6IQ3xOJvDeX8/ZQZ9ANe7On6KmoBiSsxbGI0eDgrXf26fXRgHXBfleDkpgXf+ETQWqp/I62HiTqq3TeH/vwIrGIky/4kls3/00/rlnC1v48eS+wxgxcSxGTByLk/sO49AK/4DMIY27G5qw6tDt81foCVGtP0XwImjxmn1bHPJWK/f77XJlnavZt8XhscowrK84hclBHkdP5b6LCFRM6SNScLC6Bq4WD6alXarrvnaUVTJYNZ/qYkCblpasAhrdPntUOt7+4j8AlKa2NEZFS4pYIyIxs7Iet+Zkw7i7TImr+7bzSAfwclgMzFC6sXd1dWHr2r8CAJa+/ARu3n0trl30CxZ1Vz3WyEg84vvo3N7ejo88Hiy470lMHKake30x+Av9HmtLd6ip2KzAP2VWz2U/nVKaHgQYxBob0XDkKOKTL0Pct6efVXDxoKr993Y0rNmoOrD3BKf+PMeDvtcGAJJDE+XKzurz/v4NKmBR8IIWa1zhu9wiJcNitwX0ICSgreDKiX/6pAnfnTwTH5Z2s7IgwYsPZFQ0Fg3J+VcEK23DWr3Jv0eagEKPiYHLv0RIIHR2VIbhha/r8FsAeatr8cv8UGz+iQPr/6bUboONX1GTWpMlXaZy4MUqWt+q9GQFkH0pK+mRU9JzWAQlHlyuFg9W5zvwlK+kWOZ0orahAcnJfqjR2lcUX58/Ihxrj7crvQUBPLK7DBuuUJYOWbtV+ZXe3NKGWQuVxVMfmHczbr7tWnS3+8e4aKVi2ubC4mIUTc7BIx2Ky/ok79/A7G9jxo03wfHlF/B4PBe6JBh03wcrNsvj4YdWfE5mwG1qCop1D/r8WBAPC4LXoff+ylwXHHnymUArXoqV4+yzITlrcei9vyIpIrVHSAUDlN7z47Vl32rV61XZWS1Kgr1JDyAEMbfDpXJYpCum3I0RE6vY7VavfA23LXoANwP45x7l1x7F5QlgIyaORQqyhmSXC37NKh5Wbx81MVDxrY/4pTx4t8UDR2lqq/QNlA+9jR2VYRhjVeZoUdsk2rbWWRE83z6aeDFDSzYYDAxWMTab7vhV4fFSlDmduuVAGsealpaMudmXYnW+A29/8R9MS0tmHScqKytZL0FetzzyPZQs38haMD2yuwz3hEFdGgTg+ORdAEDcJQrIPlz9OQPa9VEteLzJ13rJF7a4KScHWXsKsCozEwuLi2EMD8e2jR9hxo03wX71Ndi28aOB/J5IPLTGTPYf0I/sKVYd5Kn8pnVWwcpwSQCqKr8GKn1ltsqvTwta8VKsHJ98GQ7uW414KVY13hRs//zjZGVK/vgwORBcf7nvhwPBDQ/ekqAWYmyOlMN3oa8U+KnTgysAvPKLJDz0R8VJndx3GKvxGqz2aHx3stIpIGLRZbh/rhUAcMMLb+DQiq+QMjwLFil5SEKLwGPNnIm81bXMNWk7TxTpQEtvOZA9+8bjha/rGLzWV9gxxkrL2AN7dlfpPo6bRyWyXoO827oYRfFzr9er6iNIGp8Yj+xR6Ugrq9SFVnmjCzaTmYHuNp87e+Mz/1gRLQ1yU04Otpwsx5aT5dgXEYmHn3kPy0wmzL/qUnRNycE9yzcq5cDlG1nXi7hL0jBr4b0MVjffdi0D1n+Xl7M5XgCw0LePffX1SE5OxsLiYlUIw/HlF7BffQ0emHfzgAxe9CSCFbkryVkLyQeIqrbynu/suz4pIhXxyZcp96n8GvHJl6GmYnN/XwcFVhWbcXmkXQFVYyNqKr/udf/0GLoB1DprVS7yyJ5iXTgPFA1aYPETeS1SMlb8v2wluu4AdtqjWVnwGd86Wa/84i08+HOlDKiAC3ANr1XmdHUfAHAH7p9rxceP3YtvORqYYxtqItjwKwIThMaOHwFgBLt8787/qKB1pAkYY1Vvr6i+Ab/Mj8bNvkQghTVoP9Sqif6nZrcTRtoDHluwMMZQd1dx0dEMVgaDIWD+FTmo7FHpcBQVIcZmC5iUq/0/e1Q63vgsj18tGDNHpDJQzRyRylovUculrin+icO3t7cj44pLgQNl+KADyI2yYl9yMiq/KcMD826Gfe4PGbC629uxedUbKC48isNfn8CaXfn4qKCAlSAfmHczXl7zD8XN2e0sOTj2spHA+oH/BpELoYN37b+3I6QvgAqiqrZyFTyMjY0YN/E2HNq3uq/QksdNvI0FKvjtUUmwX4+hUrlfrbMWcd+eHgAtAayzAKtxi6/Ex4/di2c+egWfvd+Mh/5YxSb4HlpRCXCd3wlar/75LTz4c3/pr6KxCGgETu4DsBhQ2rz7lfqjUSh/e+gdIXdUhmGyb4FF9qVJUqLO+du3SQAwZfoMedLUbwEADh88qet+iuobVJdnm7vwy/xQzEsx6DoxghWVBI80nVKVIi/WMSx+zpK2HEg9AvmWTPUuF9JHpLAyYfaodBZ1p/9J1ohIVQnQGhGJprZW1p39Hqs/LBGSX4CSA2VsYUdt+6WJMTGorKxk8Hlt/YcAlEmkdWUH8OHqz7FmVz5F1lFZWYmbcnLw1MoPFGDefAu2cTH3m3/4Q/zk6T8N6Pcm7tvTMWay4jxqCooRcuQoavoIh57CDlSyq2orR1VbOeKdwzFu4m2o9UXg9UqEFK6gMasDrQ5WCqT9dfeyP95h6QHMuKYRXWMuDVoeFMA6TTU5GrA7/y3AV/IjPYUr2Xk+nv7MR6/g+gQzXv3zCDz4c/92KhqLYJGScWjFV7j6x5dj5jVHsBrK6sRTx3eiyW5Dkm20XOU6NiQOpvtK90o/mDBN3rNvPGZn+kFT7A1hsCJwTZk+QwaAseNHMGjxY1wAmHvyBzMQEMygNau0pT+t87qIJfka08q0ACPBSOucCG4UvCDnRYs9Ukgje1Q6kpOTWYd20jKTCQsrK3F9eiTQDCBMmQDs2HoUa7cexQfh4UB4OOb7bu9oagd8CcCPCgpYh4NHFnyPwQoAnn/kGQarsZeNxAO4GdMOHsYOAE9dOR370kZie96//Q5u8qhB8cbQQbthzUbU9gKq/kTF+fEsQBnTSmpMxbg7f4oxkzPxj/sfUY1rxUux8vf+9DKO7ClGw5qNONDqwOWR9j7vV3ubYACraisHHOUIOXIUWwsuxVV33YAt7wpgnXEpUC7txkN/rMIrv0hinS2eyutggLo+wYyn8jpU87U+dXpwfYIZ1z9hw6fPuJjTirJFIQpZ+NWjMwDM8JUPT2LnwVA2/jWUoEU9AGeD5l6Nxz9PhgfcTg9aeuAh+YMc41F4VJmvRbAiZzVhpF0VxCBYXcQJQdXz5uPpfLmPd01er5fNqWo2mVF4vBTjE+NR3uiCo6gIewsLASjjSDywbm9vx8LiYjyQk4PwH9+IW3yuikITTkMM7ABuaGxlycAPdGC1de1f8dr6D5mzev6RZ7DvVDcqKytx823XKq583RYWdZ/W3g6UncDEzEy8UVzMxrs+fPfdgfy+yDN/+BsAwD/ufyQoqPqbxpN8E3erNONJSRGpONDqAN51YMu7QLwUG3BfX/gBABistOXA7uHDe9y33uPm4aUF11YAM3/4G2x59/cDYqxx0MXaaZHHT59xsd5/5J54WNF57SRgatdkuzUOFSsUYBHAqHT4qdMDKd2IJkcDPh0fhVd+kYQFPzg8ZI6Q5LKafGXBydiC71ZOwpTpM2TeZfElQioT7t35H1XKT+mQMYxNPqYxLH6+VpvnBPjy4hhroi8ZaLrYYRUgAtPP/7I84DpuErFEbguA/KNrvoXC46UoKVMOXMnJySiba4fH4cBYn8sym81YWFyM5ORk1Vwrj8MBQCnLJnjr2UrDH3DzqjZckYYQrpT34erPUX18L+rKDiBn1jzF+X2jlA+/87PfIDE6BjdFRuIen9FOCG3B9VBWMZ6WqhwQmwA8/dbaAQuryyPt5HQCQKUHqZ7mM9EYWMOajQxUuiU57r2tkesC5ohxwJDpcSTplPWSGhVwxX17unLfXuL3evBi4HIMrAnegwJY5KosUjIDDy1nD6jX4dF2vQCg6l5Bov6A4xZfCaATtlvj8Nn7DQBeYbdRIvKdvka6eUPqwHik6RTuWZWLNxfSWJa71/uQ4+KhVegJwZsLlXlxBL/XP5qkGsMiWPH75l2amIPl11Or1+mtGyUDoMSfpC0R8nBblZmpzIvy6XAiMBbJcLvd7H/4nJXH4YDTEIPHva14vIkWdFQa3MIXxnikQ4m5A0Bd2QHEpl2uJATffRe/eXcDfmC3Y+nLT+Dw7h0oLjyKL47W4v1It2r8iyDI6/C6LQP6fZj+4oMqWPUXUjyoAODQe3/tsZyoARJ03AxfHkRVWzmSuMdlbGxUuyPfeFT0ghtV8ftgjz8YvJIiUgcUtAb8UqAma6Q8YuJYjFt8JSx2xQlRN3VyUE/c9BC7PXVp/+z9Zja/Sm9VYYJZk6OBrWCsve6p2WF44qaH8MxHr7CI+1ByWQStpuItmJbcge8a2kElwJ40aeq3WPydehBaM2dCGvcj7Nk3nsHKmBTpSx76Rf+/fdSEH13awsqD2lWEL1YFW+TwqdXrEKQkI9Hlm1e9gfmFhdh67VyErNgI275KyFuUKoLH48EDvmg5pQHNdjsyLk/DswYDsiMjkR0ZCafTiSVVVfggXIFVYWsrPmpthdlsRuKoSQgJCcFtj/2BwYoCGGOvmIbM7Evx/vvvK5OPL1fi7xmXpzGA2q3h7Dy/MORA1D/ufwQ1ch0OtDpwoNWBgxWbmfuQE+J6nIAbn5OJq+66AWMmZ6JhzUY2oTcYrPqTNqSxLK0j6h4+3D8u5ttXVVs5GtZsRE2Bkvq76q4bgk4Q5p+TsbERBys2s+deI9fpliiFwwoiqz1alQjkQXXDwTeYo2pyKKB56I9VcDtciLJFMbABnSr3tRPRSjoQ/p6DigtTHFz+P4sw5bvAdXcojXQtdhvc+yqH1MFxX+leaWL6JPn1jyb5Vg5WxrL0SoNa+ceiuhis/v3Ei/hlfiiK6qsDQMWrqL4Bf5gShV/mh+IPU1oAKN3ghdMKOkYg1TY09Ar0WQvvRVfXT6kbhQQAw61RcnJyMtr/+pjPVdWj/X/eg9MQg4zL01ByoAwfhIezXn8AkJCQgMLWVtwUGYl9bW1wu90BKwp/e9q38PL77/sd0+4dzIUleOvxyG4FShm+6+3WcAYxXr7o+4Dr3K6X0jvQ6pDRCozHLFZu46Wdv0QlQB5UeuU3HXcVACk6P+7On2LbC+/S48HlkXYYG5Vkn+SsDXBcVW3lSDoCbHuhliUeKfXInis3p4xrvyTpOEABrL6UAsvfPo5vOZ5R0oBc8pxSgrvz32Ku6JmP/CU9Kd0YsD7WDS+8ganj/a7L7XDBYrcxR/Wps5ONjSmBC/+kV4uUPOSOkAQtfDSJuax/evsGLSoJ/vfvWgG8gSNNoYqr8kXke1NRfQPePqqMZ938afNFPXH4DGDGXy/71oBSlZYqKytlcla0vOKnW48CB8qQ4K3HRwWVbFIxoKyVtcTXHHdiTAwKIyIgh4aweLzFGIq7b/4WA1TiKKXLyb3XzcaHz/4NT4cCL/78RgDA2pf/wbabAX+bJ7s1HJW+CcV8R/eB/sMBUNo2zcT0oLHvvsCqJ3elt2bV/V8o+1r1g+0EFQlcL0SJmwBM4FJBC8r8MQIr/9gJYNr2SwNRA7YkSKXANX+fDYvdxtKAJNe6Wnzq9LC/gJIc5MeqtP8TzHYeDGUTg91yJbsdjXutebgcv1kzGZ86PazV03V3RMFitw3JlYf3le6V1ld48fZRE4NWZmvgAm3aciHF2em8MQio8rdvk+hEZUGaf/Xh8Wr8Mj8ULe5SaV/pXjGOdeYHWt3XsP1/3kNIvgIGiq9nXJ4G275KmlwstTS6GJRKfCcCGODvlJEdqbzPW9f+lcEKAL6prEEJgLHV6v3d8ogSgS85UAa7NZy1enpgYMKqT6/zlnd/r9sFYus7H/cJVj25qxq5TuJOiLPPxv8+lIZVP4jQxtGlA60Otj0ahyJw8SXCqrZyGBsbUVNQHPC4t77zMba8+/sBD6sBDSwqBV4x5W5VdH3nwVDmpj59xoVmVzN2HgyFXNqNZlczmhwNkEu74ZYrWbmPXBiNVZW/fRxuuZI5JrofgQlQGuzS7a+7IwrXJ5jZdUNR+0r3Sn/fv0P6ZX4o1ld48ff9O4J+eLurWjHGOgx/mNKJackdyDZ36cKKh5T2sg+PV6PFXSoJUJ0fPdkZA4/DAY/DAbs1HB+E1iPriyMAgJZGl8QDr6XRhY8KClhHd1qKhGD2RWkpxl4xTf0Dc7hNafVUr8Aten81hr3zCT4ID0dIfgGDlqNJGbviy4N8U97BBi2ts9JbBFELK2qf1NexK8lZi0P7VrNxpWBg4bupU8lSu2/JWasKXxzZU4xDg8BZDQpgNTka8K3bnmEOindOBBoeSnQdXd7s8gcvHvz5SbjW1TKYEazoL3Vsvz7BzEqEh1Z8Bas9mgHyiZsewrjFVyLJNnrIBgT2le7tESDdVa34w5ROvLlwF2bfFofJEw/ivpv2Bjiy3sqJIhV4flXCnX+zQ0nulZSUBDtQqcD1UUFBQMPc2LTLUVwYuNYSdcPoPHUKne+8g48PHYJ13X+w4eV/IOPyNFwf1cJgNa29PWCu2GATuRXqhEFzrMhddY25NGhAo7exK1ALJr+r0nPQzGURkABlXIofZ+NdFv+4tclBAawzkNvhYl0snvnoFV+wogFSuhG2W+MYWNwOxWm55Ur2l9TsasaDP1cmvErpRtbZIsoWhSibUuaLskXBIiXj02dcDF4WKRktTa3SoRVf4eS+w3gqrwO789/Cx4/de1Ef+MZYh2HyxIOY9Tc7moq3wHbL+3j9o0l4c+EudFe16roqoQuvwtZWhP/4TpjtyoTTx73e/pQYpZ7KjaTE6Bh8EFqPVZmZCB02DKF33YUIq7IK8eK6WpQcKEP4j+9U9SzccEUa4qKjAc3aVIPRZWndFbU44st0/Vntl7bZk6vSSrv9uG9P13VZpMHkrgYssGj8quDoMta9gi8FWu3RrPQXZYuCW65kkKK/FikZqT8aBYvdxgBHirJFMYDRX7dcyTpfnChexbZDndqfmh3GypILlqUOaZcVTJmtXfjRpS14/SNl3OL1jyZBPvQ21ld48fpHk/CHKZ2CDAP0wOpzU76JwoDT6TzdA5Xk8Xiwde1fcfMPf8jKeVQ2NNvtuD6qBYUTx+G+ceOwIjYOK2LjWIgjZqkyH6nkQBmuj1Imm381KmUwQ0vXXRGsKObOQ4tKdeNTZvX0nGXf9b1JHp8yq9dFGruHD+91LEsA6wx03R1R2J3/VsAcKgpB0N9mVzNamlol/gQojWunju+E1R6N6+6IwlOzwwI6sNN1/BpaT+V1YPoVT6rLV02t0oIf5CHn0of97k+uHJIBjL7ot1/lS8akSBR6QtBUvAXGpEhQaENoYIscljam3l/NWngvYtMuR1lZGYzh4djVrCzQmfXFEYw46sabHf5O8NdHtWBaezsSvPVoaXQhZulf8e8puXAalNWP9eLug9VlEYwIViQ6T+CgcaxeoNUnWAFQLzOis2+CFq/BErQYFMD67P1m1dgVgWvq+E40ORrgWleLZlczgvX3o7laFGv/1OlhY1fkrPg2TqTyt4/j1T+PwIniVQFAWvH/snHFlLtxfYIZa/4+G+MWX3lRQas4MoQ1ts3fvk0qjlQWaczfvk2i0IZAwsDVr/68EQBYy6QzOUgDQEhICB5Z8D18vvKPaKiuYVcmJCTgo9ZWLK6rRdaeAtj2VWJxXS2eHDkFronJWBEbh5+cqkKCt57d56tRKYPbwjprA5KBgDpCzoMjKSKVle/GTbwtKLTkhLhgk3Zl3/1gbGxksOIXZdTuG/CPZemFQwaDBuw8LLfDhc98Tuv6BDM+QzM7v9MeCldp315wApK2NRNBi4chLQb5VN4ouH4e6LIUOOVhxMSxcDtcKDi6DLtnhw2JRR5983d6/V46ADztv610/W4AIYN+HdCLQmvq6/Ey0pBxeRrujYnHG5/lnUlDUwkAXlv/oUzLjJSUlCAuOhqW4cPhbmxULW3S0ujC8i++xHIAM0fEYMfuMgAxeBm+MqXPbQ1W8R0nCBrauU6kGoAtA2JsbES3D1q1jjxVh3ZjYyO6dAIb8VKsTEuMGBsbmXPS2y/t+8ieYgWWgNK2qZ9jaQJYvYjcDE0OJvhQR4ue3BU5NL7Ud2jFVww6UaVRrBfh9Qn+1CHvslb8v2w8lRenghHd/7o7ooA7opBz6cNI/dEocSQUGuiSH8jJUSUFXx0RDlw3+0yhFVBSqm1okGsbGtjYVnJyMjLsE2EtO4Hv3DoT/1q3Bcs/XInnH3kGy7/4EgAwrd0EoH0wv77SgVaHHC/FBkCDHydSTdjNyURNQTG6fWCqqvwacfbZgAZakrNWdTnBqtaRF9CdvS/7rQGAQdywZ8AC66m8Dnw8xb8kCOBvaKsFTNBfPdUReCqvDa51ajfW7GqGBTYAUHWy4KG04Afq0AWghEHW/H22f07Yj0bp9ikUEhpIsPrbk/fj8LotuCQ5Hl1Tcljj298DuDIzEwuLi8/m0hESAFB3DZXWbcHt7e2IffYJ3FNeBoxIxd8rKvBaQwOFLga1kiJS0QUlKq4d1wKALe8qS3WQ44nPyWRuKwlKZ/Rxd/4UeO+vMjQOjKA17s6fYsu7v1eVAHlYHdkTuG9az4pKiFQWxCAbvwIASZYH3hAMpQQBJRjx1OwwtvbVU3kdKH/7eFB3ZbJGyinDsxQo2W1sXpZbrmQwskjJLBJPLoxSh0e/cUi9PTbtZYO9HAj0uSQoNAiBRU6nbK4dW6+dS70GlcvKyqDTzumcPIaeZDab4fF4+vUYaH2uAfKZlsenzArai0/7WhA8aGyp9t/bWRAjzj4b8TmZrMN7fPJlDEy1jjzUyHXs/rSNmgI2AbjXfY9PmYWayq91+yWerdf+onNYbIyIKwleMeVuTHW+gt7mh7/65xF46I9VSvwdDYAj0EGl2kcpzsvuC2gguk/jYkMBTkIXlZjjaV5WhFnWKP4yhISEyOfrMfSkM00tDgRxPf56fS0O7VstA4DknKXAKCEO8bhMKQ/6lvPgVh9GPPzQujzSjm6udyDnqPq074MVm+WB0n29vxqQKcGWplbJLVdid/5bqv6Bu/PfUi0l0pOojZLVHo0Fy1KRMjxL5Y6olEd/n5odBindiEsvsYtlLoSGpIZzsNIcxMSPsPMEZu3rfrBiM0KOHGXNa7vGXIr45MtQ68jDlnd/j20vvItxd/6UwWncnT9lLZ1CjhzlJ/5K5+hxCmD1VQ/9sQo3vPAGi7fTJOK+3I9E0fVX/zxCBcST+w5DSjey8TBt+ychoSF4MBVgGhiwUt3vQKuDNa8lcMUnX4bLI+04WLEZYyZnqiYgUyS+Px0wtDqTcqAAVhDJpd0MONfdEYUmRwPruN7T/Ce3w8XmYAFQuTQ9aO08GIqdB0Nx3R1KetBkjZRN1kj50kvssnBcQkJC5xp2B1odqKn8WtV1vXv4cFweaceRPcUs6UdpvzOB1aB+oQZi6IJkskbKJ4pXsXEscli9TRqm4MWrfx6Bp/I6GPQW/CAvYAyKQhgAWES9ydHAehg+9MeqPoUxBrtE6EJosGmAhS7Oym90AIiXYlWR9ficTFUoow9Ncy/4a3/RAmvExLEsKfip08OW/KA2S3rQImDZbo3DU7PDWLKQ+gOGGZX1eBoaGiTerfHJREoNkgSwhIQEsM4HtCgQwfckDDlylJ0fCA1rLxSwDAP93XM7XJg6vpPNx6L+gBRLT7KNlulE92lpapUqGovY/KunZochyhYFWhAy7vJRiLt8FKKjo2W6PaB0aed7FVJ396EOKyEhoYGjGrmOtXii8mD0ghsRn5M5aFsqnbUf1gP5wVEEfefBUSpoAR7shAIWmmcVZYsK6KBe0ViEp/IUl0Xd2h/8+UnWlR0AoqOj5YaGBsnfegkMdNc/YcOnpVlDovWSkJDQoJAEX2lQrwN7H6PzQ/fFGcglQcA/xsRP9OWb1r7ydQvKNrn9fppbwNEtV2Lc4ivZdcdW7kFHd3vQuVQma6S8+JVcrHhoFwCAxsEe/PlJURIUEhpgGqIlQcRLseygzJcFAaUcSCVDSvrR7c9n8k+UBHtwWW65ko1ZNTkasPNgKJ7K68CnTg8eusyEV36RhLQ5FqTNsUBKN7JFGen2lBaMu7xvff9ShmexsuJTeR1ifpaQkND5kjzuzp8CUOZc0WrCfKx93J0/xff+9DKgjHfJNXLdoI2p9/uH9WB4kKxc51AWX2xCA6z2aN+ijlX61jHdCHANiY+t3IPRiyYDGMvGrih0wYsWieT3S2EMISEhoXPprMbd+VMceu+vSIpIxaH3/op4KRa1jjyWFCQd2VPMnJbvb79clg90gw5yg8YzUxkvyTZaplZLVns00uZYkJ0go9Apoak2JCDdd3LfYeCOXAatD97/Fh76o1I67Alcqp88fWy2KyQkJHS6qpHrkLRmo+qypIhUHGh1IK6gGIcqNit9AAuKFYj5egz2NzVIrkw4rPOgKtcxyWSNlN37KgGMRRMAzLEoAIvrAnz9A7WQibt8FGoPHMftd/wHHd3tGDFxLOIwCnJptypUIZd2q0IZ5LJE6EJIT97ubtlgNIrPhtDZkHSg1aEseQ8gfvhwHKjYrGp0KyfEIeTIUWWeFvoWcefHxACluW6Nv1GuANZ5dVsADvrGt3hF2aKQMjwLFY1FSkDjDuCDA0BHdzssUrLivDTbCwYnASshAS2h8yValJGWve+CP94ecuQoG9dCK/rkrHylPxlQGuce8AU3BqPLGtTRsGCdLpJso2VKCgLA7Xf8B4sXL0asxcXcE3W30G5DwEmov0qKNMLZIYAmdHahBSjRdslZy+DVPXx4n0GldW8AcKDVwca6LkS68ExlGIpvdpXrmEQgskjJ6Ohux5v/82dI6UakDM9iHS94lyYkdLp6YGQUvN3dcjBYiVdIqI+SAaBrzKU40OrA5ZF2Fby6xlx6NuZhSbzzqpHrAkqGAlgXGFzkpqjZ7YiJY+GWK1n0XUBLqDfpgYcumz5zWND7JEUaxYsn1C9RfJ1gxUfbz4EGFbQMF8MHgKBlkZJRe+A4ag8cR8rwLEjpRgYtIaHe3BB/PZ0nIL2QbdO9/+pFMeflsQkNfndF4Yot7/4e41NmAVB1ZZe4hRrPGFKDFVqGi+XTQCXCWMtINoFYLu1W5msJCVh1d8tb74nv0UnR9d7ubjk33oDceAPSzDK2bzmF6TOHISnSyG7r7e6Wl+YY+rV/OgmndhG6KikW8TmZLBEYZL2rcznWNCigNaiBlWQbzdas6ktZr8p1TKIwhgCVkB4QluYYVPCg63gnlRtvwK4aL2YlALMSgPX1bmzfcgoPjIxCbryBQWvujFhs33JKdZlWRiNkoxHyC9k2LM0xBL3togxZuKyhCyvW3QIAxqfM6mm9q4s6vDNoU4JJttFylC2Kpf5GTByLSy+xy33t+Wf1zdcSEiJt33IKVliQG+/WVmswK0G5ntfzBV4Gstc8zViUodyOfgdu33IKTSHKthTIqYETNiwEE2xelHkkNIW4MXdGLKZdE4Pv/lchSxb6YSqrACtSh0NLYyZn4sieYkjOWhayuACS4G/3NCA/X4MSWEm20XLqj0ah/O3jLIZOjWv7DS2HgJZwVwp01tcrcFGgEyi6fleNF1vvicdVb9agqrWbQWuzE8x1bXYqt6dtKZerCxqbnQqsGrokLCuSsNlZh5cAtm3eUW12KoDrONUlL80x4PkCAa2h5q5qCooh4eJdTXhIO6yp4zuBH41Ckm20zCcB+3P/nQdDxSdggEKE//9sH5j57fNjQ2UeCWlmGZudUF3Gq6rV30HFP0alrtRZuyyYFwO8dqIZSJAZwAhcm50K9LTaVQPctrKeBTXChoX49tmFNLOBOTV63FWtAlrCXQlgDXhVuY5JNGZF5xcsS8Vn7zeDnzDck7MCOtn//LwsoQsvKoUREJ4vUABzOgdnvXEfOujzsCEwlXkklWvSg1VuvEEpD4bwbsl/fl4MfKVACZudwLwYC16aPwyPrq3D8wXeoBD2dnfLVa3d+GSbvwNBx6kuJEUaUebx325liaS6j4DW0NGFdFfxUqwcn3wZaiq/FsA6F9AClFLguMVX4rP3G+B2uIJ2vwD84160ntZn71eJxrYDGFrPFyjJPaDO50oCD869BRGSIo1IMwfeROuceCC9kG3DY4UuBi0eVOSSmuBmoOK3lWaWWemwoUtCmg+I/PiXHmCMRsgJYUY0dEl4vkCBVINmyaHoEJm5QN+90NAlobPbH8gwGI2inDRIpC0HhgwAdyUnxKGmYuC2bLroVu2T0o24PsGMT53KT9aKxiLRjmkAig7A27ecwtyZsZgL4NG1dQHBhWBA0jqoYJBq6JLQcUpNhukzhyG33oD8evU+ZiUo5b4muJmj2u8yIDpE2Yct2Qq4Xapt7XcZsN/lwQSbF/n1UjCXKMeGqJ8TAHR2ywSggOdI4HIqj1E2GI2YEiMDkJFfL8kCWsJd9ReecfbZCDlydEC/RkMCWK51tbDdGscWeQzmrix2G175RRI+dXrw2fvNwl0NcFgBvqDDFgumzxyGl+bHqpyKUnaTdZ0ODySSFkyAMk60NMegKrNt33IK82IsANwMDBSeWF/vxn6XQeV6bMlW9r/bYuM+mG4Gnvx6KdjBSFZAozx+gh8AJIShR3dY5pGQEKa+TnmcAlpCpwGtnExs6edSJQJYZ6BULoShhVXqj0bhqdlh+NTpYWEL4a4GJqyUMqACjtdONOOxGhdCS4yIDVHmI5HI5WhBpeeagokAsShDxsoSiZX0WNpPA0QCoMpV+TQyyQwAOFHlYaDizX1PsNK6KB5KepdrYQwA8ICFPMgdCg1c1ch1GDcQQOUrTTZo1uIaiJJkefDPRaRVga+7Q2mztObh8gCQ8bBqcjTg5L7DAlb8L5eQgfPbhRwWhS6sXRbOUalDB6cDKVJuvIE5Jz40oedoeDjoweqWOakAgD+9dwQA0NbW1dsvVZl3UFow6QGKV7Du8FNiFGC9eFga0L+Uz4a6uroGzWc62GdgfMoszHjshwCAv9z3w/P+nhGsav+9vV+NdXt77QWw+gCtlOFZsN0ap0TeAWUdLICNV1EZUDirgfvlpnlRek4qmMPoL6iSIo14YGQUa1r76Nq63t1LD7AiZ7XN4TxtWOk5LNqHq7JJD1bBti9PiemxBCmANYCAdXmkHdELbsSYyZnY+s7H/V49+GzAqqaguN/7vVDAGjIlQVp8sWJFEVzDsxAzPQ07E9uUX+aOZtVKwgJWA1MUZbd2RalSeMGcTn9hReGJeTEKrD7ZVqcqKwaDlFZpZhluDaxI/YUVv81grsqWbGXQ6gVWACD5xq+EBr6UFYb/PRwAcNVdNxA4BjSsLugLNlQcltZtBYOa+I4MzF+j5KweGKmUdZtC3CqY8BN2++um+IQfbZuHIR+i6ItGpSnbmWKPQ0pcOCpq25HvqEVRaVO/YaVXCjzYGgqLtwu2ZKsKiJu2V/TnwDLkQxdDwGExl9U15lJcddcNOLKnGIfe++s5W1SRmtueThlQOKxz6LYEggaXs+JhRfOYeLfha0uEF7JtrJRHvfr0xp94QCnfsEAIAuizq9LCCgBS4sIB4IxgpVWZRwIM6pIjB6t+/RgVn6xB5LKcw7H1nY9x1V03oKZgNuDIO6urAROovvenl3FkTzEa1mzEwUHYAipEfF6ELjSswoaF4IGRZhWs9IASNiwEjxW6gEIlkDF3ZiyAWFi5JrO8tE6KtttfSOmJnE9FbfsZwUp7mbMDSAjrUu2DUocCQkMXWgcrNsvjMYtB60hOJmoKihm4Tgde/FIh3/vTywCAbS+8S65qUH6ehmRJUOg0frlcoPIJjVvRUhzr6929uh8at6L7kdsiSOk5rrMBKnJXI5PMiE+MQE11W1/KdLqwauhS5lzxl+93GdDZLSMr/YxKgReNhkhJUPVZuTzSju7hwxH37ekYM1lZYfjInmLU/nt7v1smxdln46q7bjgnoBIlQaGL0l3lxgfCSg8swcIVfHBCT2fLURGoTlR5EJ8YoXU+ZwyrMo/SYikiQv2VPEuwEpOIB4mBONDqkNEKXL6mEdt8YYy4b09n0fcje4oV56XnqHIUwBHoAGD7r16lDhpD4kePcFhCF+TXKMFK6SihOKOVJVK/ouo9zaM6m6AidzXFHoea6rbTdlf8Y5pg8wY8VgLWDHsCA2Ifyo19BdaQc2lD0GHpvWcg10Xw0kKJQAYAtf/eDkC1YvE5ed+FwxK66JyVHqz6Ciq6L7rUIQ2g/6m/vrqrlLhw1FS39ctdEZAABIUV4O+KkZZoOtuwAqBMKBbtmgaXmaAz5LoAAO8qZb0t7/ZvG0Pmh7X4XAidb1glRRoxK0Fmyb1lRX7A0BpQJC3AtClBbaLwbLoq0szcZJyo8sCeo/zKralu6w0mcqhR4n8kB7R00jorAIiICGFjV2XVLeLDIjRkwSOAJTRoYLUoQ2aRcx5WWum5LUoJqte0OnewGpVmwYkqD2u91Ed3pQKTFlbBQiW8u+rDBOR+61djZbx4WLgsocErg3gJhC4UrJ4s8fQLViQeVmUeSRdW0SGyChpnoin2OABKhL0PpTqfu4IulLSXn093RYlKISEBLCGhHmCVG29Q9Qc8XVgBYEELrVMhSPGgOhNwjUqzsLErQJkg3BfR/rSPqydYnWt3xbss8LVKISEBLCEhNawIMr3BClDGsbRjWVp3pQervkCkr5qZmwwALMK+YZOyAkBv7qqvzopARTH28zF2tX3LKcydEUtraAloCQlgCQnxB3AtrHoaswr4cBqNASd+W6cLo94UMkxZ5ZdKgY6Cxr7ACgAQatRfiqQniJG7Opcq80is88fqRTHikykkgCUkxMOK1mYClHlS/YGVZvFDAKycpZpzdS5gNcOeoEoE9jFizsau6LH3BCv++fEtmM5yOVDmndRmp78jyHOXRum5LFk4L6GBLJESFDqnsDqdjuh6sOIPuufsyzDMiLRE0+nASvXYQ41Sj7AKGWZkXzzeXfWnHOjt7pYNRmNPpUlJD/JNIW7ctlJiPwC0qUExX0tIOCyhi0Le7m7Z290t/2rs6cMqmOjAC6i7nKeZZXY6E41Ks+D+O8ew+LqjoLE/sFIlA3npwUoLKlJHRycPnD693kFgpQK8tcvCJlrTe/LAyChsdqpCGOx+YoxLSABLaMjDKmxYCFvW/nRhpeeupsTIuu6qP5DqaY7WqDSLap6Vo6AR2xzOPjsrvhTIuyuaFEzPSdvNgofWiSoPvN7+mZqlOQZdaPmCHDLBncauZiX4Yd8U4sZL82MZtH41VkZCGJBfL9EikQJaQgJYQkMTVrnxBjydYVaBRW+9p9OBFR+00FuW43QVMsyImbnJurDqx1iSTFAKNv/quUujVI1tRyaZ2biVdsVizk3KvTmruTNikRtvCOa04O3uhrNDeT+aQtxs/htdBoBBCwAWZciYEqOcqK2UgJaQAJbQkILVC9k2zIuxBCyQ2J/OE73BarPz9GGl9zhGpVkww57AYuuAf2Jwf2ClvUAbAvF2KyslEwCCJQJ5Nzd3RiymxMi6IOIve3RtHR5/I0vXaUVEhMBgNLL3YrMTeO1EM3NP+fUSHl1bB9c1MQxaK0sk5sQIXgJaQgJYQkMKVtNnDgtYQPFM2yRpYUUKBqtgbk5vDGlmbjJb04omBVfUtgftEcjDgMbpfCfQqafuFtNnDmOPW89RaVs9EYjIPfn2L3u7u+XIcGXbSZEKjHb8rgjTfptFpViZXNz4yE48d2kUfjVWGd+j1+eLn8TguUujWPnv8JNVcF0Tw8a46K+1y4KX5seyUiEHLQEvIQEsocEHK5rc+8m2OhVYznTcSg9WZR7pjGFFrgqAClYk7XIhWlDReRqnA9RtoqJDZFS1dus+FtZdXgMpLthBknbVeLHjd0UMWgQnAGhtl7E0x8AgtNkJ2L6ox9wZClzGR3bC4u1Cfr3EwDMvxsJeu0fX1mH6zGFYvSiGub7DT1YBUIIYpKYQN1zXxGDujFj+dZeDxOEFyITOi0SsXei0NcHmDViGvr/jVn1xVqcDKy2oyNlQZJ1XRW07Plh3LCisCEy7670yDyjqOr+rRh9WPIjHPp0Ey6KjKjfVU4x9sxPA74rw0vxYPLq2zvfQjL7xJ18K08eIT7bVIe6WG1AxphhZYwB8WQxAwvp6N3st6fZlHqUUSBDjx7a0LvnZe4vY+YQwZexr+sxhSDgBODtUi0LKIg4vJByW0IB1V8rBWg0WPVfTH3fVnzIgNb0NpoYuKaD8Z88ZjriYVHYKBivSC9k29lznxVhwRYyEx9/IwmanAqtFGTLmzohFUqQRVa3dKufFQ40c6AMjo+CqbFLByjdepvv8aKLvS/NjWR/GKTF+Z0XP32Ebgf1HipljzLo6E7ZkK3sd6cS/XrQsCwUyaPyRXnc+Cq99nbmekDJ8kf6X5ovGukICWEIDVMEgcrZhdTquqqFLUoUq7DnDMWFMJoNUbX059h8phqOgMRis5KRII8Y+naQ6wD/+RhYOP1nF9j/tt1kqB8Z3Q2cRdrOMlSXKWNH0mcNU0NKRTPum57m+3s0c1LU3jg54DdwWGxqLTgIA4mJSMWGMfyVat8XGwK59zfjLeVCRmkLcmD5zGHNiaWYl+q7pR4iEMODhLC9c18RQSEOUBoXOmURJUOg03ZV8xu6KV19g1RcgEqzIVdGBnEAF9G1ScJpZxuEnq5AUacQDI6MwfeYwbH+yyudMJCzKkGH7oh63razHogwZ036bhU9+V8Rg5esioQLA9i0WZfHJLVF47USz4rA0+2VpQi4oAQD7jxRj/IwpSIkLh6OgEfGJEax7vNtiQ011G2rjyjF8TA4mIBM11W3Y5nAChhBYvF26z4+2TyXX/S4DOrtl7Hcpc8k2O+vw0vxYNG1Td8rYvsWChi4JoUZgUYY3GHhFaVDorEuSZfGDSAgICenbbxdt9/WzEbTQ6xF4Os6NyoDkrLShCgIV0GMjW5nAwbvIeTEWrK93q8bT6HGtXhSD7VtOMQgtypCx2amk8CgaXuaRVGuBNYW4sbJEYuDgJuvqus2sqxXnNH7GFDQeKWCpRn5MbIo9Dilx4YiLScX+I8XId9Sqxsna2rrY86JOJDRGRiENGV783w8kXPl8MiZeWqVy09rHRP/PnRHLehSSG/Vt75xCq6ur66x8poXO/mt/riRKgkKn4a7UB64zKQX2BKvexqn0YJWWaAqAVUVtOypq2xGfGIGRSeZgsGLtiSIiQnD5pBQMzxoBt8WmOghrYZVmlvHJtjo2JkSd0AkAdDtqhUTjRQS24VkjkGZWouNzpqdgzvSUHuEdUutCXEwqUuLCYc8ZzjrKA0rvQ1JKXDhGJpkD5n0RGPny5UvzY+Ht7saUGBmJYQb819+V57jvaBIauiTsdxlU78O8GIsq9fjJtjo0hbjx2olmjH06CY+/kSXKg0LCYQldcIcl6/36P93GttoGuT05qt7WvWrokjAzN1k1EVirmuq2gOg676poIUV+rtSJKg9zKeMjWa8/DM8awcaO+MdNQHNbbMzxAMBLbxVg0nC1Mxl+9w8QUutC7YaP2es5PGsEAARs222xsY4cfImzorZdBSs+BUnLovDPgVwWucBZCUrAghKFc2fE4raV9SzxaDAa2Ryz6BBlLGtejFLa3L7llColml8vIdQo4fMl0QCAa/5Wf05dlnBYF5/DEsAS6uuXW6YDndZd9XXsSjvfSs9dBYMVf1+9bughw4z43txLAu47YUwmG7vasKlc664YqLRlRO3BXgsygoN1ywnmwHiY0bbiYlLRFWfDwW35yHfUwuJ2sRIfH5DQgw9Bi1zeyCQzA1JcTCp7Xvz96HoqGZK2OZwqYJGoPGjtsjD4kPv6ZFsd637Bi7/P+no3+8EyweZFfr2E5y5Vxvy4UqN0IQ6aAlhDD1jiHRXqs/SSgecSVn5QyaqDXme3LDfADy0at+IP9vGJEZgwJhNdcTbEQQkt6MEqK93KQEBwAQA7Chi0qKwWnxiBmuo2FYwwPxWr//axCizkcSpq2xEXo5TxUuLCUZNkRqMPWEVfFjOg8mU8Kl0WfVnMtse7PXocgB9W/P2CvneJJhSfcLGnz7+XynvgDnBOm53+cAZ/ewVQXsxKcDNQUfl2SozMghnzYizIr28WXxyhsyYxhiXUp1JgQhhOe+xKr5NFT7Bq6FJCCL77SXq/0GmbPDB5WJFTCql1sQACByo5IiIEc6anqNKEJAo1aAMNwTRrfo7KBRF84AMlOSFyXwxQR4pRu+Fj7D9SHLBNt8WmapLLQ6umuo25Kl411W0Msn6w+UXd4Hn4zErwnyhCr51ArA1dqEGnXM6P7dHlnOsUZZxBIFOsJPMnOdQgy6GGAfXeCWAJ9UncZNF+uytePPj0YNUbqPiDn7PDv+gif5DmYUGwovZHEREhyEq3qlo0kVOprS9XJfC0oqADf3sq5Wnh4ihoVPUpJMDwEKQDOwGIbsPBVQVBrXh3RYnBE1UebNhUzvYdnxiBE1Uen7tSv/48XGiiMJUANzsVJ0VLklAJsMwjYYLNq3oPrV0WFbQIfmUeSVV+FBrYsLrLbgedPE0SzFYZZquMgQQtURIU6tVdcV27z8hdBRsD4wGkhdSUGFmmxB0BB1B3iNAe0PkDf1l1C9raulSBCr3IOwFDGxWn7ddUt6nGiOh/KhMSjEYmmVX3512OP/wQygIcDtsIVamPByVtT/scaZv0HPQe84ZN5ew+ZdUt8Hol1etPzokv7212Ag1dBgD+OVn0w8TapYxLvbZSec+mvXEp8LsiBXAxyiTqlYuOqt2Yb67esiIDOrtlMTdrgMPqgVcfxn9/fykOVZ5EbvYI7CqsAACYrTI8TQZZ6vRe8PdPAEuoR1iFGiU2Sbi/7qqvsOJCFQFd0l+aH09pM+Ugy7mpotIm5pT4shgdvCkZpxeq4MGmBY42JbhpewUb66JJu/zEXd45acGhgq89DiOrFaC5fRBSj0v5//a0HTZ+BmDTF1+rgiHa8iEBm1wyH64AlOTffpcB+13K++Xt7sKyohB0nFLu8+JhI7zdXVhf78Z0xKree2uXBQ1dHt/2lK4g+10GzIsxY/rMYfhkWx2sXRZ8vmSY6j0UGnjK/d41eO3BZThUeRKeJgm7mhRYSZ1eydMkHJbQINEEm7fP7qpTfx1BBitKlfUFVhqXxeY10UGeYEQHdoKMFlbag7h27Id3NFpQ8duhkiK5Le3t+NsCCFhrS+uOtjmcbH80PpbvqGUBEAIi//woGAIoqcINm8rZftMSTZhij2PALqtuQUcHxfCVuLm1Kyro+0brdgFgsPL9aAAA7KrxYvuWU6hq7YbBaITti3o0hbjR2a2UFed+Uc/uO/bpJOCLemx2Ao+/oZwXGrjualzyCEydMRE//c0r8DRJDFRUCuTPC2AJDVh31dt405nCipvrExRW27ecwqwEIL8eqhV7i0qbkJVuVR3wteNO2ig6lfC0AOEdFu9IeEVEhKCsukU34k7jQ2FhoQGOjxwddZ+gfaYlmnRdFF0255rLGMTocuW68gBAamHFg5qezwSblyUAqWRHP0B4WAWTwWiUHit0yQajUfJ2d8vbt5zCshIDvN1d2O8KwaNr61DVqvy4OfxkFR4rdCEpUgGbv9u80EDUFQlx2LltHxu3ImgNRInQhVBQBUaf9cuBHKwk7qSCFV+GohSgwWiUeoCVbDAaWbyaxqDInfBlNt3H7rvtiSoPK+FpYVVT3YZ8Ry22OZzYtL0CRaVNKlgZDMqy9rRv3q3RYyBoEKz4ffCw6oqzqcqRemNTvEvc9MXXmDAmM2jggp7jDHtCAKwIrOT0DAaZrTA8feYwzJ0Rq+rGTisTc3BiJ85pyfx7tb7ejY5TXTAYjVLHqS72I8QHNhiMRqmqtRvbt5zCrhovBLEu0K9OjTPSc0q537sGB/eWsP9prIofsxoI41cCWEL9cldaWHV2y70l+his+K4YeiXAKTEyW1mXLwXSshjkauw5wxlUqJNESlx4QPCAxqK0rYvyHbXId9TiH598EwApghOdMkfaGKj0wFFU2sTKbtQSii/78bCi81onSI85JS6c3a+sugUnqjx463+3w54zPCi0KECife70mMuqW7DN4cS3p46AwSBjV42XjSVNnzkMgH/RRi2geHjx0CJw7arxMmdMcOL/p/v8+mhzjw5a6NzKbO1bJW/Jgwv6fFtREhQaFO6KfkVrHJUu8ABfyKILvcLK290tz4uxAXAjv95/fwA42BoKGAAb1G2HstKtqkavdADnk3UEB187Jv1fbAYZYWGhqoM9X/bjQxHkqkYmmVFW3YKIiBBunEjtqgK+aLUu1NaXB5QltzmcgAOY8P3pAMpR49s2PYYNm8oxxR4XkCBUlwmhO1+Lh1bmSBuKT7jg9Sotk6gJ7rwYC5vEbe2y4NdHm+Ht7laBymA0ssuofEilQR5S/KKXHKQErAa4Xn9zDXNYniYJCJXkgeKoBLCE+uWutC2Y+gArUDmQOpP3BCvSY4UubL0nnrXzmRIjK5NxW1uCOhy+Kzk5KTqIB1sgkcbBtKU1PmWn3R9/npyUv3OEvnhwEayoGwUfRydH9db/bsfd358Oe44fZPSYtPOytC6LF0F9zjWXsWAGXyI0+CpCzg7FFK+HW9OaSXl7Qo3+91qGF0mRRtY4l8CkdV9JkUb2Q2dXjbqEKHThZIqV5JY6WeLLglogLXlwAcZPylAFLwSwhAadu+JLgX2FFe+umkKUCaQ9wcp3YJMfXVuHg62hmDM9AY1FJwOWkKeJsnOmp2DT9gr84rlPYDDI+PbUEQEA4Mt8BCTd58qNS2kdmt78KD1wkkOrqW5jE3n56DnfyYIf1zpRVY6Ojk6EhYUyaJGbmmFPYNAK9rjp8fLg/PdOpf9g5shy3P396bj7+6l463+3q7YTFhaKjo5OODskpJn9rZnIQYcNC8HnS6Jx1Zs1zGFVd3iRGGYAoJyXYCC3JQNgQHN2KPO9cuMNAloDQC11skSdKxQH5YeWcr1XOoST8vJX1wAAxiWPwK6mCl2oCWAJDWh3xbuj0y3vbHbqTwjWKyEebPWn7Mhd8eJbL0VEhKCtrQthYaGq0hjf0YJgxE+g1boqOuhru2XwgKIxInJXel0waNt6i0by/Qf56xSw2Nh9y6pbAIcfnjPsCSq3qHV/2xzOgJIkoLRgKiptwi+e+wRZ6VbcMieVOS0e0kWlTao1uwBl3HBejDr+rrgtA3NYiWEGBVpGyQcx5T2mcmFVK1DdIQloDTBojUseASSDTQgmcHmagC279uH//e/zGL8tA7vue3XAPhcRuhAKdEZQlwOB4LH1YNCjElNP3bppEJ/WYuKXtA8m6jCRlmhi0CoqbWInbeslbTlPz13RgZxPH+rNoeLhFcz5kMviXSFdHheTykIYm774WneuGD+/jN8Pn1I8UeVhsAoLCw048SoqbWJdL2bYE1SwoveFfpDQmBagdGoPGxbC3Ja3uxve7m6EGtWLTTo7lOkJvjEuiU5yt2gfONCgdajyJHYVViA3OwW52Smq6w9VnsR/f38pDu4tYeGLgdZHcMgBKyYxVnxLzqLKPFKvY096ouSZ3tIUPKiSIo1YmmPA0hz/x3DCmEzExaQGxNX15izNsCcgK92KrHSrKn5O6Tkqr/HgSks0oa2tC2XVLSg+4WKQ4stq+Y5alZvTKwWSs+EBQek+5kyPFKvcWG19OfYfKcbmNVt1JzjzAOXHnbSX8VF6PWnG6aSi0ib8e+fJYKstS53dMusbSAtM0o+VpzP8zztsWAiezjDD290NuVuG7JtwnBRpDH6AUYIaMv/ei2/WeSqX+JrX+st/yjgWOazHFn2H3dbTJGFm7kQseXAB/vr7hwbscxp0JcGYxFi5vrpOOt3rhXp2Rry74iLsp/V66pUCCVQPjIxi0WplcrAbFRpXozf2pHU+PEi0ZTnt/bTtlAg8WuikJZqwzeFEWqKJuSUKdtRUt6mAoXVHZdUtPldVrtoXtXXinRw/fqWVXqmvJ0jpQYsLnEheryRTuRQ9dL+n977MI+HhLC/Qpbit3HgDZiV4MX3GMKAQuhF4DaikXTXKe+3sMPJBDfHdPE+iMSgeWtS1gqCVm53C2jG9sf6faPmmHKZLUgfsBOJB6bB6c1LhEWHiV9wZlgNPoxSo0msnmnWdVW68AYsylDWTbltZj9tW1uveVk+0tAZfMuOBoC358R3Lyb3dMicVWelWNv7Fiw7wPECo/RFtj4ehNk1I+8931Kruxz9efiFFb5AxbT1Y6ZX7tHDXTm7WHr8QfL6cBADPF3jx4mHFVTd0KS2XyG1RkhBQAhW+9xMA2HiW1j3R/KwpMTIkoyRgdZ7ELxHCg+uxRd9Rlfl2FVZgZu5E/PX3DzFA7XbWYvykDIxLZsvgiOVFzlTxYSZdaAlndXZE5aD+lgJ7cVeywWhEfr2EFw9LWFkiBcz1qqluY4m6lLhw3bAEoNxOm+TTui1K6WnnRVG50aApzxMM9Noy/eOTb1TwItjpdavQpg558VF7GmvrATABoAp2W+0+e9tmMKD55lKh41QXqEy4skRZmJFgpbRZUmC19Z54Bq0vfxIX1Gnl10tUPhQ/JM+Tbng0CfbFo0HrWgHAG+v/ifuumaC63ZZd+zB1xkTcO++7AJQ2TVNnTMTM3IkDciLxoANWfXWdVNPRgtETkoI6LZM1SrisM9SZLG0exDHxv/AlGrhflCFjUYbMkok8tGi+E3+w76n/nh4keGjV1pejK86GCWMykTnSxpxMR0cnOjo6GcTa2rrYOJcWNlTm41ch1pO2VEn3D1bq6638R/ujx8q7Kr19+sDb7/ePQhMELmeHUhp+7UQze1/LPBIbd8yNN+D5S619gqFwWOfOSWld1ccvVeHWyVNhXzyagcfTJOEdhwMfvP4gu2xXYQX++/tLMX5SBsxWGbudtdi5bR/GT8oYkM95UDqs+uo66dj+KiycelUAtMhlCWidMaxOW32IsTOtLPEvIsh3KafxHr0xqmDdHXgHprcib0VtO0JqXeiKs7FQh7eHqSZ60OL/D5Yk5MMeBBYCjdcrqZr4BnNOerDim+xqXxMe3sESjGcDXHzz4+1bTrH/P9lWJ744F6LalGrG7/5yO373l9sxKjcJ8almjMpNwqjcJLz+3AbcOnkqbng0CaPGm1jZb9c/vsD+L99n0DpUeRKvv7mGlQF3/eMLf1kk1DCgyoKDdh5WfXWdFJMYKxO0tOXA+DATStEsPtGnWQ7EuW+pI+XXS3JERAgOtgJwdmKWr5SXr3FNFL7o6OhUHYz1gMWDora+HMPH5EBBUzlbJXi4rxFt5kgbuCBCUGiR+PSd3r6DLQ5Jz4WHlXaOGA8fvRKgdi6W9rXRlhzP1vtHrsjb3S13dAMNCMEEm9c3ruXvjBEsESp07tRSJ0s18MjvrMzDuj/8Ad/5w3X41+HPAAA7jufhyNYovP7cBlWZ8MhW4J1dDpheXYN7530X/7dns3JlN7Dwt9fg9ec2YLcT2P2mMpF41HgTSh0D5zg66GPtq3ZuxQuP369bHhQu6/y7q/7CbnxkJ8ZHdmJ4FhvkVbVZ0roOKodRjzyt4+Gb4VbUtqPxSAG64myq0mBIrYvBwmCQmcvSc1sGg8xOHR2dAWNc/ARje85wNnY2fEwOxs+YgvjECIxMMjNYaedT8bDjW0NpXRftN3OkLeAx8rc9m7DSc1x8Z3ZKkr52ohl881uh81cSjE9VfvD8+qNfAgC+M/Y6AMC0UbMx5iogZU4iu/2RrYB1vAn2xaNxfHQ+EuZYYE5WpqAMm+v/kVVrdKHW6MKo3CTc9+tbBtRzHtSdLshlLd+4Bive+i1zWi1NzUC8Sbis8wCc01TAj4jGopMBsXa9EhdBi3crdLv4xAjWFsmeM5yVFYECNmm3tr4ctfXlAW6MhxVtl8IV2nEnGuvi51hpy4PUP5AXTWbmQRVsAUjefW1zOANCItrFJv29Dc/tW+dL/smAEmvvONWFqlMirn6+QUXnCThVDSb8+qNfYtqo2coP+d99AeU9akdNpUcp95UDTWhBRLkRVXNNWNewE2OuAoAoVDUA6/bshDk5yneZss11e3YOqOc+JCYOH9tfhc9XfMmgBQA1HS3CZQ0CILotNmRdnYnhWSNUE3ZHarqWax2HwSAHhCMoEMGPX+U7alkpEPC3RdIb49KW/ei8Nk5O7aB48W2XaIJwRW0764xhMMiqsTc6Eaj4CcT8dSeqPLrJRT14+aB7zsFBcXVyVQJW5w9U5Krsi0fDvng0xlwF3LVoNm6dPBVVDSas+t0X+O3PPsDM3Im4IiEOVyQo1Qo6f3xXFQDg1Cf+z/+0UbORFK3+sfTcTX/ArZOnoulgy4B6DQZ9L0FyWZsdezHhmwlYOPUqrNq5FcJl9V8vHj6n5UC5p4MtORQtCLTuhtyVtlzGdzbXji9RO6f4xHbWnJb6+4WFhQYAIVizXNov9fjTc1d8o1uCr9IyKjRg/I0mM4+sNrOJyvzqySeqPL2OsWnc2XkDh4DUhSn/UYmOSn80ZkUQuiIhDocqT2LLrn24IiEO7zgcaKmT8cbn+9jtdteVwxQrIX6TGUkLo9i21jUoburjl6rw3E3KbQlwAljnQMs3rsGSGxdgT3sxDnzZjNKaaqTHJzKX1d7WIb5kPYNGPtfbp7WXNjt9a11xzoh3FTSmU3zCpTrQB0n1SW1tXTJBiybpardH4NLCiWtVJBO8gkErK92qAhRfilTaSoEtJaJd5iQiIkQVkNBG9um14LvNa98X7XOikqHQ0FdNuQe//dkHAIB3cvNgHW/CrZOnYsfxPJz4f0bMzJ2Ilm/KMS55BA5VnsTur8uD/pBsqZPlGnhwZGsUcJMCwB3H87BtUzXMVgWEO47noaVuYBWnJFke/NWymMRYOT5M+fLPsk/ChNkTsHzjGhz48ihM1ijFZdVUQwCrh18uISG8EzqXr5NMiwdmXZ2pchN64nv86cBKe4GsTeHpuTmtOCfD4JCVblXBpK2tiy1lol3ll7ZLTXsratt7BU8/naoMKCVKrbvjHt9F99nu6urq62d6SLotQAlVOFYc40HU14oHAMhyqAH/9ftEPHfTHzDn9p/h6/9rR+K0LozKTYKnsplPCEr9ee3PmbMfSm+kJduCzY692J+3H0tuXACTNUopDUKMZQ2kH0nODr+70i4Nzx+Iy6pb2PiRBlZBWwzx41raeVNaKFJneD2QFZ9woai0CW1tXawsmTnS1mMneUdBIzZsKsc/PvlGD1b84+7LSSUCMb/q8RR7HANzRESI+GxfBKLARU25B5MXKoELmj91l90OU6zU23dE/YXp9OLIVnVpEUCPsLqQGnLLi1iyLdjTrowjLJyqxF0ogBHMnfX0v9C5UVtbl2qCL5UA9Zbc0IFVwC9F7sS2r3UhPLT4+VL2nOHkqJi79HolGAwyIiJCGDRvmZMa9PlQGXKKPY4t40Fd5A0GWcbpl1tl7SrJ/MTkKfY43H/nGAGti0yjcpMwbZQStiBYBXFYvbr4MVcB76zMAwBc9l/Kd+L4AAtbDBlg8eVAAJgcngl3oRv78/ZjwuwJKpcl1O9S1LkQK7nxzWxpvpIe2HqDVVa6FXOmp2DO9BTcfutotuQIL735WgDYnCm9fWeOtKnASXDlJwbz/QQpMBGfGIFb5qTiljmpuP/OMfj21BHISrcSuPotvfImPQb6S5H5UKMkoDWE3VV8qhk3PJqEuxYp8fUdxxXQmC5JxW5n7Wl/h7/eVM3mbP3uL7dD6vQOOHc1JB1WMJcFBC8L8q4qWGNdobMDKvoC8G2W+DAEBS2KT7j6DCtK3NlzhmPCmEwGDr04PAFGG2vnSn1svEirD9YdC7gf79i0MBk+JgdxMals275Jv6cNLXouegtE8n0XhYYurCYvjMJzN/2BhST2rGrGocqTeGP9P3Go8uRpfSc/fklJAiZFt+C+X9/Cd8cYcOOigxpY5K4s2UonaXehW+WyAODaxVfDZI0Sn/iBAy1W4uKhtc3hZJ0r+rjmkxwREcLKY9RhosvXdilYB3W9MaiQWhc3yVjf1dBj/mDdMWzYVM7KfyOTzEEDI9S3MC4mlZUTfds57R9E9Lj0OtEDQMgwo3BZQxRW9/36Fjx30x8AKJ0t9qxqhjk5CuOSR+Auux3jkkfQGFZf338JAFteZNqo2Xj9uQ00djUgQzyDFlhaWNFfclaz7JOwfOMa5pp60ugJSQHOS7iss68pMTISwoDvzb0E35t7CStjaQGhM9dK98szw54QsKJv45EC1biY3vYnjMlk7qS2vhybvvgam7ZX6D5mvWh7bw1waf/0eNjz50IS/ZBEc7Fovzxc6fkTpIXLGpqiSPuEq+/AhKvvwJ5VzUiZkwjreP/7fUVCHL+OVa8/HAlsr7+5Bi11Mr4z9jrWOWOgatAAKyYxVuZPgBKm4F3VLPskFbTchW7UftOE59942P9rpQ9pwdETksS419mXlF+vrIFVU93G2ifxXR0ILJp+eVIwd0XOpqa6jbVeoknBJO3Y1IZN5WzpelpokYOVBCCgDZLWZRE88h21LL6e76hlfQwJKgQW6rJBUPFtv18Rdx5aJ6o8+O0rnwe4wmBLnQgNbrXUyRJ/ApSWTLdOnoqk6BYMmxuO3O9dg9zvXcPPvZJ7c1b3XjsR7//1Yfy//30egJIUHHMV+uvSBLD0VF9dJ1FH9vgwE0ZPSEJ8mAk1HS04tr8Kmx17GbhIlmwLc1kvPH5/0G27C91YfN2NCI8Ik2s6WlTbEDorYr/m8uslbHM4VQf0YGW43kQNcE9UefDW/27Hpi++Zh0s6KSFFsElyJdYBvSXoacxJFqtmKLzfHulDZvKWS9D2rceVL49dURQKPZ0kNF25CBgV9S2s/0Gm2smNLTkqVR+UFNbpZ/+5hX89Dev4IrLUnHFZal9gtYbn+/D62+uwfJX17ALp42aDZrjJYB1lsBFzmqWfRIWTr0KoyckoaajBZsde5m74l3W5yu+RNwlVgY53mXR9gAgPT6ROav0+EQxb+ssuis6Q+k9Ao12qXvN3Kmg7koLOG2LJ3I7vOvgu0xsczhRVNrETxgG7670yolaN9jW1oVN2ytUHeTJtRE4T1R54ChoVCUM4xMjkDnSdjqpQYlvQ0XPR9uEV4xjnV1pF0iUQw2q04V4TClzEllCcNqo2RiXPIKVA69IiMOv7r4Zv7r75l6htfvrcrz41ocwxUpsewOtQzuvQTsVvKajBat2bsXCqVdhyY0LsD98P/a0F7MSIY1pAQD1GVxy4wIsxxrU7Fe+6Np2TZZsC1BTjT3txey8UL+dFACwpdMZCIxGJIT5D/o9dSnvodmrTEt00DbovBZWfONZfh/BkofDhhnlU6e6A0DIr8Wl6evH7uv1Smhr65IBZcIxOTTaN/9cqWQ4xR4Hi9uF/Hp1ehIIjKZ3dss8uKWuU/6l5rc5nJhhT1BKkj3MExM6PVDR+RseTcL9M58EAPxpy9OoajCh6WALju+qgqdJgZbU6T1vQYVbJ0/Fd8Yq61+9/twGxMEGAJiZO5GtFnz7fa8CoQZInV5Z73PLVxZG5SZhza8qgReV5KEA1ll2WRS6WLVzKzY79uLhXyzGBExg4Dq239+0cfSEpF63uae9GEtuXID7vnwWx/ZX9ek+F4u83d1yH5udsrLaC9nKF6gpRPkBsdkpq6DCH8iD9O0LaLtE7ox3OVpY0diUptNET9sFAHm41A0bt33qA0juqQ+d0GnCsdzW1sXgZjDIqhIjOS8AyLo6E7OOFGNliQRnh/K6hRolRIfISDPLeGl+LADgtpX1srPDv+/Oblk6XuaWQ4YZ0dHRyV5HR0Eji7cfL3OLD+5ZgNUNjyaxJTv+tOVpAMq6Up5K5cesUj5TXn9Pk0E+19AyxUryqNwkfGfsdbjrvadZWyZzbhQiyo14Y/0/gfVK94vc7BTWrX23sxaHKk+ipU7Wbb1mHW/CleMzcWRry4BOCQ7qZluWbAssUJzU8o1rMDk8E9cuvhrX4mrUfqMcMOIusbLzyzeuYQ6MJhTzacC4S6zcROMk0TT39KGFxwpdcm68gR10sa2OrWbMx7F7gRZzbaFGCbdEuOCwjQhwLfGJEcEg1dvjlQEgIQy4fFIK2+5pwCrYPmWf+2LP7ZYIFyoS/WOkFWMykeYs5u6mwApQlp23dlnwwMgoPFnikXmn1dktS/A5Lb7pL7k3ADhe5pY17kyon7CqajDh9VUbUFPuUXWRoBZItCT98V1VMFtltNSdu16cBKu7Fs3GnNt/5utGIcFslXF8VxVG5SZhHPwpwSsS4vDAqw9j57Z9eOOny/QqIRIAOd2uJAMdK47Rcxywn5lB2/yWj7VTSILGrSaHZ2LC7AmIu0Td7aD2myYGrZqOFlWfQQDY+/UqvPTjN7His40XXdPcnhqFeru75aU5Bjxf4O3XshLe7m45N14ZJp0XY0FTiBsb2hTndcscf6KP+uNxcXbJ260cjOn+sxIAa5cF02cOwyfb6rCyRIIt2d+gVqdvX6/lS2rCC0C14nFj0UkcbA1VPZ6zUSqNiAjB+MhOzEpQQMWr6Mti3lEBAJwdynVTYpTHuN9l0JYH2TgYJSstbheyrs5ETXUbtuyqxFAG1rlqfmuKlWSCVQ8HcZnAFZ9qhjk5Cp7KZgLbOQMW/z/tRw41yKPGm1inClpmxHRJKlq+Kcc7Dge7z7jkEbgiIQ67nbXYVVgBqdOLdHtUv/sGXqjmt4O+nbG70I092cWYHJ6pAtWE3HEAgEvivw0A+Kbm39iPQ5gcnolVHVtVoALA4DVh9gSYuPW0hJTxJ2tXFAzGvte2CVbzYhQH/EWsBYAFaFNcwIZN5eDdAQBWRqP7zvJN07J2WdAExRlv33KKfWq1jipUYWm/XEV+vYQpMTIai9RdAizeLiBUYtA40x+GAJRxrkhlaZVZKMbcGbHMSRUBeHRtHV6aH4tFGTJWliiPK79ekva7DPIEm1f/dfZKUqhRkotPuDBpuL/syL0mwmWdBhRojKoHxyH5oCHXwANzcpQCjE3VKK1rPicuKxgIzVaZxdwBYB12YvcntYCvDEi6y25njuv1+15llw/kEmDAsWiwu6tZ9kmYHJ6JPe3F2NNejOUb12Dpvcvw0o/fxOert+Obmn8rsNp1CEvvXYZVO7fihcfvxwuP36+aUGyyRmH/rkO49rbpvU40vkik+jU3bP6VSAgLvDzI/Rhwps8chqYQN0vMkbSd1HlRKXHujFhWRrR2WbC+3o319W52GUGKThNsXjyc5e1zQs4HIym/XkJ+vcScXJnn3H53yzwSVpZI+GRbHQCw51PmkfDoWuWyRRkyAw65q55klJTr3RYbg+/M3GTxKT4NUay7YGMlfyCXodNkGYDUUiezmLk5OQpy6Pk7rPKuixZidKw4hlqjSwWre+d9F7nfuwb//f2luOOnyyB1evl+gYPnx/NgARR/4jtcEKjIYQFKgnBPezH25+1n4AKAh3+xGAunXoXHnv2T8ss2fwUWTr0K8WEmLJx6FWq/aWKODFAnDYekc5IkmU5UgqMv5x9/PZf/kqIrzoYHRvZpFrwEQNpV48VrxTIeXesfu6JWRoB/XlNHRydbyoN3Pdf8rR7X/K0e+10GBirSrASllGfx+t3VBJuXObL+Oh/6W+aRYO2ysDLhWXJXqv3R5GkC1Sfb6lSPu8wjsddrVoLyvHpTZ7csRYfI2O8ywOJ2qa6bmZssIu6nIc3S8LJOuUz1mpY6mtF0sIXvPHHeXvP4VDPW/eEP+Nfhz/Dbn33AgBufakZ8qhnjkkdgyy5lztWhypO44rJU3HvtRBQf+gDv//Vh3HvtxPP6eId8SZBSgaMnJLGyHwA2RkWhiv15+1mowl3oBuxQlwhzlftsduzFY8/+Cfvz9uPaxVdjwjcT1OWgbAtM3NyswRS8MEiS7JX7VgLyyrJkkCT5hWwb1te7savGP27UFWejkpTaZb38CUu09VRGMBiNyLH4vwP8hF4ALNhACTpfaU/SORjL+fWSKj1HB/PNkAEP0NAlocwjYZmrX29RQLzX2QG5KcSNeTEWrIcbACsJns0Sj5RfL8kJYT4nl+B/jdLMMnN3m53Kc1Rg5tUdv+LV0CUxaG92KuNwNC43MzcZW3ZVitJgH1VT7tHCSvW65dyYTO6L/yzJnspmWMebKHxxXtyVffFo3Dp5Kubc/jPV406Zk8gASvF7wD+G9cCrD+O1B5fh9S/2Y9DUAzGIxrAIWsfg72pBDkjb3QKFynm6HQA8/+flDGQ0UXizYy8237tXtZ0Nl7ym/DoZJGVBg6T+9bz1nngVtIKd10Lrn/+XjWfvLUKZR8KsBBkhtcov9TnTlfQc9cS79sbRLChBc490Pu8yBQVUBwKd5em5cSipJ7B0dsuys1v5dzNkzEoAA0uDS0KDb8Hdzm5ZOgNHIb14WJJ/NVaBVlOCGytLJDTKRpxSEnlnDVrODiX0wYNps9MfAinzKM/zpfmxmAvg2uUNQTcWapTknhym3XUSjTZgv8sgoNWLWupkicpsXBiBfZ6u/FUmKjYNjPmZniYJjhXH8NWLxfzCjf7xrMnAuj07cXxXlWpSMZUGdxVW+OAq9+QkRUnwTKBFJT/qdkHjV1QeJIdF2uzYi1U7t+LY/ioc21+Fmo4WVgIsPHECn+SvwJIbFzDnVvtNE5b+fAmDG/UnHKgiAOXGG1iiLjfewMp9/HmCGV8OpO08e2+RP4IOoHbDx2wJexKf6ktLNLE1qKCp7xPkhmeNwPCsEXBbbKquFtrJvP1wRBKV6ahsRqEOKguejZDBZidYCTLNLOPyqHOSiJIIspudwNwZsarXn9wWjXP1MDYnk+MEgJUlEnNpjUUnYXed5N2qIFLfoIVSh5L4y7kxGVf+KhPL1tyBZWvu0HNg6u/IOYQZddoAlGTgV//5C+JTzSpYAWBrZb3+3AY2T2vYXGUqiemSVLz+5hoGq3HJI3DvtRNZZwxfW6cB+0EZdClBglZMYqxM614RtNyFbt2YO3W24EuKcZdYseFfr2HpvcuYM9uzsRir33sF+3cdwiz7JOxpL1bKj59tHPDQIvg8urYO82IsKPM0o6pV6dyQFGlEVWs3XNfEIHdtHYMWD7BZCcp4yqIM3xfPF7vmuzXw40+Af7JuVroVZdUtqu7rbosNtJDHyCQzi67TfTWdJ/oFmP0uAybYvGgKcWPujFg8DTOeLPFgVgKw34UenQh38NadQBxqlFDmOx6t9PjhEaw8dCbq7JalMo8kc9sHAFaGJQdm3XIKc2fG4sXD9T1CdlaCUhqM1ll4WAmTgMq5wmX1/uNIbqmTUbCxEjlIxjrsBHB6c5X4YATv4Oj//mzj04//iutv+KlMTKH1qwii8almvLMyz9eBQ4LZqlxWsakaMEKZWAzAbPWnBgFg57Z9+OlvXoGnSRrQH45BH2tfcuMCNrfKkm3BkhsX4NrbpuPz1duxZ6O648Wx/VU4hiqs0AAoPT4Rk8MzseKzjZh02ULUV9cp42J5CJjLNdCdlgIgNx4YqaTq5sVYgBil48SO3xVhn2+cJzfegE+21WHrPfEsmbbZ6Z+PZPdN7s3vZb/8wos8xMhJ8ZArq25B8QmFKGFhoacFKwBSZ7cy92izE5gLJYk4od6LzU7FiSwrUpe+CFTRITJWL4rBo2vr9MpjMo2TaV1OmUeJmPvGkfgDfk8tb/ql7VtO6ZYNAQlNCW4AsUHvS495s1M539AlAR7ggZFRbDqAEiZxwynmwPcHWgAgF2ysBDbqXsd9eAy6zotA87u/3I7f/uwD1dpWrz+3ATXwyFqQEcS0/5NoW/knvmL9/3h9vakaNKGYnyMGIKA0uHPbPua4pE4Z0gDPXgzqBRx5WLFf375k4LI/rsCx/VWIDzOxk3aiMMFqln0SC3KUb7oVMYmxuPu+Jwbd60ElwDKPhMcKXdhV48VjhS68dqKZHdA6T3VjaY6BTcSllBqV2KgpLXUZ58t2fDlvZJIZ+Y5aVXlPu3pw8QkX2x6pt5BFX0VlLyqZzYuxYL/LwJ5HqFGS6RQdIiM6RMaiDBmfbFPmOlH5UHvgTzPLvKNi/89KYGU5VgKdEiPjV2NlPHdpVH/KKKrbUYmzKcTN2lhpoMXShL25Tt4NUrnR2mXRLZ8K9a8UrTkFvKfaiLgcamDAGZWrtHmzLx4NAGyCrzk5CvGpZvzuL7erHBRf+qP/41PNsC8ezSAVn2rGuj07UdWgHmuvKffAbJUxarwJo3KTMHlhlBIE4da5oknFu/7xBUsO5man4IrLUgPKi8JhnUXtz9uv6vvHJwjp7/48dVNc7TpXlmwLNjv24tH/uQeXb7wUm06MQ3zYZ/j5Lbdi1c6tgwpWALCrxqtyXHTdyhIj0swytt4TD9c1MTj8ZJWqnKSCAbcSMP8/X87TXsZDLQAuHPQUUJ1594iGLglpkFnJDFDGsPa7DAw8sxKUsaFPttVhWZEBm53KZdu3nOq1fKgt01HJ7eEsL5sTll+vBFTW17vx3KUW/PpovyeMyglh/i4efHT/tL4PPmhRFH76zGEAgPVr/edxVBDoXEiZe6V8ZjxNEmY8nIFbJ09ly82v27MTjhXHWHnunYNK2Y4gRq6LwFaxqZqB7YZHk7BnlRKb3xHtb07Lj5fxS4KYkxVIJUW34P6ZT+JPW55Gk+/yQ7tOKvOzNN0vCGTUe/CNz/cNyADGoAYWAeXY/iosnHoVJsyegGtvm47b7nxINa5V6uu6ro2m88uHfL56O1a/9wpe+vGbAPzjXys+2zgoWjMFi7ITyKpau1HVqoxxlfla/yzKkDF3RixWrqxXDvDzc+DeVM6ARDCibhL8XClq6kow6ujoVN2HvxxAn1YQ7m9ZsMyjzGniD/T8vKXNTgDb6jB3RiyWFTVgv8uA/S5ggs3N5jjxpUGCILk3cj++CdNKjB4AoJRaDzS34sXDyjhhfn0zEsL6PEYk82Dc7ATmxcC3HQXmvvAIaExtpafnDdLz1iYFP9lWx57Po2vrEGo0iPDFWWaVHGqA2eqHFaB0U1+3Rxn38lQ2s5JcypxEVGyqZv8TvKicmH/iKzYHrOlgC/4U/bTPRSnb+PglD4NTTbmHuTdPpbICMb9fatpL8lQ2+8a1ZBWoCFaAEsqgbu9vfL5v4NndwdxLkO/aTtF0clIUXSdHpQed8Igw2WSNwsKpV2GzY6+qNLjsjytgybbgwJdHh1QvQYMkyUmRRjwwMgrTZw5jfesIWI6CRjZHqpf+fDKBS1vuO4egUv+o9XW3oBIhBQ6oHEZOa16M4l74bhF0P838JlmnHMQup96DvvsEvV1fgMXH/gm8BCsqadL13L6kvrwW2rIpvb/0Gg2VaPu56iXYn9IuX0IjZ9V0sCUAIHTZfb++Bev27GTuiABWU+5RjTfx407a243KTYJ1vNLnkBwazbmi9kzvrMxjacEdxxVXVlPugadJYl3cCU5TZ0wEoAQvAOD1N9fwKxdLp/PaC4elEaUFqawHKGNauFGBzegJSTjw5dGgsKLLyWVR4nACJuDu+57A/rz9WLVz65CDFbmtxwpdbL6aIqOqv18fmsmy5TTU5T7du52L11CiScW+AzwrFTLHBEmGB3jN04w0Mzv4Sz5QycGeU7DLnR2QldCCrAcpuqwvvwCl/Hr1+FlDlwGAuhs7uaw+vIa6r4Vq+y5J9fyFzgxUvKvinRWvpoMt+M6d1zHHA/jbJ62DAq1bJ09VEog+gFnHmwIcGTku6lVI3TTiU82q/oFNB1uwDjtx6+Sp8FQ2s/1WbGpmnd0B4FClUhYc56zFll3+dCD/fAZiORAY5KELEs3Huva26dift59F2/lwRU/a7NiLyeGZOLa/Cvvz9uObmn9jwuwJqvGuobD6sFeWpWAnZwfYCrxcIKKvy4n0djpnFQI6dXbL7MQf9J0dynwnbS8+7W37u78evtTSaWxL97H4Luv3+8C/FtqT4E3/RasMA5BNsRJMsZIurEaNN6GCAwpB59bJU9lld733NLufOTkK3xl7HW6dPJWNV/Hn7/v1Ley+BCZybQAweWEUpoy8kt2PIEnjZk0HW5iTG+XrwEFzr/hy4F12O3KzU9hl/DIqA00hQ+EDRb0DaewK8IcuegtOkMva016M0ROSlO4YP36T3X+owKoP5ZWhfDCTACAiLFTWKWWIg7hQAKC0l40aH5jGI1jRdVS2I9dUsakad733NIOJOTkKFZuq2ZwuAPjX4c9UANM733SwBZgMPP+9X+BPW57GlJFXquLsU0ZeifwTX8HqAybd3zrexFozAcDxgy0wW2UcqjyJe+d9Fy3fsLIfW3JkXPIIHMJJjEsegd1flw+4OXuDHlg0jsWDavMf92I51ii2OczU516AFN64dvHVWHrvMraA4+LrbgyYuyU0+NTW0SngJNQnQNF4Ei9uvSsAUHVlp4TfOwfzmOOhMt07B/MYPAhAY64Ckq6CqlxoHW/COyvzWFlw3R5/eY9EMfZpo2bj9ec2IH/UV8xl8bCjfSVFt6CJg+5xH7xavilH7veuAQAc3FuClm/KWfCCrVKM8oH3y3Owhi540arBLzx+P+IuseL5Py/XDV8Eg1Z4RJicHp8IS7aFzd2iThcUlb/vl89CrDwsJDR41FPogocUpe74Az1zNvCX9rSLHMqhBtlslWFfPBrv3Pkk/nX4MxawoMAD/Q8AY65S7nxkq799Et0mKboFR7ZCBSdeKXMSkRTdgj2r/GGO15/bgMkLo1gakDpeUCiDnN2O43k4slUB4rZlJSrXuOmDvwDwBy4O7lWuf/GtD3usQIjQxRm6rPCIMHl/3n4AvvlYv5gAQAlgAECN1V/aCwYePh6/7I8r8PAvFiPuEisW/tcvBayEhIaQm4pPNbOxIq2orEZlP25MR/cYkBTdwsAAmJhTItdEpbppo27BjuNKeo/CF/86/Bm7P6mm3KNaGRhQVhHeY1QcHriy4pGtQFXDTpYgpH0mRbdgysgrkWhSAPzcTdcp5ceH/e2lSh3NmHD1Hao5XHpgHlA/QobSh3HVzq2sX+DyjWvYeJYl2wILLDi23++oeHDROFZ6fCJW7dyKPe3FKK2pxrW3TcfcKYvZfQS0hIQGP6xueDRJNUeJynL8Mhya4IFeKyZ51HgT7vu1AqFff/RLVq67dfJU7IjOY6sWa10TwUpPBJ1dhRUAlETfXXY7djtr2XUELb4VlDI+5Qdu0sIoBivtfpsOtqBgYyWuuCwVhypPqrbTG5wFsM6SCDruQhP2ZCulvM2OvXj4F4uZ04oPM6Gmo4WlB3lw8RH3yeFXYfJ1mXjpx2+itKYaVC4U0BISGryw4kt3PKjInfQGKa1ojGvaqNms9Edlv2mjZmNdw0427kUuRjuZlw9PENgodah0VAd2+5a655N9h8pPMnjRuJQ/Wu9BVUMi/nX4M3xn7HWYMvJK/PqjX+K5m/6g2jd1tiAXBwC768oH9Ps4pBwWQcfU0QJ3mLI0yP68/djs8K95hUKoOrqv2rk1wHHxqUCTNQqWbAsbExPQEhIavLAivbMyD57KZr781WdXQe5Kb7yrqsGEHcjzgbBZ5Xx2HM9TAYtPCB7Zql62hHoTttQBu5oq2DauSIjDO762SgSwQziJ+FSzClwVm6qxIzqPgbliUzPuanjaH7HfqIBwZu5EzLwkFS3flA/IzhZDGlg8tErRrFroccmNCwAAy6E0y13VocTd48NMqPF9GAhGBCTqogGAOS1q8yQkJDQ4YAX45yn96/BnbPmN/i4ToueudhzPY6VAGjuqajAx1yZ1yvA0GRCfqkAJPpjR/ZoO0mThagYbbSNdqdOLljrF/ewKrQDg71bxjsMBT5OEu+yZ2Di+GMcPtkDq9KKm3IMjW6NwZGsec3lm38RiguuhypM4tP6kKvXo2/eA/UE+JFKCeiKXZLJGsXEtbfulx579EwCori+tqQYPLGrbRKAiaAmXJSQ0wH+Nh4SolvPwu41qclb9/g6Tu5q8MIo5KgIAzXnSxt994GRReT7eDoCtXaUFlY7zkzWPBVKnVxWv126DWkfxSUiCtSlWQkudrHf/Xl8XkRI8A1GsXfVG+capWpqaceDLZhyzVrFl76lMOHpCEluJGBOA5994GLXfNKnKfnvai1HT0aJbLhQSEhr47orSgDuO56FiU/MZwYrOTxs1WzX+xMMKUIc20u1RzJGxcSpNVL6HdaiCdlWROr2yFlJyqIFNZKaxs5pyDys3Kg6Ma9QbKvULVBdag7o1U0xirExlO+2JfVjiExm4SmuqsWrnVjamteTGBXjh8fsBKJH25/+8HMs3rukRisJZCQkNLlFsXLt21OloFLe21LRRs1nTWd5Z8eNi6fYopMxJZGEMui9BlHc3cqiBnfooVXsvU6yEy7i1tm54NEk1+ZkgSu2lCGyDBVaD1mERPGiCL5X4+MUcKRFI0OInEJeiGYt9gYw97cUqwC25cQGWYw3CI8LkEIsJ7kI325Z2jEtISGhgi0phZ6MUGOw6gpVOgEM2J0exsMev8Usc2UoTiFtQwbkjvSVK+vM4lccn+3sWLpqNKSOvxNKGPwK7/LCifdDrMphgNSiBRY5qln0SNjv2KutW5fV8n5qOFgYlClis+GwjW20YdrC1s659bzoA4L4vn1XdNz7MhFI0iyOAkNAgkra90hlty3ewJyhQSZCclR5kyFmRI6tq2AmgRQsbVTPdHsayehQtNUKwInmaJEiQA1YTPn6wZdA10hxUwOJhde3iqzHhG6UjxZ5sZbFFd6GbOSkeVgG/ujj4kDvbs1HZxqTLFvrfaGeDFJMYK9d0tGDh1Kuwp71YxNqFhAaJWuoUx1HVcHbdGsGKVv7lAhb8cUEmQFS3tCD/xFes+wV8nS9KHc0B5T+CS3/dldkqsxAHJit/lv7jj3CsOKYaszJbZRaBH2zualA6LEu2BdcuvhoA2HjTsf2+2elN+g7IZI1i4OLLf6U11awFk7vQDUu2BQ/fuBjLN67BgS+VbVHbJ9VcLiEhoUEldjA/DREQ+EUVaRXgILBigKtqMCH/xFdYt2cnuy+l9AhW5K5a6uR+w4rfFzm9deN3aqP7KjAOVlgNKmCRu3IXuvH8n5cHOKremtsSuPQASP0G+TW1DuBowG2X3LiAlQqFhIQGvio2VQftGdhfIPAThanfYBBYyQQIWlRRr5sGRdJ7ibT3WebkKNSUe1jrJfaDPVZZV9TTJJ0RFAeCBlVKkOA0OTyTdaroDVaAv/USJQX5MuGSGxew9k2bHXvx+ertyriYD3R8J3dqris09EWrMwsNbvENYf0Hb/T5veXdFW2H3BrfmUIPVnS9HqwoqafZFzmhfj0+QEkdWseblHKfrx+iFkqjxpuQbo8a3N/LwfRg48NMsGRbMGH2BEyYPaHfJTqCGpUOL7/6UizfuAZxl1hR09ECS7YFjz37J1ZiNFmj/MEMH9CEBKyEBqdS5iQGdCbvj7uibhmauVYBP5RHjTfhlb//N+yLRzNQ2hePxpW/ymSQ0qb2aBVjs1XuN7RoG0F6IrL/CaA+aA3Kz/igm4c1OTwTcZdYce1t01nkvL/QIhCRS1t89+/YtkdPSAoAJKCUH0WHi6EPJYMkyUmRxqD3oVPAQSPEIPe0TfGKXxBJLXUyK9+R+nrApq4WgHoJ+h7cFQBlMjAtUw8A7/3tj3j+e7/A89/7BeyLRzOXw4OFi7L37wl2eqWWOhmOFcdgTo7SgpGtGNxSp5QE+UnEgxFagw5Ye9qL8fmKLzF3ymJYsi2YZZ+Ey6++tM8dKGISY+XRE5JYeGNyeCbiw0wYPSEJj/7PPZgcnomWpmY23uUudGPFZxsFrIYYrLbeE68CEA+i1YtidO+TG29Abrz+VyakW8bSHEMAnAySJL+QbRPQuoCicR1yWeRofAdsWQ9UfCmQ7sMHJ3roQygBkEodzfjqxWJUbKpG/omv2JW3Tp4Kc3JUgNMiaLXUyfx4lvaxyUEgI7XUyfBUNjMw/u4vtwdAi/bhaZL4EMag+lwOmtAFpfXSAazqUNa9WnLjAlx723S89OM3ccxa1eMCjTTZmO63P28/nv/zciy5cQE2O/ZicnimavyKJhgH257Q4HNRXlmWACA6TPmyPjRWwiuHZRWEwgzAJ9vqdGE1K0H5f1dN4L7cAObOiMVmZx0MkiTTvgBg+sxhQKF4Py6gy5KP76rCKCgr8abMSVTWk4KHDuKyXomN5jXdOnkqWz6kp1SgDrhQ6miWf/uzDzAqN4+VB63jTYivNKO0TpnETC2WSBqY6QFF5vfhgywAJcpObjA+1YwaeNBSJxO0ZD7cwe2Hh1rAtgfUmzmYmt+GR4TJ5HyoYS2tDkylu2P7q9gYFd2WLxs+/IvFuPa26bjtzodYynD0hCR2vrcAh9Dgg9bSHOXL/HyB/8s6Pd6Abu52BCO6HQFHCyt+OzyUaD/TfpuF7/6Xmk5LcwzY7AR21XhV9xE6x7/GQ1S/x2UqxfF9/YKV9rQrEmu6WfT3PZQJKpf5whG3Tp6K3/7sAx5+MkGEd11cB3VdVwaduV/02IONadFtqDMHv0+dfeg+V9H8tg9i611Zo+AudGNPdjFWPau4raU/X4LPV3wJTADchaaAoAQ1tl32xxXYn7eftXAaPSEJq997BZ+v3s66twsNHXllWaIS4KuHa3BZjAKvbg2kAGBZETktr66z2uxU7mMwGvGrsbLKSdF+8F+FoDGwNLMcsA+hC/fjvNTRzCbzmpOj2Em7IjBJO/Z1um2deHdzfFcV4ivNwGRgVG4SzZVSEWXZmjvwzso8FGysVHVj9zT5HGBsALRUbrK0Tr1oJN+xvdTRjJY6mdwdg5M2schBTB5IbmtQLi9C0KJu6wunKv1PqL0SdcIAgKX3LmPwouv5WDvdd9XOrcJdDWGXRWW/4JBS1HGqS+WuyJ1tdvqd2IuHJXzxkxi4rolRuakXsm0AgPX1yo+heTEWNIW4Ye1S/gqXdUEdlsrt9CXeTe7rLCwbr9qndokRLTBpKZTXn9ug7U+oKv8Fm/wrhxpkqdOreo7kFqnDBnWQt4434asXi1Xb5dtEBSt/XiiHNWjXw+LLg5TmI9fEJ/v4PoKAfy4XDypSfXWdOJBcJLDa7AT2u3qGFbmrzU6gzCMxx0QlQYLZyhL/ddau4FMtBLQGBLAYQLTuIwikzgRUbH/p9ihVeY4v3RG4+M4UAJBzY7LeQpOsvKgHLEo28iVBSiCarTJG5SopaD6mv27PTgYt7esigHWWoQUoY1V68XYtrLQwo0UZhasa+sDiy3pAz7Di3RXBisRDi0qDBCw9B0cilwWox8iELgiwdOGlPTaexYcicyU2qQ/7VQFVr09hsMcohxrkGQ9nYNuyEv8GO7097jPnxmTqjCEFeV0EsM4VuACwuVQ0AZj/n+83KEB18cGKB1V0iIyGLqlHd7WyRP0RIWCtLJHg7AASwqB7PYHxpfmxAJTkoSgNDkhgnS/1ZyxI1oBL6s+2fCVB6SztRwDrXIOrJwlICVhFh6g/JlWt3UFLgbtq/MlCClM4OwAjujE6PRquyibmrsiJaf9flCFj7oxYFbSEy7rogHWuIXeu9iUPJGCFDKUPqICR0JnASisCztZ74lUBC4PRiO/fmoV8Ry27XZpZxqIMGdYuC9bXu9n+Ok514fkCYGVJPdLMAODGvBgLcuPdAfO1hIS0hmIA7GtAfT5DxGdCaChKCyseVFS2+1sPLodKeoBvIvG2OmSPjgYATLHHISUuHLDH4fPKJgatzZAxK0EBEqBAa80dBlz5fDKSRpwEYERDl4R5MfT4DAJaQkL9+TEqXgKhoeiurF0WBp0JNi/SzDI7Ecy06/qFhSidr3fVeLGrRrlPUqQRzxd4EXfLDbhlTiqm2OOQ76hFRW07UuLCce2NoxkECXTr692YlaC4K+bkTo5AVWs3okNkrK9Xou6zEoDceINo2yQkJByW0MUqmv9E8AEUMOh1qzBIkmwyAh3dQKbPQZF2HWtg41Zv/e92lbPKd9QC9jjUVLcFuLq5M2J9l9Rhwfte4P2TAJQxMAIb3W4ugKverBFOS0ioDxpSoQsh4a74ib6UxKMGtHysHACyR0czCJFjqqhtZ9vLd9Si8FgDKwUCwN3fnw4AqK0vR0VtOwPWp9vKGBRpLhZNGua1vt7NgEqPcWmOQYQwhIQEsIQuNmC9kG3D+nq3KjauBdaGNhsA4JY5qQHbiItJVQGJVFPdhhNVHnY/gtU2hxNpiSYU+twYX3IkIGndnTbeThLAEhISwBISsML0mcNw1Zs1yB4dzUDFAwmAUu7zQYsHFl/2A4D4xAgVwMqqle4pLZ6OoNAClNZN02cOU3WDp4nJPaUVhYSEFIkxLKEhJb0JuU0hblz1pt/JVNS24701Rar7ZY+ORk0SrUbbiPjEiABnRdKCKi3R5PsfqPJ0ADBipccfxKCOGY8VupBbb8CuGi+23hPPwLV6UQyuerNGvHlCQsJhCV0sDgsILKtpL+cTefyyHwQt0kgfvHg4pSWa2OX8dfxty6pb0OLpYLeh0MaiDFlVIuRLhXNnxOKqN2uEwxISEg5L6GJQsIO99nIeXHNnxGLaNTHY8bsiOGwj8Om2MpjMYbqAKqtuYY5KCzUAOHCgAlXu7oB9EiBXlhixKEPGrARqxKsELco8Rli7Tok3UEhIOCwh4bb8lw3zzTo85asO8mGI5wu8MJnDMMOegPjECOQ7ahm0SDyw+MuLT7gAAGFhoWjxdOjC0yBJMr9OFoncnXBXQkLCYQldpFqa4+8iYZAkOVszx6qkpBFuiw0Om5k5qxn2BNhzhqOith23zEnFhk3lupAqq25B8QkXMkfaUHzChbCw0AA46Tk7AmlVa+/OUEhISABL6CKRMnm3DgSrkUlmVZACAAqPNejeNyUuHI6CRl1Q8SJYqV2YkhYMBi3xzggJCWAJCamB9WYNxscbcP2MNAYqra6fkaYLLj7unpZoQlFpE26/dTTggApcmSNtuiEMkzlMFbwQEhISwBIS0hWV37KuzlR1seDFz6UymcPQ0dGJbQ4nTlR5MDLJzODDYAWoLs8caVNtS6vCYx0ICQmRu7q6hKsSEjpLEs1vhQb3B1iS5GDNY2uq2xisqIMF/c/Pr5phT2BuipxSWXULikqbkJVuDZg4rI230774+Vomcxi83d3iDRISEsASEvKLOp4TuPiQhR6s/vTeEeakptjjsM3hxLenjlBF2Enkqgha2nEsum6bwyneCCEhASwhoZ41KwH45/9ls2QgzaUiSNXWl6O2vpz9n5ZoQll1i24Hi5FJZua4+MtOVHkCbk+A2+ZwosXTwWCmdV9CQkJnR2IMS2hQi8arcu8twq4aL7JHR6tckLacV1PdhpFJZhQea0BZNViQgsBEsfYZ9gRs2l6hgtA2h5PBjCBFMpnDGAgBiNCFkJBwWEJC+tpV48WdC7ICHBNBqqa6DSlx4SwgQQlBAOjo6ASAgNg7D55Pt5UhLdGEE1UeBiuD0aiCFYmgJWLsQkICWEJCAS4LUMarptjjVE6HNOeay0C3mXPNZThR5WFlvK5OdWNcclAREUoBovBYA66fkYaRSWbWK9AryxKfACyrbmHlxLREE/iypJCQkACW0FD7MGrSfsESgNrLDZIk37kgCxs2lTNoEYz4cae4mFQGJO1aWGXVLcyJEcx48Hy6rQyfbisL2nopLdGE+MQIxCdGiDEsoXOmsfOj5bHzo2UAsGVEXnR99QSwhAaMQgx+GFHSL3t0NPSgNTIqUnU5gWrDpnLkO2rZ5F2C1qYvvmb3ra0vR1xMKrJHR6vGmvhghcFoxMgkMyv1eWVZopMerAhSesuRCAmdLY1e2Kr6/2KDlghdCA0YdXmBOxdkId9RCwBs+Xqt+1qaY8C0347Es/cWsQj7hk3limuyxyHfUesrC8IHLeV+m774Gvac4QCA/UeKA/ZP0KGxrE3bKzBnegrbv97SJXzpT8BKSEg4LKGLTLfMSVWV7KbY45A9OpqFKp4v8OLZe4tYp/Up9jgAYO5qij1ONdakLQ/S8vYjk8yqNbDoenJrWelWbNpewW4XbIIyjZfxa2c1N7eLwIXQWdXY+dGycerFfcgWDktowEivs3o+lNADXbb0nsvZisG7apRFFyeMyVStIMzDSrsPamobnxihatfEYu4Ac2EEQnJaZdUtuk6LhxUFM4SEzoXuTLLjcRQKYAkJDSRo8f8D/pJgypxU5DtqmdvKd9SyScG58cqvz101yrhUMEdEsIqLSUV8YruqjFdW3QJHQSODVj7AnNac6SnY5nAGQIsfw4pPjEBaoglRUeGycFlCZ+qoAODw2gbJlhEpj/m+Mv1i9MJWdp0AlpDQAICW3uVl1S3YsEmBE99yiS4DlK4X82Js+CLWEuB+SDQni0BXeKwBXlmWoqLC5bREE2uzZM8Zjim+MbGIiJCA7dB9aB8jk8yKa7PHoewT4bKEzlxZr7Zj7PxoOdkeDveRcLxX5cD/zJ+PH2MtKh3KDzRbRqTsKmm9KH4cCWAJDSrnVVatOBoFUuUMZCRlHSzgcG2EylERqOg8jWPphSRaPB0MWvGJEZhij4PlSxcO6pQam5vbGehOVHmYM5thTxAuS+iMdHhtgzR2frSc9Wo7und6cWxVJKr+2gn8Hrhr3iQcW1WISkf7RfWaSLI88Jzl2PnR8uG1DeKLLhQgbTKPAAMoJcF5MRYcHp/AulUQkGjNK77DBaDMr+LLkNfPSMOJKg+7fW68AcOzRihlxCPFWFkiocE3X7ito1MCAAIWAFV7p/fWFIluF0JnJFtGpJxsD8ezq7Pxzvq9OLYqEpYxzdjw+9uwo7sUj9/mh9bF4LIGpMMSsBLqzWnpXTYrAUAXkHKkGJ+XSLAlWxl4+LEwPtTBX8ZP+OX3Y3edhAMjkAIgzSzjgZgoTJ85DBFhoXJbR6fEuyxe189IEy5L6IzkKmmVbBmR8uO3FeLZ1ZPwDvaiZj9wy29WY8Pvb0PWqw5UXi0clpDQoHNeS3OUmv7KEoUPVa3dug7HIElyiAR0yUBSpBGXT0oJCF40N7czYNF2NzuB+24Ygdc/PqncziOhosXfnomgZXG7kHV1Jmqq25iDE++Q0Jm6rPQR7Vjx6q3Y0V2Kd9bvhXGqAeuSC3FrZTa2XI2LwmWJeVhCQwJWlBC0dlmwKEMOCityT6e8spQUaUSaWfnBRnH0wmMNrMTI33/ujFjMi7Hg0f+rwH6XAbtqvLqPxeJ2AfA30M0eHQ0KZggJnYlKT4Zj8YPrMM2Yjg9vLcKdSXbcWpmNdcmFuOpF78XxXRcfA6GhAKuX5seywEVf7pNiCpEBJVXYWHQSjUUnWaCiJ0e0elEMOk51wSvLUlVrt2qb96d3YlaC4rwai04yEIqlRoTOhrsavbAVxiu9+NnJddgg/wC3SH/HX0bcCqfhcXx4axG7/VB+PURKUGjQa1eNF1e9WQPAX757IdvG5mEFA1CaWcZmJ1jHDMAQMMcqKdKIuTNisH3LKbx2ohnr18rYek+86nZ8OXJZkQHRIf5jxjV1bpzwdckQpUGh04FV1qtKqOLOpEkAgGnGdCR4nwUA9hcAGosLMTwze0i/Jhc1sIwRRrm7rVscRAaxeAgYJEnmAbT1nng8urYuABYUqEgz+wsMzxd48UK2DWWeZpVrAoDtW05hfb0bzg4JaWbgk211uo9lWZGBgXBWAgDXSQAW/DDUi8fEWyXUT1HgAg8qHVn8HS4KMXrhWgBKvP0W6e9wGh6/KF6TIQusCFOcrjVua6mVBLSGLrwMkiS/f0823vlHER5dC7w0PxafbKvTdTi7arxIijRiM2QszTHgsQIXA5XBaGSdM9bXu5FfL6Grq0uKCAuVZyV4dfebFCkhzSxjXowF651uzEpQ7jsvxiLeHKEzgxaAZLsCrvQR7ej+yoAVr96KBO+zcBoex47uUtx1qWPIvx5DbgwrwhQnR5ji5NAwK2xxOewUGmZl1xsjjAxmpoh08P8LDX7d8WYRAxKVCvXgRuNQZR6JJQt55ddLyK+XsKvGC1qsseNUF54vUANLgZWRzc+aPnMYACWoUeaRsL7eLRZ0FDojaNH50QtbseRlO5a8bMeP167FBvkHivu67eLoLzhkYu3kqJZMelC54Ge+uTZ/acDasjy0uMtgsiiTRl21BTjlVebn3DPlGawty0ON80sIpzUEfoFJkhxljsTYyHbsqvGq5lMFG0PS6zkYLA6vd31UVLhs8XYxYD2c5cXKEsVtlXmkHhOLQkK9yZYRKX/rO8CwXyj/d+9UfjDdNW8SphnTMWv+xxfN5OEhAawIU5w8N8OGFNsirC3Lw/znFzBYVbhWAgB2uJW+c9MsSjufT0pcOOVtwDBDNHaVfInrpt4roDUEYKWFTm+wOhuKigqXWzwdrIQIgIGKnJWYPCx0JsCi8xRfvxhhNSSAFWGKk5csf4YB6t2D7zAnFUxaaN3z9hu4e+bVsKfnCGAJnTa0AH+bKAEqoXMFr6te9CoNcNeuxdZf+X8kidZMg8RZ3T3zarz1X+uZm2pxl6GlrVR122EGpUQYGmbFDihAm5sBfFjcgOVLnsDdJV8iPuFqEcIQOi0JMAmdD1h96zvA/8yfzy771neA//wLaKntvCheg0GfEkxZ+jDe2vIlKlwrfWU/BVZa6FCw4lSbMnZlsqRhhzsV8QmpcNUW4K0tX4pvhJCQ0IACFLkmW0akPPNL4C8jlNZMAGCcasBd8+wAHPjPv0IRagmVO92dYgxrILsrGrfinVUwh6RNB1LpcH7abHabN/OfEGVBISGhC6qx86PlSkc7i7VTGZD6CB5bFQlAWS/rziS7qmt7S20nOt2d0lAE2KCOtafYFuHu/5uHaZbyXmEFAN1t3RJd39JWCldtAaZZyhnw8LNoDDNEi5i7kJDQBYEUnUYvbFVdd9c8pcsFwarS0Y5Kh7JO1ntVDtYN40jJrQCAUEuofNNhxXUJYA0U/cy/TERvQQstuOj8JyUuFbRYLF7HlQkJCQmdK1A9uzobWa8qPQO3/soQEKLY0V2K7q8MIOflKmmVtv7KgCJfJwx2LIwLHbKv1eAG1l8a+jz2ZIwwynSiy0LDrAgNs+KTEhcAYO3SNQG3F18nISGhcwmr0Qtb2QKNW66GLqzeWb8XgNKxnRwU4A9bnPqj0gnjZyfXIdkeDlNcKJuvJYA1QFThWgn8RQlRtLjL+uSq7pnyDHNNLW2lMFnSEBpmZVH3tWV5LFFIf4WEhITOle6aNwnvrN/LQKUXTz+2KhLvVTnw7OpsfOs7wJwf+ct9lY52BrI7k+zIerUdyfZwdH819BbjGNTPaIc7lZUF+1IS7G7rlt7MfwKO0gI4Sgtwz5RnMM1SHhC+sMXlKL9afN0whISEhM62bBmRbKxKz1WRXCWtUqWjHVuuBt6rcmDJy3aUngzHnB+FYs6PlPJfpaMdWa+2Y/kjDqxLLkT6CD/EBLAGiMhVpdgWAQBuzhzV65hTd1u3ZE/PwXVT7wV+Fo2UpQ+r4Dc/bbbKrYnEoJCQ0IUWOa8tVyt9A7NebWetmqgpLqDMybq1MptBTABrgKitpVbq7GhSjTvtcKeyZrY9gau7rVuqcX6J5UueQMXzywAAX738H1yy5T7m2EQ5UEhIaKA5MgLRqT8q5T+CFqDM0frWd4CiB8Ox6e3OITmZeNBPHG5xl/k6XCi9Ar89QgIwCv8+KTO3peeSutu6JWOEUf6kROl4ceUj31Kc1dqX0dnRJL4dQkJC59w12TIi5bvmKR0r+InCwWBFqw//51/AkpfVt6EJxcWb/Gu6iXlYA8xltbSVYoc7lYUmdrhT8e+TMr49QsI9U57p0XF1t3VLp7wN+LD4OGqcX6KzowmdHU1sKRIxJ0tISOhca/kjyrhUsj0ctoxIWbvMPa08fNWLXgarb31Hue7UH30/3Gs7sfwRB/7zLyXWnjknCqa4oTcPa9A7LHJKO3A1u+zbIyQ2rmWypOGH4+/Cuwff0XVcdN4YYZSpe7vJkoZplnLscKeixilaNgkJCZ1blzXsFw5kvQqM3unFsVWRqg7tyfZwjF7Yiu6vDAxWS162A1Bi7jRW9Z9/qRd5BMJR6cCQatk0JFYcJmiZItLR2dGEf7utMLmVicCU/DNZ0hjIegMXoAQ55i+NRsXz5aIhrpCQ0DmH1lUvemGcakDW1HZk0XFppxdAIKzeq3Kge6cXlQ6Daqyq0qFE2ktPhjNoFW8aOmNZIUPliRC0AKXBLZX2aLmR+WmzWaAivuxquGoLdEFE21kLYD4W+JzaE+JbJSQkdM6hBShQMl7pn/RLsEq2h2PJy9kMZFt/ZWB9A/ltUQnReKUX6V+1ozJu6DTGDRlKb7q2vHeqrQGmiHQAwPK9r8K2VJlfNc1SjpTnn8HyJU/0CK2K58tZaVFISEjoXEOLgIN/qeMFyfZw1i/wvSoHjq2KREtts26oguA3eqECvuSTkUPGZYUMxTeeB1dLW6kq9cc7LVtcTq9OS7groaEoybcSs3wOV2IWOjNw8Y4JUGLs71U5UPRgOIo3Nfc5AZg+oh3FQ+S1GTTAijDFBU27tLXUSr2Ba5ghGq7aAqwFgKX+2yyZ9CDWluUFhZb4+ggNNQ2PjpGL8x5E5uxXxYsxSKSMR/VNVBIEWofc6zDggUWgWjLpQcUZ/aWBLdboqi1Q3aYncPHQUm0PyljV2qUQ4QqhiwJW+WvvxOhZr0jAq7JwX4NLdybZ8TgKe4VV1qvt6N6pjH9tertzyMzHGtDzsCJMcbItLgdLlj+Du/9vHu6eeTW3srBS0qO+f725MJpzRffDz6Jx90wlCk/dMsS8K6GhLEmS5F//bB5Gz3pFeunxJUFhVZz3oHixBqDeq3IAAEYvbEXmnCiEWkLlUEuoTHO3KGmowMqL7q8MQ66f4IBecZhfVRg/i0bF88sYrPiJwgCYc+rJaQH+8iADl08UfxcrDgsNZWCRa+LP9/V6oQsn3jnRWJZ2+RDjVMV/EKz+8y/opggHswZsSZDcVYpttuKqlqbCVevCKe9xAMCHTiA+4Wo2wVcLpd6gY4vLYZDiF4JEvvhyCA09XT55svzDd2/HpLtnyPuWf6ULsz/8ejEA4KXHlwhYDTBR8q/yauDUd5TOGJindl4Adb5QyoDA0GvNNGAdVoQpTl6y/BncPfNqvPVf67F876s45W1QuR9yS5T2o7+Af2kQvdvz7mr+8wuUfWz5EmuXrkGN80vhsISGHKzs92fjqms/wNbPb8e7P/wAvJMCgIlLrsTq708GAGTOflWMXw1gp0Xnqa8gqfRkOOsjONRANeAdFumtLV+iwrUyAFYEI2OEUSZYEYhctQWs2zo/JqWF1TRLOSqeX4a3/tKAtWV5mGYpx4dO8aUQGkK/SCVJnrjkSlx17QcAAMc3X6uuu2zSJDzwr73Y+vklLDUoYDWwnRaBq9LRjkoHf237kAXV4ACWbzVhpeR3XPcmPLTmZthUgQz2JnPjW7xobAx/acD8tNm+ru9CQkMHVpdNmoSfP/MVc1bA15BlWaLr7PdnY+vn2ew+AlaDC1wXmwZ8t/a+QIQSgNS1nYeV9n9bXA4LbLBt/ywa+Fk0Piw+LsqBQkMKVvb7s/HnJ670wQoMVgAQYo8AABRs+0ZVJhQSEsA6Da0ty0OKbRGmWcp7XU2YFmX8pMSlghX/l4fV/LTZ2OFOZQs40l8hoaEAKwCw35+Ngm3fgA9Z0HUpaSORM+MSdr2AldCg+GwP9Fj7kuXPMKB8UuLSHcviRVAbZogGi8T74EfwSln6sHJj39iVq7ag1+0KCQ0mZ4XvdiKk3ALnJl81oewEu01K2kgkzElFaGUIdn38hYCVkHBYZ02+cawU2yLMzbAhPuHqoAsyktPiF2YkUFGEfYc7lW1zbVkeapxfClgJDR1YPX1Zr7AaMT4dXY42nDxYKmAlJBzW2XZZ5JQoyUfg4RdXDAac3jpXCFAJDSlYAbqwSkkbCQCIiYsFANTX1uHkiW/EZ19IAOtsi59vBeh3udCbdyUkdDGACgB6ghUBi2D19d69wlkJCWCdL3AB6tg6SYxFCV1ssMq94Rq05Tb4L/xnKIMSr8smTWKXCVgJCWCdZ3BpL+MdmOhWIXQxuKqJS64EAHSlugEA9SuaEBMXq4LVZZMmob62jrktASshAawBBDFyYMJpCQ1VUF329GUIKbf0Cisat6ooOyFAJSSANVDBJaAldLGBCoCAldCQV8hQe0L8Yo1CQkMFVABUsKJwhR6seAlYCQmHNYiclnBZQkMNVPuWfxWQ+hOwEhLAGmSA0oKJxrUEsC7cQTeYxME0+OulBRWpy9GGr/fu7RVW4rUVGqoaEiXBvizYKHR+D7oTl1yJrlQ3vn7ya9X53BuuQWdyl+q2KWkjL9pJrFo3xb6Y5RY2TkWuClBSfyQBKyEBrCECLeGuzt8BNyVtJCrKTuCySZMQYo9gB9eQcgtyb7gGbanKPKHcG64BAIRWhjAnQQfjESMvkQFcFODSuqmQcgu64Fa5Kr78x27rgxUfUxegEhLAGmSioIV2fpaA1XlwBr5GqxVPKstVODeVY+KSKxFaGYI2ZzNgj0DE/2fv/GLaOtM0/pwdWMlCJwWTjjVgjKFJ25lhnBIu2JUgisIkI0VqRlEvOhdo0a7TvZmVQrSTXLDdRMmqXGQ3Clm1Vw3VouFichFFzUhIG5YogkqRpSFOHTqTDCkYY6gQ4U/rQdYurs5eHL+fv/P5HP/hjyHkfaQIMOacg3G+33ne7/neL2QGYNZrUgJWh8+0AbOZ41UHX4Mr5IamaXtye3a7kh+J4ESfAwDuluPR+BfCgcotlRhWrFd23NmroQvW9slb7zeqX9+P2NQ0Gt/7CVLhJJYWX2AtkYCvsQGxqWmsrpiuqrLKjdWVZRGzBgDPiTrx+cK9WXhO1JkD9d3yPdWNwc5JWaAEwBVyY70mZVv+U/v/cQmQxQ6LxSpyEKbSX8WiLoIApIpF3fJ8X2MDVseXxaLWQEsLFu7NwtvUYIFX2ew+PBr/QriPl9lp2ab8ZrNBBQDJ1mXz+xKs2VWxWOywWFsEq8j4OA6facPU7T8KKDlFq2l+SxW1DCJgpcJJlDW7xKAeuRR5qQZmJzcli8qhau8/u75/JHZVLBY7LFaR8tb7hbOqXaxHKpwEAKyuLGN1PDMAV1a5BcQAIDY1DTmUQW6BPlaH92Np8YVwE1QSo3mw3ey0HKPo6bm5VN13aPYH8PRWXPzMek3KDFkozrQQV8WwYrHDYofFKnBwppTfs4cRVOhm6Y8G1UBLC2JT0wJiTm5L7XdHP+vy6OZcTjgJnFq3wGs3DdIypLoGOhGORjKgSkPq7AfmY6PDnQJW6zUp4SRzgcrJVTGsWCwGFqtYJyFtU0GBCvnzXIOqnCykY8if0264VDKTAwg7OVirkAKAcDRiKfuRmzpyfBAA8MnFNpH+s4OUHajYVbFYDCzWJkSJQHl9FZX4qPyXD1T5wEXHowGc4vFzsRmxhUapnZYTpGQ3pcIKAJ6MRbMSjxsFFcOKxWJgsTYwcKvOirSyvKRt9LiyQ6NzLC2+AIBM1B2lKw0WAykZVnJXCidQVVa5UaHrJQEV/R50DPVrFutlFYcuWDndFc1NqbAq1lXZDciUOlxafAFvUwNCQw8EuGSRs9uOAIYTpJ6MRc0H65x/liCVCicRuRkpyE2VylFd7QlaXi/1axaLgcXaU5qLzcDb1AAfzLVU8uLfjTorO2i1njwqYCVgEE7CNe9GaOhBVsun7YIUuSkZRqq7kh/fqrIfux8Wq8D/u1wSZOUb1OVBeDs2BKR+hARJOhcAeJsaRMJuMwGMXOU+2zs5m0AFAIT/80+OkLIDldz1o1Sg0jTNmBzpxsGOPnFTIH/N724WOyzWnpO8bopgsl0DHg3yqgtJLiTggo7Q0APYObHNOimSHJog/azdjyPHBzE63JkTVHZlv50AlawDx65rQJ/4/e+MJPgNzWJgsfau1DLWdg2yhmFo3nq/IbsreaGx16Pj8Jk2rCOFWl+941yM6gpzQYoARSJQyfH00WE/brzbgsj4oOW5dgGK3QIq0vP75yyvxekOHRd6c4Od3ReLgcV66UQJvrVEwhKy2E6psCJgqi4rcDkA9NfndVHyRxlOtE5qdDhgfU575jnhaAQDNQAwWBCkqPGv02u0EyA4cOy6NjkCI99GmgT/fM9jsRhYrF0rGny3a97KyWXR1+Suql/fL1xW68mjQAjwNrkFqAhSMnycIGWCqjO9ViobZk/Gopi6/UcLeCqr3PA1NsDl0QU8CwHVbnArclnwzkgiKymoaZpxtSfIb3YWA4v18roree6qFLCSXVZllTtr7oxAIc8hUVskJ0hZ3VSnNDcVtST9noxFkQon87aVkiEFAGuJDLjk9CR9b6cj5P/+L2eM0x2Zzvn0uVoWlJ/DYu368YlTgnsHNFtxd0/lQACo0PWSAgsAqtzVhgoNcnm50n0qrOxaJwEQrZKA/PNN8vnlprRriYTopUgOkD4HILrORy5FdsxpETCf3z9nHOzow+RINwBYkoKq28p3rbyOi8UOi7WlsNqKgaVC17GWSJQcVuRwLL0GLwfSMGrPGUOX033mG3ufBVK4W16wi7Jzfmp6UT6GDCogky4MXtr594ZaFpTfI1QOVAMadiEMea6LocViYLGKvnvONbhsZGCRwxY7Cd7I+HjeGLoAkSR1UW/sdnxDgCpU5Py8TQ2WuS2zQ3snugY2d/NAr4dccozPRIs+Fq3BmhzpxumObnFcu3KgXQhDhtvkSDc7LRYDi1W45AHFbuDYTOqLyoBOx95Odyhv11EIpLK6UaRd1HYnGuUSoedEHTCfuR65Y/vocOemX5fDZ9rw6yvmgumlj4Og+H8hfxuax6LEID1+tSeIC739uDOSwPljGRdGC4ztbowIbgeOXdeu9iSy0ocMMFZJbmp5DuvVcGKFuit5sN+uQcgJUkXdadH+U0UEJjYLKQCWWHtZswvl82Vim3sqBcq68Wmg6N2TqV3Vek1K7FL89vtefOjdjzsjCZzu0AvqWqH+/Qlgd0YSuNDbj66BTvzX3/1WA4DPvtEMOZzyqx++hQu9/RaXdmckgduPv0ZyISHm6Wjvr2ANQ4vFDotVIrBR0KKQfa02C6nDZ9qEO7KDlbwZovyYHJaQHWGFrlua5+ZyprmuSxatuyJ5mxoQn5gW8XYASIYTSJ1aF93aVVipUC402FBZ5TahUOMS6cjQEPDTniDOf3RTe37/nJGvNKdpmkG7IAPmPNXgfz/GV2/9GHgL6J8HgEF89s2g8Q8/MrTR4fSNQ7rZ71f+/7XcTIz+uA9fxTuBx8DZ348L9zg6bDrK/nkOZbAYWKxNqJBJchqwV1eWtxxWdlvIA0AK32U9t9kfyEr24W55FqDsVP36fiQXEpbWTYWAAYBthN5O6zUpeGHOVcnQWur/Fj//t4AFVp9cbMPP2v1p0EYBP3D2gwhuIJAfMunAiQ8NAMz5PHm+8vxHN3Hg2HXt+f1zhlMHdvrdzn4QwaErhwzxmp5aRzgaQf2lJIJpkB45PojPvtGMcDSQlbR8eiuOszcjWPo4iGBNBIbxW03r0ozBP3Uj2NUnSosQYIvwfzrW9t5cc0lw77snuwHcyVlsFlZOkLK9W0o7E6ddeWnwlvffUhf1ksuS4UXHcXJUovXT5QBcIbeAnNqAV+5uQQnAVDgpFjQTuN5+3wvATCo+uvkFAi0tcHl00bTXEqm3ibsLeF4OINYXx+rKMroGOjHQNZj1vMmRbhw4dl2jIMSF3v6s5xw+0yZKlXQj4Aq5xU7OX178Usxx9s9bX5/RYRNiSx+bx6bz0bHlmyC7gIbT+2dM04zP0Yj/ML5mB8Zih8XK7bLyhTC2ClSFQgp3y/FoPPd2IfJuxHYlO4IXAYsSe7W+enibGizwpONQObL6bgvKZl2IT0yLbha0nkqGIx27fL4M6zUpuDw6vB5dQMrcO8vaTV5W+XwZUuFy4NQ6AMAVciNwOWAFe3r7FMxmfu5D734MODrm6wCA8x/d1C709hvq32Dh3iw8J+rgCrnxNBQHFsoRX5xGdetrpovSNOOf0Yg/4wcAJgWont6KIzQ0iA9HunGwV+70DuPAsesavUecPjrpN9obxjUABsOKxcBiFQItJ1e13aCSAQUgL6TspIZBVMkx/NDQA+GUyGmEhh6Yab57pkMqwz6Ue8qQDCdQ/fp+rCUSljZLtb56S8sll0dHfGIaXpjzWJ4TdVlQik9Mm62jAMQnpoHFF8BExvXhbjnKPWnohdzi2uIT5uaYh5vbkAonsbK8pGmaZtwZSdiWdO0cjfw3KJvdZx733rRlUTPBEn7gUPpv1ewPYHS4FcGuQVz0jYkbAznQoUKSdEp703gT3+OXmEI7uSgA7Q7vJyMNLnZYLC4Jsnas1Gjbyy8NJ7mcZ1fKy9eDT16H5NSzj3YnlgdmSvIRaMhZkfuYi81YounyHBnN5dHnrSePItm6jFhfHL5uryW2fuNTc+Bf6v9W/DwdW74OujZvU4N4Hq3bKmt2WcqhhWxrr67Do9KpHJIQ4JqYtlyXXMpMti7j+KW/4BqmxLHfxUHzT2j82REsBKvf+b43bwxifw2CFxRo/UZ7w/id73vEZ6LamKYZ7RzKYDGwWKWGVf+8WUYKRyMitq26IlUqcAoJgxCwaNCVH/OcqDPnahZMh0SbPcqP2UGESo30vVwOLtNpA1kpwIt/Y+0hqG4+ScCi8xEs5OulEMd6TcpSUiw0NNJ68ijeft8reiJS6ZFuGgiYdG00vwYAPxyaw+8xiXdx0AIcALCbbzqlvWkAwJv4Hv1Vq1m7Tnvr/cavYj8Qx/kcjbbPY7G4JMgqOawGugazBtcqd7XhBKli1iGpIJC7PZDrEXM+p9ZRjdeQxLIlZaj+nOym5DJirnJjZm8s6yLg0eFOrCWGAFhDH9QppELXLWCk8tzc+DgCLS0CVtSJPhVOit8rcimCfHOOgcvm+i6CVfl8GRYWX8AbahCuUoYnfVxafAGkQyOPfP+Hd2Omo7qGKXh6ghjrHcVdTKIdUyIoYc51ZXQNUzCWs/+W8ZmoVuWuNq6t0CP2z2Ox2GGxSloKtAOQvJ6LSmvF3l2rx7BzbL/sOymSbxR+ACAGblq7pDqnQvf2kp9HcFbd1ehwJz7vHnK8TrUnogBNOkZPECPHBWQWIlO5LnIpAlpA/OjmFwJSqquiY9BHOqcKaxmSquhaQkMPMDnSjW86+nAkfb1f/uEPGpX21hIJdkysHdNf8UvAKkaGYWj0z+77qyvLYi3XRmBV66sXjkWNs1foOhrf+4lYr/X2+14LSOQQQ76ghqpaXz0qq9zi5yh8IRbUKnp6K44KXXeEql0kv7LKjcj4OOZiM8Jx0RyTy6Nj4d4skgsJrNekUDa7T8AqVfedCHTQXBzBeWnxhYAV/e40r+dtahBlybnYjHncZpdo5ksujJ4Tn5hGra8endce45/Sx7h9tV24KhlWvOEjayfEJUHWlsJsM65NdQSq5mIz+Hl7OpPmh6VUF45GsDTxLeZiM2g9eRTPHkYsMJqLzVj6JKpui0qEMoC8TQ0IRyPpOayIxV2FhqzlUE3TDIIcld4IHBWLelaJTnSjb2lBbGoaPjSIUAYl/MppgfLdcsBjDVJUL+w3S4DpDhzV0utE0Hr2MGL5fSgxqQZb5LnByio3nj2MoELXBbzif+83qDUTABy6csiYHOnGoSuHjJ3cQoX1ClZ4uCTI2tE3YLpvXnIhIeaX5HVVJOrKQMk86mGnBj9osa+6dktdzyU7H9pOhQZ32v24OviaJRVI5/uffx2z7ZpO4FXLggQwmttyujYKRDx7GMlaFyaXD+l18jU2ZAVI6Px2HUuK7S0p/y60gLrzF+/g9uOvhSPbiS1oWOywWKwdE83hyOEFO5luyup4CFY06FM5TwXTWiJhcXDqhozyAC8HS9S5q6e34o5bfNitd6OyYIWuZ0GIkoPktgg+FboOl0dHdfr65PmlQEsL3vrbgCj/yb+P7BKduvhv1C2TE+tVlgAwrFjssFivlMOiwZsciF15DsgsTqZ2Q/m6oMvgUJ0CAcJugNY0zaD1ZVR2pPMV41Ds4vgEL3VdmQxTec2UPCdF12vXqkpeq8YQYbHDYrG2QXKnhlx7camT/M3+ACJ5mq3aLUJeXVkuaL8v2mbDbAq78d+r1ldvKdmpDlAGkOy2KBRR66vPAhX9vAyuUu5hxmIxsFivtOQ0W65B17KIdyCzFqwQgBQLGyoLbgbGdrBVH6cEZGxq2tJwl8qVTpJTigwq1qsgjrWzdoXLUtcr2ckVclvmlJz2n9oqyXNYZz+IoGugc0NxbnkpgNoXkP7J7msuNmMJadgBSoY7w4rFDovF2gHV+upt02zkev6xhBD11vuNI8dhAeTANp5P/lp2Xyqg+F3CYofFYr0ETixYA0u8faOupxDFZ6IlPV8uV8ZOisViYLF2EYzsWgY5QavZH8CNTwPbXhYs9flYLBYDi/USaC1h7k9FZcFcEKGwxehwJ/rnt7dVUKnPx2Kx7MVzWKxdpdjUNHyNDba7DKsQ8db7jScnogA60TWQew+prYBWKc/HYrEYWKxdKLFjbrqvnsujo/XkUcc4OCk+E9U0TTNSdd+hbHaf6Kyez51t9DqLPR+DjMViYLH2GKzUXoLvvfOG5aP8XDsINPsDeDIbxScX2/DrK4M4Mg8sfRzE+Y9uas/vnzMOdvRhcqQ75zGKUaHn24pzsVgsaQzg1kysnYTV1Z4gAOBCbz/IZXX+4h3xGH2fdKG3P6uDhWEYGnUOBzKNcgETJKc7dBw4dl3LB75Cr7mY8zG0WCx2WKw9JIIQldZkUBHIAOBqTxBXe4ICApqmGeRkAGsHiXB6a/ufAjjY0QegzwCAyZFuca6NguT5/XOWbTWczrcV52KxWOywWLvEYcmgkR8jOS2olQGX63n5jrEV15zrfBzMYLEYWCwWi8V6xcTrsFgsFovFwGKxWCwWi4HFYrFYLAYWi8VisVgMLBaLxWKxGFgsFovF2qv6/wEAul41taeZgp4AAAAASUVORK5CYII=';
var BOSS_DRAGON={forest:[112,110,172,103],cave:[319,70,80,66]};
function drawBossSprite(zone,cx,cy,hgt){ var d=BOSS_DRAGON[zone]||BOSS_DRAGON.forest; var dh=hgt, dw=dh*(d[2]/d[3]);
  ctx.imageSmoothingEnabled=false; ctx.drawImage(DRAGON_SHEET,d[0],d[1],d[2],d[3],Math.round(cx-dw/2),Math.round(cy-dh/2),dw,dh); }
var BOSS_SHEET=new Image(); var bossMonReady=false; BOSS_SHEET.onload=function(){bossMonReady=true;};
BOSS_SHEET.src='data:image/png;base64,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';
var BOSS_MON={forest:[2,1,24,29],cave:[32,1,26,29],dungeon:[62,1,20,30]};
function drawBossMon(zone,cx,cy,hgt){ var d=BOSS_MON[zone]; if(!d) return; var dh=hgt, dw=dh*(d[2]/d[3]);
  ctx.imageSmoothingEnabled=false; ctx.drawImage(BOSS_SHEET,d[0],d[1],d[2],d[3],Math.round(cx-dw/2),Math.round(cy-dh/2),dw,dh); }
var MOB2_SHEET=new Image(); var mob2Ready=false; MOB2_SHEET.onload=function(){mob2Ready=true;};
MOB2_SHEET.src='data:image/png;base64,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';
var MOB2={mushroom:[8,1,19,18],imp:[44,1,20,30],goblin:[82,1,16,23],slime:[118,1,16,10],skeleton:[152,1,20,24],turtle:[184,1,28,34]};
function drawMob2(shape,cx,cy,size){ var d=MOB2[shape]; if(!d)return false; var dh=size, dw=dh*(d[2]/d[3]);
  ctx.imageSmoothingEnabled=false; ctx.drawImage(MOB2_SHEET,d[0],d[1],d[2],d[3],Math.round(cx-dw/2),Math.round(cy-dh/2),dw,dh); return true; }
var MOB3_SHEET=new Image(); var mob3Ready=false; MOB3_SHEET.onload=function(){mob3Ready=true;};
MOB3_SHEET.src='data:image/png;base64,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';
var MOB3={spider:[11,15,30,24],bat:[60,10,35,34],shade:[114,11,32,31],beetle:[165,16,34,22],wraith:[219,10,30,34],wolf:[264,1,43,70]};
function drawMob3(shape,cx,cy,size){ var d=MOB3[shape]; if(!d)return false; var dh=size, dw=dh*(d[2]/d[3]);
  ctx.imageSmoothingEnabled=false; ctx.drawImage(MOB3_SHEET,d[0],d[1],d[2],d[3],Math.round(cx-dw/2),Math.round(cy-dh/2),dw,dh); return true; }
function mkAnim(b64){ var o={img:new Image(),ready:false}; o.img.onload=function(){o.ready=true;}; o.img.src='data:image/png;base64,'+b64; return o; }
var MOBANIM={ bat:{s:mkAnim('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'),cols:7}, slime:{s:mkAnim('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'),cols:8}, ghost:{s:mkAnim('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'),cols:6}, flower:{s:mkAnim('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'),cols:6} , snake:{s:mkAnim('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'),cols:7}, eyeball:{s:mkAnim('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'),cols:7}, worm:{s:mkAnim('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'),cols:6} , pumpking:{s:mkAnim('iVBORw0KGgoAAAANSUhEUgAAAYAAAAEACAMAAACNqVFVAAAAwFBMVEUAAABAAABKKRj2pBDNUhCEQSKkICmUgyBgEAjeg3OuQkrkPDzevVr/p0n/VEJsNTYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADFlywzAAAAMHRSTlMA////////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsqWH7AAATNElEQVR42u1di2LjKAwMNk4TqN3//9tFEuBHHBukNJQsumu33VZmNCPATrfD5dKiRQVhM79/GhtnwjBLzm0un7YpIBZgNPwJsJXMNj4ZM0DWw8T5hJeamgCsKWDFDWynzZX+Nw6NcBcwj9tB3l5s//MJIFMg5Ns8AhffbeiO6D8WwLJkMKv83A7e6DX91wJMhjMN4g0Q5Y+ZF9gIIOJfqboFcPgZK3ik3LoP3ASQLWQi/q9XmQJlBTSAn7EFGjP6Fcjhn0ZTrACHX6ZAQQFh4SH8HP7MBdqeBJQIIGxAqQBFBXQMSsa3MV+wAskbUMxfOQHdQo4dzKXPTsYLUAJ/mDrbP2sREDff0U7K9y8DvxmnSYknABf/tcc8dbvRn33mdQoLiPidAoDfcPFbUEDRTSQPv2U3YEjc/lmLgIjXGCvCb0YU0PLxwwxkNqBSwJy63u8wsvtE1SagSzRC/GYMewgTv2Xjh0s40Le7C/jzWpmAfwS/5eN3Y16vtysUcIWP1KUqAevHDzm32xXDTSNGAWUJqB8/xA1KcO/wk7oIqB2/K0D3WvnAD+sioHb8AEBr3WO4D1R+AWUJqBk/fa+iEjBCfsZVChJQN36FKOntFi5wm//uos7y/ftHAtTiG36NgOrxK/WFb/gMhHsI7CJ4S/Xlv3jefv7dmoDFl1Ln8LaDPx+/S/v6gv/pITTs4vQ45790eCmo8KJC/ooA/Gvi5gx4vJNeEbD42ufi//Ipe5uI/9IhAikB2MJf4VWINQF4gXP+asZ/Ud9wge8vnD6wc9wQvvtQxy98q8Od/5SAozZA9EcEnDBQO34qAGDqvut1pwcYbXAfwKdQwWEBLv3bV7lLAFHw/a1O7t5OCPhk/CARiOQAu0GhBhfxE5yDR3PYAfQVPCMA8H8dNZAb44gAQvCp+LGBvvG+FSEPvR66btD9ECpQ9B0HCtIse05AWCH38X/7Cp8S8I1v6kPxx20GhoP8vh9c+A/d22KLOujABQE9ENAvCTjoQOWXjxMCvp9P49rxUwuF9HUB4RKHmxiKf0wAtcGvEPAB+P0c9ON38BA3DPA41y1b6OgOLIWA5/diKo0A9bn4EcUA37tTgLvqcHYfviJAh3y9IuBwDZ0n8D4BeBeiPhc/XAZ2jJ5mkB8a51CPG0nCEzibgHCfdkTA6Z1c9fh9ASRgKAAlTCrgovgE+JvlMwKSBKgX/4Vum9wNnI7auWoGTbdVCS8nsQlQqR2sPhn/XMA8eeiT1ALYBKhUAtQn43cAYGwNTzCaLqDheQb+asgq4O0EfAb+i+qwAlfAEAoYsAD4+xoIqBz/ugB8kMgsoDQBleNHBC65QwT4WgqM34GKXQ0CVo/fXQGStwXguxoErB6/r6BDBIN/R3+RkV6OgPrxE4Su86MS/i4Zf3EC6scPz3ShAg8FkjP+UU1RAj4APz1Wd4vI/IdJZQn4BPwrFB3j93OKEvAZ+Jc/YmZFQQI+BL84ChLQ8JcnoOFv0aJFixYtWrRo0aJFixYtWrRo0aJFixYtWrRo0aJFi+Oo/eeZ1ePvqz4+QI6/OP+9rILCAorxixtIenyAsIDSAhZvIHkDliWgdgFF+dF7UDKVChLwCvwlBXC56H1Mnq/0WU0CivGXXoKkBZQWsHgDiRtQqdtF3e9UQb779x8QsG786P59xwK47t9FCZDi/wMCOOz3O1rPXe9M+/aCAsrxS8cX5rtkdQXnELSe47h/lxZQil86vrgBCT4YHfSK1YFFBXwBfmEDiWcgmC36Alju4WUFlOJ/QQMJ8yE32q9rjn9+UQHl+KXjCxvwohzmK61hYD2a779fVkA5fmkDCfHDJe60icBGnuy/f0BApv++TEApfnkDSfHjEUyhgHT//ecE5Prv73TwO/HvjJ/XQbszMOskk/s1+t+n27c/JyDRf/+5gJkFiPE/jJ97gsND/ldG/2KxaLwCJivJ/vu/KWBeAXL8O+PndNBOA57b1y+XMAd8QPNFsF4chgT//TQCUtt4V8DUAuT4H8fP7KBH/DnF9+izpcl1Vwcn8DP//RMCEvz3UwR8B/698fM6aBf/mX39Aj86zSF4sqGGK536758TcOy/fy5gWgFi/M/GT+6g/fxT+/otfjB/HfANLLjQDf87pYUOCDhyz04QMKkAMf5n4yd30G7+kGBfH+6g6BCyWAAxOOgz//0EApI68FDA7wTzZRn+Z+Mnd9B+fnL9io6+ApOPro9XIAa/kibAAQGH/vuvEVCO/8n4yQD282P9KQ0MBWhXQSgAr+Jb6CIU8EvSwQkFSPE/HT+1g57k+zmcYl/fUwn0ahKYUMNkGnwPJm3hRwSIZuB5Abn47bg//s/PdvzEDvL5sO+u8wedZl/f+xMQUUAqgM7gcBMpzX38FwVMOD9giV8n4Ld2d/wf/bMZ/1kH2fUVfP4A1a7zdZp9fSgAU+MiRnbUaXcwvyvgfgFmzv8Jr8N3WqXhdxRaY07Hf9ZB07jQ4Ah/mns6dN6qAJxDOluA3xNwVwATb8Hd4oEvAP/AaRZp+I11JBq8RvYMgrGncbRnM3BIFQBWXyygoxe1FwWkHYDw6wKqfQ4tauD4/1H4Dt6S8ROJ7hIK2jxzBl3MNAUFWPkrAtBlDt7BGy1guAOmClBKQENNDLzHyMEPJI64FhnCP6TPILcMTbH+gZO/FmC2WyQLfE3exzrNPbyYgIHAhQBZ+EGB0V/D3cQM7o3RQJMs/6K64LcIFFABZACbat9eRkDXuJ7AcZxcWDsLkILf4CIU011+IDCngSbAIMgnBjQRoDulVwV0f1dAt4sG+hwBuI4Y2IZT8cMuPNNP+UBg0vguwd9NTXSBzPzHBwmFt9wazsPqh2iBnHz+wPsFNBjWQgNOUD2u/zh+En7KxvwJ8weKxPHtZOYZwMjfUjD40+j9axpkv55u319AQBNZpI14Hj8Dv/GrWKAPttHsBgIZrSDfK9DpcC8YCsixby8noAH+8/HHxyjYBkyHLyQMOTPooYEE+eFOBDIA/+D9v3N+Hl5KQOI/F79xpC/uZN34vBk045flh5+odfHwAZZ9ewEBjV08Dyfjh1Vr8ywnayBx/oJFoX37mwU0LPwmqhZXoqzx51chXtWAqx8sF/Xf5woox58+/jjZ38Ivjrr8983ImkG7/JfA/+cEFPL/gvHb+QF5/JvGQsVhbeOg8d+iRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0qDLaAQKF8V8rP0CgevxS+/KyBNSOX1xAaQJqx//fE1AQf5g62z9rIaB6/N5tOppF5bpPFyagdvxzAf4CuQWUJqB2/Gj+rch47spx//4DBNSNn9y/1e16vV55/vtlCagfvxvzjs7r4Pl3vfPs38sRUD/+C1p+S9y/yxJQP34P3zuvcDqwKAG141+4fzsIPcc9vCwBteNfu3/jVeoioGb83mla4+S50iEosvMD3ktA3fjVZfbaB/hgP53jvx8dlR4J4J8fkEFA9fiVt9mHReyK/t/xKKYk//3lSQFrAhjnB2w7+PPxXxbesor28Dz7eXR2Vj5/TUCi+7uaT//bEJByfkD1+L/CL1Yq7/6t8/z3pQSQxbh/it8QkHB+QO34L+Bt7W32te47Ms3QQ0fH0Jz57y/t3Z8TcNQGauHOvEvACQO146cCAKZDj2Zn3oARPz3331fobv7lD655ICDB/T2FgE/Gj87UTiQ3uEa30eCAiRbsp/773l/+gIBj93ca/YiA4/MDasd/IXd9RfjR7Hjpw453s8f++2GWPSfgyD1bYXXfRwQcnx9QO/64zfToNEQyknjgAAsnwh3771N/HRJw0IHKLx8nBBycH1A7fmohn0725bORub/E4SaG4h8TcOj+LiPgA/D7OQjf7N3LfQFoZB5a6OgOLIWA5/diKo0A9R784IA8O9m/Bz+iGFA/v5H0/groQNqf2c+rFAIO19A4gZ8IeHZ+wOvwo329FwCd7HPxg23ifJRAIn58hu7BrLCLS1g0MocrJLwWwCYgvnRyIGDC+QF/BD+eH+AFwKMEEvHDjy87v3XP1oX4SZf0g00+Af5m+YyA8wMcqsYfC9DLAnRGAWwCVCoBCQIED/a+n33Y68DvL7BfgM4oIF9AlUpAwhKE5zf43tP+KIcc/BwBX4MfbFNptermAjpa2RL9/0sJuMLvj3EAF2k6ziETP/gOx/qHtwg4F+CenaOJfDSThyfrIZ2AcgISfjo/wIyTCScJ5OEn72c0QScj4ncJSAXolYl8R1bayQWUFZDwBwFGa/xZGnn40X7bWPBi9z7oHAEHPMkhS0A0z+70bCIfjOR16gkchQX0+KMAE52okYufBIDDAEZUgCXgYKbZyD4VP0o46GAijwSAD/hQiYCEX9HKb+FEEjrKIRM/sgbp4KdOAuQL6ASwwQs/GT9cwl2hCybycCoQQOqG5PSiAnr8OL5bQkYwRNeoXw5+hQsHCuAuAAs6R8DBLgXQOuP8AHCeDi7yGjR1/6WnFxUw4lcDCgDu6Pn4YXxDArhFiCmgE2Aylo5yyMC/cP9eOPjn2c8XFHCB34y4B7g1hINf2ZHyJ8sTUA2wiVtqoBz8l+j+rdEAn28/X0TAGb/FBagzloUf7oFgC3EfWJaAg4Yjleyg8vEHFHT4AN9+voyA4SIGF3C3fuTbQgN+g8uPywcFDQ8/nCnExH95if18GQF92EmBJzcXvxOgMyigu0Kmt3fADwJUfX4AV0ASwFzMxPZEN3YyTgRLo++426fgdwL8v+cHQM9KBBhX+WbMbwCHffp/zw+gNcOyBaDT2eb87Au5Pdy9W3z+H8vAEsAK88d4wurygk2BjB2EGp85iXACrCZOO2Mgj8CZSZYCfgmbGpPiGDlzwMs2tbaXTgDOLWicAJepLT7crn/cDrgCbq7WIps/uZxtJSo9odpe3KJFixYtWrRo0aJFixYtWiRFO0CgMP5rX7sBv6qc/75X9Qooxi9uoBccINCregUs3kDyBixLQO0CCvJnly3RRCpGwGvwlxPAu02D75bieU+XFVCMv/QSJC2gtIDFG0ief4vWj+pyezsB4vzK8Qf3b3L+49u3FyNAjL+8ALfr/Yq+f+C7eK9NQCl+cQNJ8a/cv6/qXpuAcvzS8aX5AL/3fitQgqpLwBfgFzaQNB/dbnwBXPv2ggJK8b+ggYT5SnuvS759e0kB5fil4/Pzl/77uIZdM9y//4CAL8IvbSBm/sZ/3xtQpw+/8d9/u4BS/K9rICb+pf/+XMBVZbXf7L/PJoApoBT/7GjFbaDwS4XM/H379vRNfOW/zxFw47+fK6AY/3xIA3MFmO3rWfgf/fc77/79HgJW/vv5AkrxL/qHN/7avp4xA2f/fYfd/Y8GyPCr9imL2K7/fh4B+/77yQLK8K/6hzuD4m828/KD/z7abqHjMdzJgmVAyqsZS/99FgEXqYAS/KsDGljjz/b1ghmIHQB5jjcqILpQn9vORv99poAL/32OgEL8y/7hrQDRvp47A73/vsPfaaihx7cuQwFaQZgEzAVwZ6AI/9w/7Bnk7esHHv7ovw8GMchfKICsd0/vpYJ9O4+AZQHcGSjFP/PHGz/Uz8sP/vvIX8zvu4WR+dkUJgRlBJTjX/DHGl/N9fPw+x5A/vouFBCMzM+uEP33uQQsC2AJKMQ/9w9v/GBfD/Uz8ZN9O+bDuRvuIvRaUjCx1SnnqHEJWBXAElCEf9U/m/HjWQ6bnPWv/4Z7KDoyY5kfjxJIew1AE3eDL2BpBK5+U8BFASwB9/HrdPyxfzbj01kOj+kb+5NgX6+3+XSUwDbfPnFPgQIGXwC84WWSBZAIuCqANQP38AcXajwJI+abw/45G98Yu0Ofmus/xe/Sn/3qMBWgh0DiooCOQ0C6gOoFM3AHv0L3ejCx/4k34wceNqczyBiylD7AP5zNQIt2mE8ADIsC6KXszltoJ5mf8QVUr5mBW/xgHP0TTOyRfXvk/XAwg9zjFCQfkHee7/mfnlupYQG0D2InoHN2tNBmEPA2AZ/g/1mEovY1eTNoIPwGV57xiLzj/CHWPx04F7gywfES72RxD1lZaDMIeLeAW/wz/YHAvPHB+Bl86DEXvYzZ+VPSXQRajsKdQBBgYSPPIeDdAm7xg4m6ncCDdfQEmiMbs4fxwQIa8+MF+PnTNCVVsCwAXZCDhXYFAm7xwxZscPUIBAIPz3eBh/HBhZ7yowQjM59S/T7wVItYAN0P9x2dBYcnclwuf17ALX4cH9cf4yRwJLotGCN1fH8CA+ZPmE9XYOaH+7ADByGsoFu4NwcP7cQXtcsK+IA/jo8bcOTOpM4gMqJHCv36ZbJmYMy31iY6V/qOwwJ0PBI03b69rIAH+EEBw5lBeCKM7vBElP3H4KT8LP99qACPhGbYzxcV8Ah/ugI7MwgUnO9hnRgmOz89lIosMu3nywl4iN9JYCTjz09xsJ79Gv4FixL7+UICnuA3svHj2nOwESfhd48V6T/jZ0RBAeX4peMn5bu7ssuvRkEBX4L+2QxK83FNwP/XfY2F5wf82vipTrql8X9sGDOaxkLVYZuRblOgRYsWLVq0aNGiZPwDawRTmkfdD3MAAAAASUVORK5CYII='),cols:6} };
var MOBSIZE={wolf:1.85,spider:0.9,goblin:1.05,mushroom:0.95,slime:1.0,bat:0.95,beetle:0.95,wraith:1.1,ghost:1.1,skeleton:1.05,imp:0.95,turtle:1.2,shade:1.1,snake:1.05,eyeball:0.9,worm:1.15};
function drawMobAnim(key,cx,cy,size,dir,moving){ var a=MOBANIM[key]; if(!a||!a.s.ready)return false;
  var row=(key==='flower'||key==='pumpking')?2:(dir%4); var col=Math.floor(performance.now()/150)%a.cols;
  ctx.imageSmoothingEnabled=false; ctx.drawImage(a.s.img,col*64,row*64,64,64,Math.round(cx-size/2),Math.round(cy-size*0.86),size,size); return true; }
var CHAR_GRID=['....ooo......','...ohhho.....','..ohhhhho....','.ohhhhhhho...','.ohsesseho...','..osssso.....',
  '...ooo.......','..obBBBbo....','.oaBBBBBao...','.oaBBBBBao...','.oaBBBBBao...','..obBBBbo....','...obbbo.....','..oll..llo...','..oll..llo...',
  '..llll.llll..','..llll.llll..'];
function drawPixelGrid(grid,colorMap,px,py,ps){
  var w=grid[0].length, h=grid.length, sx=px-(w*ps)/2, sy=py-(h*ps)/2;
  for(var r=0;r<h;r++){ for(var c=0;c<w;c++){ var ch=grid[r][c]; if(ch==='.'||!colorMap[ch])continue;
    ctx.fillStyle=colorMap[ch]; ctx.fillRect(Math.round(sx+c*ps),Math.round(sy+r*ps),Math.ceil(ps),Math.ceil(ps)); } }
}
function drawPixelChar(px,py,hue,cls,fx,fy,moving,mvx,mvy,isSelf){
  var PS=3.9;
  var bobT=performance.now()/(moving?140:520)+px*0.3;
  var bobY=Math.abs(Math.sin(bobT))*(moving?2.2:0.8);
  var mvL=(mvx!==undefined&&(Math.abs(mvx)>0.1||Math.abs(mvy)>0.1));
  var dfx=(moving&&mvL)?mvx:fx, dfy=(moving&&mvL)?mvy:fy;
  if(dfx===0&&dfy===0)dfy=1;
  var row=(Math.abs(dfx)>=Math.abs(dfy))?(dfx>=0?3:1):(dfy>=0?2:0);
  var col=moving?(1+Math.floor(performance.now()/90)%8):0;
  if(isSelf && PD.ready){
    ctx.imageSmoothingEnabled=false; var SZp=54, tx=Math.round(px-SZp/2), ty=Math.round(py-40-bobY);
    var eq=(typeof myEquip!=='undefined')?myEquip:null;
    ctx.drawImage(PD.base,col*64,row*64,64,64,tx,ty,SZp,SZp);
    if(eq&&eq.arm) drawArmorLayer(PD.mail,col,row,rarityFX(eq.arm),tx,ty,SZp);
    ctx.drawImage(PD.tab,col*64,row*64,64,64,tx,ty,SZp,SZp);
    if(eq&&eq.hlm){ var _ht=eq.hlm.tier||1; var _hImg=(_ht>=3?PD.helm3:(_ht>=2?PD.helm2:PD.helm1)); drawArmorLayer(_hImg,col,row,rarityFX(eq.hlm),tx,ty,SZp); }
    return;
  }
  var lpc=CLASS_LPC[cls];
  if(lpc&&lpc.ready){
    ctx.imageSmoothingEnabled=false; var SZ=54;
    ctx.drawImage(lpc.img,col*64,row*64,64,64,Math.round(px-SZ/2),Math.round(py-40-bobY),SZ,SZ);
    return;
  }
  var flip=(fx<-0.15)?-1:1;
  var useSprite=spriteReady && CLASS_SPRITE[cls]!==undefined;
  ctx.save(); ctx.translate(px,0); ctx.scale(flip,1); ctx.translate(-px,0);
  if(useSprite){ drawSprite(CLASS_SPRITE[cls],px,py-6-bobY,44,44); }
  else {
    var bodyCol='hsl('+hue+',55%,45%)', hiCol='hsl('+hue+',60%,58%)', armCol='hsl('+hue+',50%,32%)';
    var colors={'o':'#150e07','h':'#3a2a1a','s':'#e0b088','e':'#150e07','b':bodyCol,'B':hiCol,'a':armCol,'l':'#231810'};
    drawPixelGrid(CHAR_GRID,colors,px,py-6-bobY,PS);
  }
  ctx.restore();
  var ang=Math.atan2(fy,fx), perpX=-fy, perpY=fx;
  var holdX=px+perpX*10+fx*3, holdY=py+perpY*10+fy*3-4;
  if(useSprite){ /* sprite thật đã có vũ khí trong ảnh, không vẽ chồng */ }
  else if(cls==='war'){
    ctx.save();ctx.translate(holdX,holdY);ctx.rotate(ang);
    ctx.fillStyle='#6a4a2a';ctx.fillRect(-7,-2.5,7,5);
    ctx.fillStyle='#8a8a98';ctx.fillRect(0,-6,4,12);
    ctx.fillStyle='#d8d8e0';ctx.fillRect(3,-2.5,19,5);
    ctx.restore();
  } else if(cls==='mage'){
    ctx.save();ctx.translate(holdX,holdY);ctx.rotate(ang);
    ctx.fillStyle='#7a5a2a';ctx.fillRect(-3,-2,24,4);
    ctx.fillStyle='#c9a8ff';ctx.fillRect(19,-4,8,8);
    ctx.restore();
  } else if(cls==='arc'){
    ctx.save();ctx.translate(holdX,holdY);ctx.rotate(ang+1.5708);
    ctx.fillStyle='#7a5a2a';ctx.fillRect(-2,-11,4,22);
    ctx.strokeStyle='#c9b090';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,-11);ctx.lineTo(6,0);ctx.lineTo(0,11);ctx.stroke();
    ctx.restore();
  } else if(cls==='cmd'){ ctx.fillStyle='#d9a04a'; ctx.fillRect(Math.round(px-19),Math.round(py-11),7,7); ctx.fillRect(Math.round(px+12),Math.round(py-11),7,7);
    ctx.fillStyle='#e0b062'; ctx.fillRect(Math.round(px-2.5),Math.round(py-36),4,13); ctx.fillRect(Math.round(px+1.5),Math.round(py-33),10,8);
    ctx.save();ctx.translate(holdX,holdY);ctx.rotate(ang);
    ctx.fillStyle='#5a4a2a';ctx.fillRect(-6,-3,6,6);
    ctx.fillStyle='#9a9a8a';
    for(var cLink=0;cLink<5;cLink++){ ctx.fillRect(2+cLink*4,-2,3,4); }
    ctx.restore();
  }
}
var scr={w:0,h:0,scale:1,ox:0,oy:0,dpr:1};
var TREE_GRID=['..ggg..','.ggggg.','ggggggg','.ggggg.','...t...','...t...','...t...'];
var ROCK_GRID=['..rrr..','.rrrrr.','rrrrrrr','rrrrrrr','.rrrrr.'];
var POND_GRID=['.oooo..','oooooo.','ooooooo','.ooooo.','..ooo..'];
var HUT_GRID=['..ooo..','.ooooo.','ooooooo','o.....o','o.o.o.o','ooooooo'];
var SPIKE_GRID=['...o...','..ooo..','.ooooo.','ooooooo','.ooooo.'];
var CLUSTER_GRID=['o.o.o.o','ooooooo','.ooooo.'];
var PILLAR_GRID=['.ooooo.','.ooooo.','.ooooo.','ooooooo','.ooooo.','.ooooo.'];
var RUBBLE_GRID=['o.o.o.o','.ooooo.','oo.o.oo'];
var BUSH_GRID=['.ggg.','ggggg','ggGgg','.g.g.'];
var STUMP_GRID=['.ttt.','tTTTt','tTtTt','tTTTt'];
var MUSH_GRID=['.mm..','mmmm.','.ss..','.ss..','..mm.','.mmmm','..ss.'];
var LAMP_GRID=['.fff.','fFFFf','.fff.','..p..','..p..','.ppp.'];
var FENCE_GRID=['w.w.w.w','wwwwwww','w.w.w.w'];
var FOUNT_GRID=['.sssss.','soooooS','sooOoos','sooooos','SoooooS','.sssss.'];
var SIGN_GRID=['ppppp','ppppp','..w..','..w..'];
var DECOR_TYPES={
  tree:{grid:TREE_GRID,col:{'g':'#2a4a1e','t':'#4a3018'}},
  rock:{grid:ROCK_GRID,col:{'r':'#4a4842'}},
  pond:{grid:POND_GRID,col:{'o':'#1a4a5a'}},
  hut:{grid:HUT_GRID,col:{'o':'#3a2818'}},
  icespike:{grid:SPIKE_GRID,col:{'o':'#a8d8e8'}},
  frock:{grid:ROCK_GRID,col:{'r':'#6a828a'}},
  icecluster:{grid:CLUSTER_GRID,col:{'o':'#d8f0f8'}},
  fpond:{grid:POND_GRID,col:{'o':'#3a7a8a'}},
  pillar:{grid:PILLAR_GRID,col:{'o':'#4a4438'}},
  rubble:{grid:RUBBLE_GRID,col:{'o':'#38322a'}},
  drock:{grid:ROCK_GRID,col:{'r':'#3a2838'}},
  bones:{grid:CLUSTER_GRID,col:{'o':'#c9b896'}},
  bush:{grid:BUSH_GRID,col:{'g':'#2f5220','G':'#3f6a2a'}},
  bushF:{grid:BUSH_GRID,col:{'g':'#1e3a16','G':'#2a4a1e'}},
  stump:{grid:STUMP_GRID,col:{'t':'#3a2818','T':'#5a4028'}},
  mushroom:{grid:MUSH_GRID,col:{'m':'#a83828','s':'#e8dcc0'}},
  mushroomB:{grid:MUSH_GRID,col:{'m':'#6a3a8a','s':'#d8c8e8'}},
  lamp:{grid:LAMP_GRID,col:{'f':'#ffcf6b','F':'#fff0b0','p':'#3a2a1a'}},
  fence:{grid:FENCE_GRID,col:{'w':'#6a4a2a'}},
  fountain:{grid:FOUNT_GRID,col:{'s':'#6a6a72','S':'#82828c','o':'#2a6a8a','O':'#4a9ac0'}},
  sign:{grid:SIGN_GRID,col:{'p':'#7a5a2a','w':'#4a3418'}}
};
var ZONE_DECOR={
  town:[{t:'fountain',x:545,y:365},{t:'tree',x:120,y:150},{t:'tree',x:770,y:150},{t:'tree',x:120,y:600},{t:'tree',x:790,y:590},
    {t:'tree',x:680,y:600},{t:'bush',x:340,y:250},{t:'bush',x:660,y:250},{t:'bush',x:360,y:480},{t:'bush',x:700,y:480},
    {t:'bush',x:190,y:250},{t:'bush',x:540,y:250},{t:'lamp',x:455,y:305},{t:'lamp',x:635,y:305},{t:'lamp',x:455,y:445},
    {t:'lamp',x:635,y:445},{t:'fence',x:180,y:340},{t:'fence',x:180,y:400},{t:'sign',x:750,y:400},{t:'bush',x:560,y:600}],
  forest:[{t:'tree',x:150,y:150},{t:'tree',x:680,y:120},{t:'tree',x:120,y:520},{t:'tree',x:770,y:480},
    {t:'tree',x:400,y:90},{t:'tree',x:820,y:280},{t:'rock',x:250,y:350},{t:'rock',x:600,y:600},
    {t:'tree',x:1100,y:180},{t:'tree',x:1380,y:400},{t:'tree',x:1200,y:750},{t:'tree',x:950,y:950},
    {t:'rock',x:1050,y:550},{t:'rock',x:1420,y:850},{t:'tree',x:300,y:900},{t:'tree',x:1300,y:120},
    {t:'pond',x:500,y:500},{t:'pond',x:1150,y:600},{t:'hut',x:900,y:250},{t:'hut',x:230,y:750},
    {t:'tree',x:560,y:260},{t:'tree',x:1000,y:420},{t:'tree',x:1450,y:180},{t:'tree',x:700,y:820},
    {t:'tree',x:1330,y:640},{t:'tree',x:180,y:1000},{t:'bushF',x:340,y:260},{t:'bushF',x:640,y:440},
    {t:'bushF',x:1180,y:340},{t:'bushF',x:840,y:700},{t:'bushF',x:1400,y:980},{t:'bushF',x:460,y:680},
    {t:'stump',x:760,y:360},{t:'stump',x:1080,y:880},{t:'stump',x:280,y:600},{t:'mushroom',x:520,y:640},
    {t:'mushroom',x:1240,y:500},{t:'mushroom',x:920,y:1020},{t:'rock',x:1300,y:320},{t:'rock',x:640,y:960}],
  cave:[{t:'frock',x:120,y:130},{t:'frock',x:750,y:150},{t:'frock',x:200,y:550},{t:'frock',x:700,y:520},
    {t:'frock',x:450,y:100},{t:'frock',x:850,y:350},{t:'icespike',x:100,y:350},
    {t:'frock',x:1150,y:200},{t:'frock',x:1400,y:500},{t:'icespike',x:1250,y:800},{t:'frock',x:1000,y:950},
    {t:'frock',x:1450,y:900},{t:'frock',x:550,y:900},
    {t:'icespike',x:300,y:200},{t:'icespike',x:900,y:650},{t:'icecluster',x:600,y:250},
    {t:'icecluster',x:1300,y:350},{t:'fpond',x:750,y:750},{t:'fpond',x:200,y:800},
    {t:'icespike',x:520,y:420},{t:'icespike',x:1080,y:640},{t:'icespike',x:380,y:980},{t:'icespike',x:1380,y:220},
    {t:'icecluster',x:240,y:700},{t:'icecluster',x:980,y:420},{t:'icecluster',x:1200,y:1000},{t:'icecluster',x:680,y:1000},
    {t:'frock',x:340,y:400},{t:'frock',x:1250,y:640},{t:'fpond',x:1100,y:280},{t:'fpond',x:480,y:640}],
  dungeon:[{t:'pillar',x:130,y:120},{t:'pillar',x:820,y:140},{t:'pillar',x:180,y:500},{t:'pillar',x:780,y:480},
    {t:'drock',x:480,y:600},{t:'drock',x:1150,y:250},{t:'drock',x:1200,y:700},{t:'drock',x:950,y:850},
    {t:'drock',x:350,y:850},{t:'rubble',x:300,y:300},{t:'rubble',x:900,y:400},{t:'rubble',x:600,y:800},
    {t:'bones',x:1050,y:180},{t:'bones',x:400,y:450},
    {t:'pillar',x:1100,y:120},{t:'pillar',x:1100,y:820},{t:'pillar',x:480,y:820},{t:'pillar',x:640,y:300},
    {t:'rubble',x:1080,y:560},{t:'rubble',x:220,y:640},{t:'rubble',x:760,y:680},{t:'bones',x:820,y:560},
    {t:'bones',x:520,y:200},{t:'mushroomB',x:640,y:640},{t:'mushroomB',x:1180,y:440},{t:'mushroomB',x:280,y:180},
    {t:'drock',x:700,y:120},{t:'drock',x:1000,y:620}]
};
// ===== GROUND LAYER (procedural, phủ kín + biến sắc + path + rải decor nhỏ, cull theo camera) =====
function h2(x,y){ var n=(x*374761393+y*668265263)|0; n=(n^(n>>>13))*1274126177|0; n^=n>>>16; return (n>>>0)/4294967296; }
var GROUND={
  town:   {base:'#141d10',tiles:['#243a1c','#2a4420','#20351a','#284020','#26401c'],ts:46,path:'#6a5636',pathEdge:'#463618',pathW:34,ss:26,density:0.30,
    patchD:'#1a2e14',patchL:'#31522a',
    specks:[{k:'blade',c:'#356426'},{k:'blade',c:'#437a2e'},{k:'dot',c:'#e8d05a'},{k:'dot',c:'#d86a8a'},{k:'dot',c:'#e0e0e0'}]},
  forest: {base:'#0c0806',tiles:['#152810','#1a3014','#12240e','#182c12','#16290f'],ts:46,path:'#4a3a24',pathEdge:'#2e2416',pathW:32,ss:22,density:0.42,
    patchD:'#0e1e0a',patchL:'#22401a',
    specks:[{k:'blade',c:'#274c1c'},{k:'blade',c:'#1e3c16'},{k:'clump',c:'#12200c'},{k:'dot',c:'#3a5a24'},{k:'dot',c:'#c8a83a'}]},
  cave:   {base:'#070c14',tiles:['#16283a','#1b3145','#122234','#193049','#17293c'],ts:46,path:'#3d4d5e',pathEdge:'#233241',pathW:32,ss:32,density:0.22,
    patchD:'#0e1c2c',patchL:'#25415a',
    specks:[{k:'cross',c:'#8ac0e0'},{k:'dot',c:'#cfeaf7'},{k:'pebble',c:'#2a3f52'},{k:'pebble',c:'#34506a'},{k:'dot',c:'#5a7f9a'}]},
  dungeon:{base:'#0d070d',tiles:['#241826','#2b1e2d','#1e1420','#281a2a','#241826'],ts:46,path:'#4a3a4a',pathEdge:'#2c1f30',pathW:32,ss:28,density:0.28,
    patchD:'#160e18',patchL:'#342238',
    specks:[{k:'dash',c:'#120d14'},{k:'pebble',c:'#3a2c3c'},{k:'dot',c:'#c9b896'},{k:'dash',c:'#3a2838'},{k:'pebble',c:'#241a28'}]},
  swamp:  {base:'#0a0f0a',tiles:['#16281a','#1c3320','#122414','#1a2e1c','#17291a'],ts:46,path:'#3a3320',pathEdge:'#241f12',pathW:32,ss:26,density:0.36,
    patchD:'#0e1c10',patchL:'#264a2a',
    specks:[{k:'dot',c:'#8a3a6a'},{k:'blade',c:'#2a5a2c'},{k:'dot',c:'#c8b84a'},{k:'clump',c:'#0e1a0c'},{k:'dot',c:'#4a8a6a'}]}
};
// path = các đoạn nối portal ↔ trung tâm ↔ NPC để người chơi cảm được hướng đi
var ZPATHS={
  town:[[820,350,545,365],[545,365,450,200],[545,365,255,510],[545,365,615,420]],
  forest:[[60,550,360,540],[360,540,720,560],[720,560,1080,600],[1080,600,1400,600]],
  cave:[[1440,550,1120,560],[1120,560,760,600],[760,600,420,560],[420,560,120,540]],
  dungeon:[[60,475,380,480],[380,480,700,500],[700,500,1000,485],[1000,485,1230,500]],
  swamp:[[80,80,400,300],[400,300,800,520],[800,520,1150,800],[1150,800,1400,1000]]
};
function drawGround(zd,zone,camX,camY){
  var G=GROUND[zone]; if(!G) return;
  var vx0=Math.max(0,camX-WW/2-30), vx1=Math.min(zd.w,camX+WW/2+30);
  var vy0=Math.max(0,camY-WH/2-30), vy1=Math.min(zd.h,camY+WH/2+30);
  var TS=G.ts, nt=G.tiles.length;
  var tx0=Math.floor(vx0/TS), tx1=Math.ceil(vx1/TS), ty0=Math.floor(vy0/TS), ty1=Math.ceil(vy1/TS);
  // base tiles + dither viền để phá lưới caro
  for(var ty=ty0;ty<ty1;ty++){ for(var tx=tx0;tx<tx1;tx++){
    var bx=tx*TS, by=ty*TS;
    ctx.fillStyle=G.tiles[Math.floor(h2(tx,ty)*nt)%nt];
    ctx.fillRect(bx,by,TS+1,TS+1);
    // vài mảnh sắc lân cận rải ở mép → xoá cảm giác ô vuông
    if(h2(tx*3+1,ty*3+2)<0.7){
      ctx.fillStyle=G.tiles[Math.floor(h2(tx+9,ty+4)*nt)%nt];
      var fs=TS*(0.28+h2(tx,ty)*0.22);
      ctx.fillRect(bx+h2(tx,ty+7)*TS*0.72, by+h2(tx+7,ty)*TS*0.72, fs, fs);
      ctx.fillRect(bx+TS-fs*0.8-h2(tx+2,ty)*TS*0.3, by+TS-fs*0.8-h2(tx,ty+3)*TS*0.3, fs*0.7, fs*0.7);
    }
  }}
  // mảng loang lớn (biến sắc quy mô lớn, alpha thấp) — phá đều
  var CS=TS*3;
  var cx0=Math.floor(vx0/CS), cx1=Math.ceil(vx1/CS), cy0=Math.floor(vy0/CS), cy1=Math.ceil(vy1/CS);
  ctx.globalAlpha=0.15;
  for(var cy=cy0;cy<cy1;cy++){ for(var cx=cx0;cx<cx1;cx++){
    var pr=h2(cx*5+2,cy*5+9); if(pr>0.52) continue;
    ctx.fillStyle=pr<0.26?G.patchD:G.patchL;
    ctx.fillRect(cx*CS-8,cy*CS-8,CS+16,CS+16);
  }}
  ctx.globalAlpha=1;
  // path: viền tối + lõi đất đặc → ra con đường thật
  var segs=ZPATHS[zone];
  if(segs){ ctx.lineCap='round';ctx.lineJoin='round';
    ctx.globalAlpha=0.6;ctx.strokeStyle=G.pathEdge;ctx.lineWidth=G.pathW+9;
    for(var s=0;s<segs.length;s++){var sg=segs[s];ctx.beginPath();ctx.moveTo(sg[0],sg[1]);ctx.lineTo(sg[2],sg[3]);ctx.stroke();}
    ctx.globalAlpha=0.92;ctx.strokeStyle=G.path;ctx.lineWidth=G.pathW;
    for(var s2=0;s2<segs.length;s2++){var s3=segs[s2];ctx.beginPath();ctx.moveTo(s3[0],s3[1]);ctx.lineTo(s3[2],s3[3]);ctx.stroke();}
    ctx.globalAlpha=1; }
  // đốm nhỏ (rải lệch + biến kích cỡ, không bám lưới)
  var SS=G.ss, ns=G.specks.length;
  var gx0=Math.floor(vx0/SS), gx1=Math.ceil(vx1/SS), gy0=Math.floor(vy0/SS), gy1=Math.ceil(vy1/SS);
  for(var gy=gy0;gy<gy1;gy++){ for(var gx=gx0;gx<gx1;gx++){
    var r=h2(gx*7+3,gy*7+11); if(r>=G.density) continue;
    var sp=G.specks[Math.floor(h2(gx*13,gy*17)*ns)%ns];
    var ox=gx*SS+h2(gx,gy+5)*SS*0.8, oy=gy*SS+h2(gx+5,gy)*SS*0.8;
    var sc=0.7+h2(gx+2,gy+8)*0.7;
    ctx.fillStyle=sp.c;
    if(sp.k==='blade'){ ctx.fillRect(ox,oy-4*sc,1.4,5*sc);ctx.fillRect(ox+2,oy-3*sc,1.4,4*sc);ctx.fillRect(ox-2,oy-2*sc,1.4,3*sc); }
    else if(sp.k==='dot'){ var d=2.4*sc; ctx.fillRect(ox,oy,d,d); }
    else if(sp.k==='pebble'){ ctx.fillRect(ox,oy,3.4*sc,2.2*sc); }
    else if(sp.k==='cross'){ var cl=(3.4)*sc; ctx.fillRect(ox-cl*0.4,oy,cl,1.3);ctx.fillRect(ox+cl*0.1,oy-cl*0.4,1.3,cl); }
    else if(sp.k==='dash'){ ctx.save();ctx.translate(ox,oy);ctx.rotate(r*3.1);ctx.fillRect(0,0,6*sc,1.4);ctx.restore(); }
    else if(sp.k==='clump'){ ctx.fillRect(ox,oy,4*sc,3*sc);ctx.fillRect(ox+1,oy-2*sc,2*sc,2*sc); }
  }}
}
function resize(){
  scr.dpr=Math.min(devicePixelRatio||1,2);
  var r=cv.getBoundingClientRect(); scr.w=r.width; scr.h=r.height;
  cv.width=scr.w*scr.dpr; cv.height=scr.h*scr.dpr;
  scr.scale=Math.min(scr.w/WW, scr.h/WH);
  scr.ox=(scr.w-WW*scr.scale)/2; scr.oy=(scr.h-WH*scr.scale)/2;
}
addEventListener('resize',resize); resize();

var myId=null, players={}, enemies={}, bolts=[], loot=[], fx=[], dmgs=[], shake=0, chosen=false, lastSkillMeta=null, zoneObs={};
var ZONEDATA={}, myZone='town', lastZoneSeen='town';
var myBuild={STR:0,VIT:0,AGI:0,INT:0,statPts:0,skillPts:0}, myPassive=null, chrOpen=false, myFull=[], myLoadout={};
var STATNAME={STR:'Sức Mạnh (⚔ dmg)',VIT:'Sinh Lực (❤ máu · 🔰 phản đòn)',AGI:'Nhanh Nhẹn (💨 tốc · 🌀 né tránh)',INT:'Trí Tuệ (🔷 mana/CD)'};
function renderChr(){
  var pb=document.getElementById('pasvBox');
  pb.innerHTML=myPassive?('<b>'+myPassive.name+'</b><br>'+myPassive.desc):'Chưa chọn class';
  var myPk=(players[myId]&&players[myId].pkScore)||0, myJail=(players[myId]&&players[myId].jailed)||0;
  if(myPk>0){
    var pkSec=document.getElementById('pkSecChr');
    if(!pkSec){ pkSec=document.createElement('div'); pkSec.id='pkSecChr'; pkSec.style.cssText='max-width:320px;width:100%;background:#2a1512;border:1px solid #b8514d;border-radius:8px;padding:10px;margin-bottom:10px;text-align:center';
      pb.parentNode.insertBefore(pkSec, pb); }
    pkSec.innerHTML='<div style="color:#ff9a8a;font-size:12px;margin-bottom:6px">☠️ Điểm PK: '+Math.round(myPk)+(myJail>0?' · Đang tự thú ('+Math.round(myJail)+'s)':'')+'</div>';
    if(myJail<=0){ var tuThuBtn=document.createElement('button'); tuThuBtn.textContent='🔒 Tự Thú (giảm PK nhanh 60s)';
      tuThuBtn.style.cssText='padding:7px 16px;border-radius:7px;border:1px solid #ff9a8a;background:#3a1a15;color:#ffb0a0;font-size:11px';
      tuThuBtn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'tuthu'}));});
      pkSec.appendChild(tuThuBtn); }
  } else { var old=document.getElementById('pkSecChr'); if(old)old.remove(); }
  document.getElementById('ptsline').textContent='Điểm chỉ số: '+myBuild.statPts+' · Điểm skill: '+myBuild.skillPts;
  var sg=document.getElementById('statgrid'); sg.innerHTML='';
  ['STR','VIT','AGI','INT'].forEach(function(st){
    var row=document.createElement('div'); row.className='statrow';
    row.innerHTML='<span class="sn">'+STATNAME[st]+'</span><span class="sv">'+(myBuild[st]||0)+'</span>';
    var btn=document.createElement('button'); btn.textContent='+'; btn.disabled=myBuild.statPts<=0;
    btn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'allocstat',stat:st}));});
    row.appendChild(btn); sg.appendChild(row);
  });
  var skg=document.getElementById('skgrid'); skg.innerHTML='';
  var hdr=document.createElement('div'); hdr.style.cssText='font-size:11px;color:#9a8a6a;margin:4px 0 6px;max-width:340px;width:100%';
  hdr.textContent='Kỹ Năng đã học (chạm nhanh Q/W/E/R để trang bị/tung tự động — GIỮ rồi kéo để tự ngắm hướng/khoảng cách với skill có hướng):'; skg.appendChild(hdr);
  var myLv=(players[myId]&&players[myId].lv)||1;
  var STATLBL={STR:'Sức Mạnh',VIT:'Sinh Lực',AGI:'Nhanh Nhẹn',INT:'Trí Tuệ'};
  myFull.forEach(function(s){
    var lvOk = myLv>=s.unlockLv;
    var statOk = !s.reqStat || (myBuild[s.reqStat]||0)>=s.reqVal;
    var unl = s.unlocked || (lvOk && statOk);
    var lockReason = !lvOk ? ('🔒 Lv '+s.unlockLv) : (!statOk ? ('🔒 Cần '+s.reqVal+' '+STATLBL[s.reqStat]) : '');
    var row=document.createElement('div'); row.className='skrow2'+(unl?'':' locked');
    var equippedSlot=null; for(var k in myLoadout){ if(myLoadout[k]===s.id)equippedSlot=k; }
    var branchTag = s.reqStat ? ('<span style="font-size:9px;color:#9a8a6a"> · nhánh '+STATLBL[s.reqStat]+'</span>') : '';
    row.innerHTML='<div class="sk2top"><span class="si">'+s.icon+'</span><span class="sname">'+s.name+branchTag+'</span>'+
      (unl?('<span class="sr">Rank '+s.rank+'/5</span>'):('<span class="sr">'+lockReason+'</span>'));
    if(s.desc){ var descEl=document.createElement('div'); descEl.style.cssText='font-size:10.5px;color:#b8a888;margin:4px 0 6px;line-height:1.4';
      descEl.textContent=s.desc; row.appendChild(descEl); }
    if(unl && s.scaleKey && s.rank<5){
      var curMul=1+(s.rank-1)*0.22, nextMul=1+(s.rank)*0.22;
      var prevEl=document.createElement('div'); prevEl.style.cssText='font-size:10px;color:#e0b062;margin-bottom:6px';
      prevEl.textContent='⬆ Nâng lên Rank '+(s.rank+1)+': sức mạnh '+Math.round(curMul*100)+'% → '+Math.round(nextMul*100)+'%';
      row.appendChild(prevEl);
    } else if(unl && s.scaleKey && s.rank>=5){
      var maxEl=document.createElement('div'); maxEl.style.cssText='font-size:10px;color:#7a9a6a;margin-bottom:6px';
      maxEl.textContent='✓ Đã tối đa (Rank 5/5, sức mạnh 188%)'; row.appendChild(maxEl);
    }
    var rowEl=row;
    var slotWrap=document.createElement('div'); slotWrap.className='sk2slots';
    if(unl){
      ['q','w','e','r'].forEach(function(slot){
        var sb=document.createElement('button'); sb.textContent=slot.toUpperCase();
        sb.className='slotbtn'+(equippedSlot===slot?' active':'');
        sb.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'setloadout',slot:slot,skillId:s.id}));});
        slotWrap.appendChild(sb);
      });
      var rb=document.createElement('button'); rb.className='rankbtn'; rb.textContent='▲ Nâng';
      rb.disabled=(myBuild.skillPts<=0||s.rank>=5);
      rb.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'rankskill',skillId:s.id}));});
      slotWrap.appendChild(rb);
    }
    rowEl.appendChild(slotWrap);
    skg.appendChild(rowEl);
  });
}
document.getElementById('chr').addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();
  chrOpen=!chrOpen;document.getElementById('chrPanel').style.display=chrOpen?'flex':'none';if(chrOpen)renderChr();});
document.getElementById('chrClose').addEventListener('pointerdown',function(ev){ev.preventDefault();
  chrOpen=false;document.getElementById('chrPanel').style.display='none';});
var myInv=[], myEquip={}, invOpen=false, selId=null;
var myParty=null, chatLog=[], socOpen=false, socTab='chat', pendingInviteFrom=null;
var NPCLIST=[], nearNpcId=null, nearNpcKind=null, npcOpen=false, curNpcId=null, curNpcData=null;
var PETTYPES=[], myPets={}, myPetOwn=null, petOpen=false, myFusedT=0, myFusionCd=0, mySummons={};
document.getElementById('petbtn').addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();
  petOpen=!petOpen; document.getElementById('petPanel').style.display=petOpen?'flex':'none'; if(petOpen)renderPet();});
document.getElementById('petClose').addEventListener('pointerdown',function(ev){ev.preventDefault();
  petOpen=false; document.getElementById('petPanel').style.display='none';});
function renderPet(){
  var box=document.getElementById('petBody'); box.innerHTML='';
  var h1=document.createElement('div'); h1.style.cssText='color:#e0b062;font-weight:bold;font-size:13px;margin-bottom:6px;align-self:flex-start';
  h1.textContent='🐺 Đệ Tử (chiến đấu)'; box.appendChild(h1);
  if(!myPetOwn){
    var e=document.createElement('div'); e.className='petempty';
    e.textContent='Chưa có Đệ Tử. Hãy hạ Boss Thế Giới (Rừng Ma / Hang Băng) để có cơ hội săn được một con theo mình!';
    box.appendChild(e);
  } else {
  var pt=PETTYPES.find(function(t){return t.id===myPetOwn.type;})||{icon:'🐾',name:'?',desc:''};
  var head=document.createElement('div'); head.className='pethead';
  var pct=Math.min(100,(myPetOwn.xp/myPetOwn.xpNext)*100);
  var fpct=myPetOwn.fullness;
  head.innerHTML='<div class="pic">'+pt.icon+'</div><div class="pn">'+pt.name+' · Lv '+myPetOwn.lv+'</div>'+
    '<div class="pd">'+pt.desc+'</div>'+
    '<div style="font-size:10px;color:#9a8a6a;margin-top:8px">Kinh nghiệm '+myPetOwn.xp+'/'+myPetOwn.xpNext+'</div>'+
    '<div class="petbar"><i style="width:'+pct+'%;background:linear-gradient(90deg,#e0b062,#c98a2e)"></i></div>'+
    '<div style="font-size:10px;color:#9a8a6a;margin-top:8px">Độ no '+Math.round(fpct)+'/100'+(fpct<=0?' · Đói! Giảm hiệu quả':'')+'</div>'+
    '<div class="petbar"><i style="width:'+fpct+'%"></i></div>';
  box.appendChild(head);
  var fb=document.createElement('button'); fb.id='feedBtn'; fb.textContent='🍖 Cho ăn (30🪙)';
  fb.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'feedpet'}));});
  box.appendChild(fb);
  var fuseSec=document.createElement('div'); fuseSec.style.cssText='margin-top:14px;max-width:300px;width:100%;text-align:center';
  if(myFusedT>0){
    fuseSec.innerHTML='<div style="color:#ffd76b;font-size:12px;margin-bottom:6px">⚡ Đang hợp thể! Còn '+myFusedT+'s</div>';
  } else if(myFusionCd>0){
    fuseSec.innerHTML='<div style="color:#9a8a6a;font-size:11px;margin-bottom:6px">Hợp thể hồi chiêu: '+myFusionCd+'s</div>';
  } else {
    var fuseBtn=document.createElement('button'); fuseBtn.textContent='⚡ Hợp Thể Tạm Thời (5 phút)';
    fuseBtn.style.cssText='width:100%;padding:9px;border-radius:8px;border:1px solid #ffd76b;background:#3a2a12;color:#ffe9a8;font-weight:bold;margin-bottom:8px';
    fuseBtn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'fusion'}));});
    fuseSec.appendChild(fuseBtn);
  }
  box.appendChild(fuseSec);
  var permBtn=document.createElement('button'); permBtn.textContent='💫 Hợp Thể Vĩnh Viễn (mất Đệ Tử, +chỉ số mãi mãi)';
  permBtn.style.cssText='width:100%;max-width:300px;padding:8px;border-radius:8px;border:1px solid #b8514d;background:#2a1512;color:#ff9a8a;font-size:11px;margin-top:6px';
  permBtn.addEventListener('pointerdown',function(ev){ev.preventDefault();
    if(confirm('Đệ Tử sẽ biến mất VĨNH VIỄN để đổi lấy chỉ số cộng thẳng mãi mãi. Chắc chắn chứ?')) ws.send(JSON.stringify({t:'permfusion'}));});
  box.appendChild(permBtn);
  }
  var divider=document.createElement('div'); divider.style.cssText='width:100%;max-width:300px;height:1px;background:#6b5636;margin:16px 0';
  box.appendChild(divider);
  var h2=document.createElement('div'); h2.style.cssText='color:#e0b062;font-weight:bold;font-size:13px;margin-bottom:6px;align-self:flex-start';
  h2.textContent='🐾 Thú Cưng (buff thụ động)'; box.appendChild(h2);
  if(!myHsPet){
    var e2=document.createElement('div'); e2.className='petempty';
    e2.textContent='Chưa có Thú Cưng. Mua 🥚 trứng tại Thương Nhân Elin (cần Lv 5, 200🪙).';
    box.appendChild(e2);
  } else {
    var hshead=document.createElement('div'); hshead.className='pethead';
    var hh=myHsPet.hunger;
    hshead.innerHTML='<div class="pic">🐾</div><div class="pn">Thú Cưng của bạn</div>'+
      '<div class="pd">Sức Mạnh +'+Math.floor((myHsPet.stat.STR||0)/8)+' · Sinh Lực +'+Math.floor((myHsPet.stat.VIT||0)/8)+
      ' · Nhanh Nhẹn +'+Math.floor((myHsPet.stat.AGI||0)/8)+' · Trí Tuệ +'+Math.floor((myHsPet.stat.INT||0)/8)+'</div>'+
      '<div style="font-size:10px;color:#9a8a6a;margin-top:8px">Độ no '+Math.round(hh)+'/100'+(hh<=0?' · Đói! Giảm hiệu quả':'')+'</div>'+
      '<div class="petbar"><i style="width:'+hh+'%"></i></div>';
    box.appendChild(hshead);
    var feedHint=document.createElement('div'); feedHint.style.cssText='font-size:10px;color:#9a8a6a;margin:8px 0 6px;max-width:300px;text-align:center';
    feedHint.textContent='Cho ăn bằng đồ trong túi: Vũ khí→Sức Mạnh · Giáp/Mũ/Găng/Giày→Sinh Lực · Nhẫn/Dây chuyền→Nhanh Nhẹn · Cánh→Trí Tuệ';
    box.appendChild(feedHint);
    var slotGroups=[['wpn','⚔️ Vũ Khí (STR)'],['arm','🛡️ Giáp (VIT)'],['rng','💍 Nhẫn (AGI)'],['wing','🪽 Cánh (INT)']];
    slotGroups.forEach(function(sg){
      var item=myInv.find(function(it){return it.slot===sg[0];});
      var fbtn=document.createElement('button'); fbtn.textContent='Cho ăn '+sg[1]+(item?'':' (không có đồ)');
      fbtn.style.cssText='width:100%;max-width:300px;padding:7px;border-radius:7px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-size:11px;margin-bottom:5px';
      fbtn.disabled=!item;
      fbtn.addEventListener('pointerdown',function(ev){ev.preventDefault(); if(item)ws.send(JSON.stringify({t:'feedhspet',itemId:item.id}));});
      box.appendChild(fbtn);
    });
  }
}
document.getElementById('talkBtnInner').addEventListener('pointerdown',function(ev){ev.preventDefault();
  if(!nearNpcId)return;
  if(nearNpcKind==='shop'){ ws.send(JSON.stringify({t:'shopopen'})); }
  else { curNpcId=nearNpcId; ws.send(JSON.stringify({t:'talknpc',npcId:nearNpcId})); }
});
document.getElementById('npClose').addEventListener('pointerdown',function(ev){ev.preventDefault();
  npcOpen=false; document.getElementById('npcPanel').style.display='none';});
function renderNpcPanel(){
  if(!curNpcData)return;
  document.getElementById('npIcon').textContent=curNpcData.icon;
  document.getElementById('npName').textContent=curNpcData.name;
  document.getElementById('npGreet').textContent=curNpcData.greet;
  var box=document.getElementById('npQuests'); box.innerHTML='';
  curNpcData.quests.forEach(function(q){
    var row=document.createElement('div'); row.className='nqrow'+(q.state==='locked'?' locked':'');
    var rw=[]; if(q.reward.gold)rw.push('+'+q.reward.gold+'🪙'); if(q.reward.xp)rw.push('+'+q.reward.xp+'XP'); if(q.reward.stones)rw.push('+'+q.reward.stones+'🔨'); if(q.reward.itemTier)rw.push('+1 vật phẩm hiếm');
    var barHtml = q.state==='accepted'||q.state==='claimable' ? '<div class="qbar" style="margin-bottom:6px"><i style="width:'+Math.min(100,q.progress/q.target*100)+'%"></i></div>' : '';
    row.innerHTML='<div class="nqn">'+q.name+'</div><div class="nqd">'+q.desc+'</div>'+barHtml+'<div class="nqr">Thưởng: '+rw.join(' ')+'</div>';
    var btn=document.createElement('button');
    if(q.state==='locked'){btn.textContent='🔒 Khóa';btn.disabled=true;}
    else if(q.state==='claimed'){btn.textContent='✅ Hoàn thành';btn.disabled=true;}
    else if(q.state==='available'){btn.textContent='Nhận nhiệm vụ';
      btn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'acceptnpcq',npcId:curNpcId,qid:q.id}));});}
    else if(q.state==='accepted'){btn.textContent=q.progress+'/'+q.target;btn.disabled=true;}
    else if(q.state==='claimable'){btn.textContent='🎁 Nhận thưởng';
      btn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'claimnpcq',npcId:curNpcId,qid:q.id}));});}
    row.appendChild(btn); box.appendChild(row);
  });
}
var mySh={potions:[],gold:0,inv:[]}, shTab='buy';
var HSPET_EGG_COST_CLIENT=200, myHsPet=null;
var GEMTYPES={}, myGemCount={};
var myTraps=[];
var myCrystals=[];
var myWells=[];
var myIllusions=[];
var myBanners=[];
document.getElementById('shTabBuy').addEventListener('pointerdown',function(ev){ev.preventDefault();
  shTab='buy'; document.getElementById('shTabBuy').classList.add('on'); document.getElementById('shTabSell').classList.remove('on'); document.getElementById('shTabMount').classList.remove('on');
  document.getElementById('shopBuy').style.display='flex'; document.getElementById('shopSell').style.display='none'; document.getElementById('shopMount').style.display='none';});
document.getElementById('shTabSell').addEventListener('pointerdown',function(ev){ev.preventDefault();
  shTab='sell'; document.getElementById('shTabSell').classList.add('on'); document.getElementById('shTabBuy').classList.remove('on'); document.getElementById('shTabMount').classList.remove('on');
  document.getElementById('shopSell').style.display='flex'; document.getElementById('shopBuy').style.display='none'; document.getElementById('shopMount').style.display='none'; renderShop();});
document.getElementById('shTabMount').addEventListener('pointerdown',function(ev){ev.preventDefault();
  shTab='mount'; document.getElementById('shTabMount').classList.add('on'); document.getElementById('shTabBuy').classList.remove('on'); document.getElementById('shTabSell').classList.remove('on');
  document.getElementById('shopMount').style.display='flex'; document.getElementById('shopBuy').style.display='none'; document.getElementById('shopSell').style.display='none'; renderMountShop();});
document.getElementById('shopClose').addEventListener('pointerdown',function(ev){ev.preventDefault();
  document.getElementById('shopPanel').style.display='none';});
var MOUNTTYPES=[], myMounts=[], myMounted=null;
function renderMountShop(){
  var box=document.getElementById('shopMount'); box.innerHTML='';
  MOUNTTYPES.forEach(function(mt){
    var owned=myMounts.indexOf(mt.id)>=0;
    var row=document.createElement('div'); row.className='glistrow'; row.style.maxWidth='320px';
    row.innerHTML='<span>'+mt.name+' · '+mt.desc+(owned?'':' · '+mt.cost+'🪙')+'</span>';
    var btn=document.createElement('button');
    if(!owned){ btn.textContent='Mua';
      btn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'buymount',mountId:mt.id}));});
    } else { btn.textContent = (myMounted===mt.id)?'Xuống':'Cưỡi';
      btn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'togglemount',mountId:mt.id}));});
    }
    row.appendChild(btn); box.appendChild(row);
  });
}
function renderShop(){
  document.getElementById('shopgold').textContent='🪙 '+mySh.gold;
  var buy=document.getElementById('shopBuy'); buy.innerHTML='';
  if(!myHsPet){
    var eggRow=document.createElement('div'); eggRow.className='potrow';
    eggRow.innerHTML='<div><div class="pn">🥚 Trứng Thú Cưng</div><div class="pd">Nở ngay, nuôi lớn bằng cách cho ăn đồ theo class · cần Lv 5</div></div>';
    var eggBtn=document.createElement('button'); eggBtn.textContent=HSPET_EGG_COST_CLIENT+'🪙';
    eggBtn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'buyhspet'}));});
    eggRow.appendChild(eggBtn); buy.appendChild(eggRow);
  }
  (mySh.potions||[]).forEach(function(pot){
    var row=document.createElement('div'); row.className='potrow';
    row.innerHTML='<div><div class="pn">'+pot.name+'</div><div class="pd">'+pot.desc+'</div></div>';
    var btn=document.createElement('button'); btn.textContent=pot.cost+'🪙'; btn.disabled=mySh.gold<pot.cost;
    btn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'buypotion',kind:pot.id}));});
    row.appendChild(btn); buy.appendChild(row);
  });
  var sell=document.getElementById('shopSell'); sell.innerHTML='';
  var SI={wpn:'⚔️',arm:'🛡️',hlm:'🪖',rng:'💍',glv:'🧤',boot:'🥾',neck:'📿',wing:'🪽'};
  (mySh.inv||[]).forEach(function(it){
    var row=document.createElement('div'); row.className='sellrow';
    row.innerHTML='<span>'+SI[it.slot]+(it.plus?(' +'+it.plus):'')+'</span>';
    var btn=document.createElement('button'); btn.textContent='Bán '+it.sell+'🪙';
    btn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'sellitem',itemId:it.id}));});
    row.appendChild(btn); sell.appendChild(row);
  });
  if(!mySh.inv||!mySh.inv.length) sell.innerHTML='<div style="color:#9a8a6a;font-size:12px">Túi trống.</div>';
}
var myGuild=null, myGuildList=[];
document.getElementById('guildbtn').addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();
  document.getElementById('guildPanel').style.display='flex';
  if(!myGuild) ws.send(JSON.stringify({t:'guildlist'}));
  renderGuild();});
document.getElementById('guildClose').addEventListener('pointerdown',function(ev){ev.preventDefault();
  document.getElementById('guildPanel').style.display='none';});
function renderGuild(){
  var box=document.getElementById('guildBody'); box.innerHTML='';
  if(!myGuild){
    var cre=document.createElement('div'); cre.className='gcreate';
    cre.innerHTML='<div style="font-size:12px;color:#c8b48a;margin-bottom:6px">Lập bang hội mới (tốn 200🪙)</div>'+
      '<input id="gnameinput" maxlength="20" placeholder="Tên bang...">'+
      '<button id="gcreateBtn">Lập Bang</button>';
    box.appendChild(cre);
    document.getElementById('gcreateBtn').addEventListener('pointerdown',function(ev){ev.preventDefault();
      var nm=document.getElementById('gnameinput').value.trim(); if(!nm)return;
      ws.send(JSON.stringify({t:'createguild',name:nm}));});
    var hdr=document.createElement('div'); hdr.style.cssText='font-size:12px;color:#9a8a6a;margin-bottom:6px;max-width:320px;width:100%';
    hdr.textContent='Danh sách bang hội:'; box.appendChild(hdr);
    if(!myGuildList.length){ var e2=document.createElement('div'); e2.style.cssText='color:#9a8a6a;font-size:12px'; e2.textContent='Chưa có bang nào.'; box.appendChild(e2); }
    myGuildList.forEach(function(g){
      var row=document.createElement('div'); row.className='glistrow';
      row.innerHTML='<span>'+g.name+' · Lv'+g.level+' · '+g.members+' người</span>';
      var btn=document.createElement('button'); btn.textContent='Xin gia nhập';
      (function(gid){btn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'requestjoin',gid:gid}));});})(g.id);
      row.appendChild(btn); box.appendChild(row);
    });
    return;
  }
  var g=myGuild;
  var head=document.createElement('div'); head.className='ghead';
  head.innerHTML='<div class="gn">🏯 '+g.name+'</div><div class="glv">Cấp '+g.level+' · Quỹ '+g.treasury+'🪙 · XP '+g.xp+'/'+g.xpNext+' · Bonus vàng +'+Math.min(20,g.level*2)+'%</div>'+
    '<div class="gmotd">"'+(g.motd||'')+'"</div>';
  box.appendChild(head);

  if(g.myRank==='leader'){
    var motdSec=document.createElement('div'); motdSec.className='gsec';
    motdSec.innerHTML='<h4>Sửa thông báo bang</h4><div class="gdonrow"><input id="motdInput" maxlength="80" placeholder="Thông báo mới..."><button id="motdBtn">Lưu</button></div>';
    box.appendChild(motdSec);
    document.getElementById('motdBtn').addEventListener('pointerdown',function(ev){ev.preventDefault();
      var t=document.getElementById('motdInput').value.trim(); if(!t)return; ws.send(JSON.stringify({t:'setmotd',text:t}));});
  }

  var donSec=document.createElement('div'); donSec.className='gsec';
  donSec.innerHTML='<h4>Đóng góp quỹ bang (tăng cấp bang)</h4><div class="gdonrow"><input id="donInput" type="number" placeholder="Số vàng..."><button id="donBtn">Góp</button></div>';
  box.appendChild(donSec);
  document.getElementById('donBtn').addEventListener('pointerdown',function(ev){ev.preventDefault();
    var v=parseInt(document.getElementById('donInput').value,10); if(!v||v<=0)return; ws.send(JSON.stringify({t:'donate',amount:v}));});

  if((g.myRank==='leader'||g.myRank==='officer') && g.pending && g.pending.length){
    var pendSec=document.createElement('div'); pendSec.className='gsec';
    pendSec.innerHTML='<h4>Đơn xin gia nhập</h4>';
    box.appendChild(pendSec);
    g.pending.forEach(function(pid){
      var row=document.createElement('div'); row.className='gmemrow';
      row.innerHTML='<span>#'+pid+'</span>';
      var bw=document.createElement('div'); bw.className='gbtns';
      var ok=document.createElement('button'); ok.textContent='Duyệt';
      ok.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'approvejoin',targetId:pid}));});
      var no=document.createElement('button'); no.textContent='Từ chối';
      no.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'rejectjoin',targetId:pid}));});
      bw.appendChild(ok); bw.appendChild(no); row.appendChild(bw); pendSec.appendChild(row);
    });
  }

  var memSec=document.createElement('div'); memSec.className='gsec';
  memSec.innerHTML='<h4>Thành viên ('+g.members.length+')</h4>';
  box.appendChild(memSec);
  g.members.forEach(function(mm){
    var row=document.createElement('div'); row.className='gmemrow';
    var badge = mm.rank==='leader'?'👑':(mm.rank==='officer'?'⭐':'');
    row.innerHTML='<span>'+badge+' #'+mm.id+' · Lv'+mm.lv+(mm.online?'':' (offline)')+'</span>';
    var bw=document.createElement('div'); bw.className='gbtns';
    if(g.myRank==='leader' && mm.id!==myId){
      if(mm.rank!=='officer'){ var pb=document.createElement('button'); pb.textContent='Thăng';
        pb.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'promote',targetId:mm.id}));}); bw.appendChild(pb); }
      else { var db=document.createElement('button'); db.textContent='Giáng';
        db.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'demote',targetId:mm.id}));}); bw.appendChild(db); }
      var kb=document.createElement('button'); kb.textContent='Đuổi';
      kb.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'kickguild',targetId:mm.id}));}); bw.appendChild(kb);
    }
    row.appendChild(bw); memSec.appendChild(row);
  });

  var chatSec=document.createElement('div'); chatSec.className='gsec';
  chatSec.innerHTML='<h4>Kênh Bang</h4><div class="chatlog" id="gchatlog" style="max-width:340px;height:110px"></div>'+
    '<div class="chatrow" style="max-width:340px"><input id="gchatinput" maxlength="120" placeholder="Nhắn trong bang..."><button id="gchatsend">Gửi</button></div>';
  box.appendChild(chatSec);
  var glog=document.getElementById('gchatlog');
  glog.innerHTML=chatLogGuild.map(function(m){return '<div class="cm"><b>#'+m.id+'</b> '+escapeHtml(m.text)+'</div>';}).join('');
  glog.scrollTop=glog.scrollHeight;
  document.getElementById('gchatsend').addEventListener('pointerdown',function(ev){ev.preventDefault();sendGuildChat();});
  document.getElementById('gchatinput').addEventListener('keydown',function(ev){ if(ev.key==='Enter'){ev.preventDefault();sendGuildChat();} });

  var leaveBtn=document.createElement('button'); leaveBtn.style.cssText='margin-top:4px;padding:8px 20px;border-radius:8px;border:1px solid #b8514d;background:#2a1512;color:#ff9a8a;font-weight:bold';
  leaveBtn.textContent = g.myRank==='leader' ? 'Giải Tán Bang' : 'Rời Bang';
  leaveBtn.addEventListener('pointerdown',function(ev){ev.preventDefault();
    ws.send(JSON.stringify({t: g.myRank==='leader' ? 'disbandguild' : 'leaveguild'}));});
  box.appendChild(leaveBtn);
}
function sendGuildChat(){ var el=document.getElementById('gchatinput'); var t=el.value.trim(); if(!t)return;
  ws.send(JSON.stringify({t:'guildchat',text:t})); el.value=''; }
var chatLogGuild=[];
document.getElementById('tabChat').addEventListener('pointerdown',function(ev){ev.preventDefault();
  socTab='chat'; document.getElementById('tabChat').classList.add('on'); document.getElementById('tabParty').classList.remove('on');
  document.getElementById('chatView').style.display='flex'; document.getElementById('partyView').style.display='none';});
document.getElementById('tabParty').addEventListener('pointerdown',function(ev){ev.preventDefault();
  socTab='party'; document.getElementById('tabParty').classList.add('on'); document.getElementById('tabChat').classList.remove('on');
  document.getElementById('partyView').style.display='flex'; document.getElementById('chatView').style.display='none'; renderParty();});
document.getElementById('socbtn').addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();
  socOpen=!socOpen; document.getElementById('socPanel').style.display=socOpen?'flex':'none';
  document.getElementById('socdot').style.display='none';
  if(socOpen){ renderChatLog(); if(socTab==='party')renderParty(); }});
document.getElementById('socClose').addEventListener('pointerdown',function(ev){ev.preventDefault();
  socOpen=false; document.getElementById('socPanel').style.display='none';});
function sendChat(){ var el=document.getElementById('chatinput'); var t=el.value.trim(); if(!t)return;
  ws.send(JSON.stringify({t:'chat',text:t})); el.value=''; }
document.getElementById('chatsend').addEventListener('pointerdown',function(ev){ev.preventDefault();sendChat();});
document.getElementById('chatinput').addEventListener('keydown',function(ev){ if(ev.key==='Enter'){ev.preventDefault();sendChat();} });
function renderChatLog(){ var box=document.getElementById('chatlog');
  box.innerHTML=chatLog.map(function(m){return '<div class="cm"><b>#'+m.id+'</b> '+escapeHtml(m.text)+'</div>';}).join('');
  box.scrollTop=box.scrollHeight; }
function escapeHtml(s){ var d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function renderParty(){
  var pl=document.getElementById('plist'); pl.innerHTML='';
  if(myParty && myParty.members && myParty.members.length){
    myParty.members.forEach(function(mm){
      var row=document.createElement('div'); row.className='prow';
      row.innerHTML='<span>#'+mm.id+' · Lv'+mm.lv+(mm.id===myParty.leader?' 👑':'')+'</span>';
      pl.appendChild(row);
    });
    var leave=document.createElement('button'); leave.textContent='Rời nhóm'; leave.style.marginTop='6px';
    leave.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'leaveparty'}));});
    pl.appendChild(leave);
  } else {
    var hdr=document.createElement('div'); hdr.style.cssText='font-size:11px;color:#9a8a6a;margin-bottom:6px;'; hdr.textContent='Người chơi cùng khu vực:';
    pl.appendChild(hdr);
    for(var id in players){ if(id==myId)continue; var p=players[id]; if(!p||p.zone!==myZone)continue;
      var row=document.createElement('div'); row.className='prow';
      var nm=document.createElement('span'); nm.textContent='#'+id+' · Lv'+p.lv;
      var btn=document.createElement('button'); btn.textContent='Mời';
      (function(tid){btn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'invite',targetId:tid}));});})(id);
      row.appendChild(nm); row.appendChild(btn); pl.appendChild(row);
    }
  }
}
function updatePartyHud(){
  var hud=document.getElementById('partyHud');
  if(!myParty || !myParty.members || myParty.members.length<2){ hud.style.display='none'; return; }
  hud.style.display='flex'; hud.innerHTML='';
  myParty.members.forEach(function(mm){ var p=players[mm.id]; if(!p)return;
    var el=document.createElement('div'); el.className='pmr';
    el.innerHTML='#'+mm.id+(mm.id===myParty.leader?' 👑':'')+' Lv'+p.lv+'<div class="pb"><i style="width:'+Math.max(0,p.hp/p.maxhp*100)+'%"></i></div>';
    hud.appendChild(el);
  });
}
document.getElementById('ibAccept').addEventListener('pointerdown',function(ev){ev.preventDefault();
  ws.send(JSON.stringify({t:'acceptinvite'})); document.getElementById('inviteBanner').style.display='none';});
document.getElementById('ibDecline').addEventListener('pointerdown',function(ev){ev.preventDefault();
  ws.send(JSON.stringify({t:'declineinvite'})); document.getElementById('inviteBanner').style.display='none';});
var myQuests={defs:[],qk:{},qc:{},streak:0,checkedToday:false,nextReward:{gold:0,stones:0}}, qOpen=false;
function renderQuests(){
  var ck=document.getElementById('ckbox');
  var nr=myQuests.nextReward||{gold:0,stones:0};
  ck.innerHTML='<div class="cktitle">📅 Điểm danh · chuỗi '+(myQuests.streak||0)+' ngày</div>'+
    '<div class="ckreward">Hôm nay: +'+nr.gold+'🪙'+(nr.stones?(' +'+nr.stones+'🔨'):'')+'</div>'+
    '<button id="ckBtn" '+(myQuests.checkedToday?'disabled':'')+'>'+(myQuests.checkedToday?'Đã điểm danh':'Điểm danh ngay')+'</button>';
  var ckBtn=document.getElementById('ckBtn');
  if(!myQuests.checkedToday)ckBtn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'checkin'}));});
  var ql=document.getElementById('qlist'); ql.innerHTML='';
  (myQuests.defs||[]).forEach(function(d){
    var val=(myQuests.qk&&myQuests.qk[d.id])||0, done=val>=d.target, claimed=myQuests.qc&&myQuests.qc[d.id];
    var row=document.createElement('div'); row.className='qrow';
    var rw=[]; if(d.reward.gold)rw.push('+'+d.reward.gold+'🪙'); if(d.reward.xp)rw.push('+'+d.reward.xp+'XP'); if(d.reward.stones)rw.push('+'+d.reward.stones+'🔨');
    row.innerHTML='<div class="qn">'+d.name+' · '+rw.join(' ')+'</div>'+
      '<div class="qbar"><i style="width:'+Math.min(100,val/d.target*100)+'%"></i></div>';
    var btn=document.createElement('button'); btn.textContent=claimed?'Đã nhận':(done?'Nhận thưởng':val+'/'+d.target);
    btn.disabled=claimed||!done;
    btn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'claimquest',qid:d.id}));});
    row.appendChild(btn); ql.appendChild(row);
  });
  var el=document.getElementById('qdot'); if(el)updateQuestDot();
}
function updateQuestDot(){
  var anyReady=(!myQuests.checkedToday)|| (myQuests.defs||[]).some(function(d){return ((myQuests.qk&&myQuests.qk[d.id])||0)>=d.target && !(myQuests.qc&&myQuests.qc[d.id]);});
  document.getElementById('qdot').style.display=anyReady?'block':'none';
}
document.getElementById('qbtn').addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();
  qOpen=!qOpen;document.getElementById('qPanel').style.display=qOpen?'flex':'none';if(qOpen)renderQuests();});
document.getElementById('qClose').addEventListener('pointerdown',function(ev){ev.preventDefault();
  qOpen=false;document.getElementById('qPanel').style.display='none';});
var SLOTICON={wpn:'⚔️',arm:'🛡️',hlm:'🪖',rng:'💍',glv:'🧤',boot:'🥾',neck:'📿',wing:'🪽'};
var SLOTNAME={wpn:'Vũ khí',arm:'Áo giáp',hlm:'Nón',rng:'Nhẫn',glv:'Găng',boot:'Giày',neck:'Dây chuyền',wing:'Cánh'};
var PAPERDOLL=[null,'hlm',null, 'wpn','FIG','wing', 'glv','arm','boot', null,'rng','neck'];
var MAXPLUS=12, ENCH_RATE=[0.95,0.9,0.85,0.78,0.68,0.58,0.48,0.4,0.32,0.26,0.2,0.15];
function eRate(pl){return ENCH_RATE[pl]!==undefined?ENCH_RATE[pl]:0.12;}
function eCost(it){return it.tier*(((it.plus||0)+1))*10;}
function eStones(it){return it.tier+Math.floor((it.plus||0)/3);}
function eVal(it){return it.val+Math.round(it.val*(it.plus||0)*0.15);}
var ICON_ATLAS='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAAEgCAYAAADi73wxAAAAAXNSR0IArs4c6QAAIABJREFUeJztnXmcFcW99p8jILMwMLLKLiIgQmRfJFcIiuvVxOjr8lHJZq7ZE99o3psbr3lvYrw393X5JDGLMSGJQf1EicQErzsimCAO6xgWQZFFARlgZF+CeN4/qp85p37T1VXdp8842PX9Z+ju6qo+fTjPU/WrDfB4PB6Px+PxeDxZImdLMGDgYADAhvXr8gBwyqmDcwCw8U11TOT5AQPV8Yb165weZOz4iQCAJXWL8pakAIDa2i7as+/evcvpvvMuujgHAM899aTTc7ViTJ/X+p26IL/3EvKJ9f+A9O95GgBg07Y3Siq/f8/TckE+oddPKCVzj+d4x6gWUgFu+PItAIAZP78LAPCxcy/R0r849wmEpbMpgFT+GQ8+Eppu5m9nhpZH5PP8+Jc/Dc1nxGmnAEjPCWzO1a17zxwA7GjYVlI5RWjl8HPL94HSnUD73r/+za/Guvkn96j3z/8HCZ4nDwCfvvTrAID/+PdbYt38Hz9Q5T4w5yeR5XsH8GSaZr8Kk/KvX/ualm76Z6cDAMZOnAAA+MYXdIUYOOR0AE5OEKn8RDqADZMDEDoBEiqlzbn4vEXKnErdHEKZpSOXWt7YCcHnekV9rvo3NmrXqewmpFPwPY+dMDEX5Bt5/4TRqvxXlqnyN7yyWbtOZTchnWLAhH7MNxfkq133DuDJNGEq4aT8Cxcu1s7zl29zgpAynRxAIh3BpviSpA5gU375XkqoA5vIAwXF5/vl95SC42jKT8WfNGlcrEz4Hvj/Isb71pSfin/u2WfHKn/uSy+p+wNHoBPI8r0DeDJNW1sCKgyRCkeoFDJ9qZjKk20QU900bvTCRFzll855vLFk0SsAmiu/6fsgTM+/zCcuL81X90nlp7KbYHr+ZT4mvAN4Mo3VAUx1P1MbQGKLGowdr1rnN1x/dWgcnW0RU/k2RSqqe2q49gMkVX7WxdljvXv3rshyWjv8nK7OFrfNYIPK//f19U7pXdsM3gE8mcboAPwF33D91dp5W7RGKi6jCUXREI0ldU1x2dDoEJ/DpvQSOpIpCmNT/m7de/L5NOXnc7gqXFrKP2ToGQCAtWtWp5KfK1L5KyqrcgBw+NBBLV1FZRXTaU5eqhNI5a+uqM4BwIHDB7R01RXVTKeVb3MC7wCeTGNtA0joCFRERmFMde1Sue/Hqg3xxW/obQxbG0T2R7hC5d/RsE2LtxMqGvshTHH4tMYA8XnWrlmtOVHcnvGk8HO1b1+hKb9pLBbT0QlKdQAqf2X7Sk35l62er6UbfcYULR2dwDuAxxOB0QGosFQc2RaQxxLZk5iU6o6dABScgNARbGORQkZJRmJSfiou+x9kj7iM+qSl/PJ55HPEbRu5IvM9cuQw69a54ueRFKULzccVGe8/dOSQVj4VX1KULjQfiXcAT6YxOoCM95qcQCKVP60eUToBlb3JEYK/Z46bkEo5Nmx171KjPrLfgUpLxZflp9324KjdGT+/yzQmzGmGVozRwBqcwfXAnJ9o8wGK4v9O5X9k4AgE+Wj5yplh3gE8mabZyDxZ95Q9sab+AVOdnwqQQJnyADB06JkAgB69+mkXbWOOEoxC5HMieM7QtgCh4qY1Dr+IyGiPdIK0o07ENC/ElbjKL5FzgukErtiUn3gH8GQa5znBkiFDz8gBQE3HjgAKM4hC8kmkADU1qs6/b9+eSCeQcF5AqXN/bU4go0spKrDT3OhyKb8k6eoQSb93SdLVIWzKT7wDeDJNWrOUyoZ0AlfSWvVBOgEp1yhP1/WRyq38WcE7gMfj8Xg8ngzS6tsA5NzBqi4+d922yLrxuYNV3XjuOl839tjxbQBPpmn1DjC6TxcAwLK31erPi2++NDL9uLvn8L5ccF9Zn6+l6Ny+FgDQeGR3pAN2bl+bC9K1wFMd/3gH8GQaqwOc2qkDAODNPftjxeFP7dQhF9znlN5Wx6fyf2XmW5H5/Gx6XwAFJwgpJ9U2wohuSpnrd4Qrc4qKnAeA8d1HRiaqa1jBf6bq7i3dBuvVX/UAb91U2v4AvfqrHuGtm/xYII+nGUaVkMp/4wj1ixzSuSYyw7WN+wAA99e/wXwinUAqi6mOb1N+CZ1AQmdIoFSaEp3eo1MOAF7brnqo7546CgAweXQf7XlTVGStfJMTpO0Apu/nv2apttW/XdlFS1/C+5XkAeCy6V8DAFz1zRti3fzoPTMAAI/PvJen/P4AHo+k2a8iqfJLYjiBU3QnLQcgRW0EV6XUnlO2MUzPn6CcROWHkOpq1Cx3wbK3AQB/W18ZmpiOkPRzDx0zFgCwZumSPAA8vHyFdp3KbkI6xbWjRjLfXJCvdt07gCfTNJsTXKryE97HfO6vb2rNJ1ImKjqdQCq86XxanNWvWw4Axt09J9SxqHiu0apSkeVTmW+et7ykfG1RLfLRgYdcs8wH+eaCfCMTS+Wn4g+bOEb7a2LVQnXfqkVLUZzPtaNGhv7/8w7gyTTGVSH+ZdpQ7fhXz68B4B4F4v1rg/tKheX/bPrQ0OtUfqaTzx8XqYQvb94BoBDtkYpvqpvXtFNtn31H3fpDPmj4efk5ify8JphO3n/zvOWxagBUcqn4VHYT0imYjwnvAJ5MY3QAKimjOPzlmxRWnqcSsA1ggvFi1q0lsi3Cuq4N+fymcmWcmmNuTErIOP/dwbHNCQb1aA8AWPZ2MgcYWKuicut3q/v5+fkcLQX7HWzRJ1tPdVKo/BtWuq2ObWsrEO8AnkzjvDq0VDpTHNwhPq1RpMCh+wO4RqEeWaUMRLYRVmxTCsoeUo4SNSk/R1tSyZjv1cPU40kFXhz8jXgfiaJfsgdWOlFLOQE/P+ldfXIOALYceEee5z/zxffxvSVFKn9FdbA/wQGxP0F1FdNpD2xzAu8AnkxjdICQOH6sjEvtR3CFCjh5tDr+lYg6FRxBRYm+PUfvCSRS+UlhbI06b3ICMqBLh8g2jQ3T2BtT28e1TZQCOaCg9BEOQMkvaRQnofKfWFGhKX/98rlauhGjztXS0Qm8A3g8EVjbAFRwWx1fthFaSplc68JFoxSd8qXy0xGkE5BHVuk9vht2NUV7ElV+TaNi+flM75U9wK49rgnIA0C3KvW5pFN2U1Vw7DiYjvLLeP8/Duv7E1DxJUXpQvOReAfwZBqjA7BHt9Q6PPNxpWgOcKznKIwFGhp6npjGp3PmVl3DCq0tYHYCaOdbCukEaSs/82HPrYw+PbIqH6rwO4KgjIz6xH0+zuB6fOa92nyAovi/k8MMGK521eR8ANPMMO8AnkzTzAE4bp+jN6UCxMV1Zhgxrf5gG4tE5ZFRoLoGVb5tbi7Pm5xAUtmmQkvX0pSrzs98pBMQ2/8HORo17vNRoU1O4IpN+Yl3AE+mMUYqTOPCTevtyPV7ivKJq1CRM8RMTiDbGnGdR+KwDk9Z1lRqrSvgFY1JinyugbXqfXPsUqkkXR3CpvzEO4An07S6leFsq0S4jjVKqvyebOEdwJNpWp0DEFNd+MO25qfng8U7gMfj8Xg8ngzS1Aa4ctKpAIBZC9+U8dZU17S8ctKpuaAcp5urO6h4/IH9ejy+ukOt9lym6wf2fzjWye9U2x0AsGd3Q2g8vFNt91xwvQWf6vjHtwE8mSYnlT8/+4vqwuX3hd4wqb+KwizcpPf4ms4Tma90AluPnxz/bZoRZLpOXHsIXbE9d4rKrFZYM4yDL/q8rTayF4eOXdX+0Ht3xtsfOiSfXJBP6HXvAJ5Mk0OgLFToQ/PUzupV925G1HmT4h78Wj8AQOXUi1UBgeKbztd2Vmtu7m7c4TTqz7YuDMeBm3AdJWhDKr98bj5nisqsj7EK3n+I06VaDvn8OWfkAODXL6yOVOQbzxuqRhM/t6bUMVR5ADjj7BEAgIce/JXjbYrrrv8XAMDql+ojy/UO4Mk0RgcgUvGpsFKJ5XnpCEQ6AHFVftfyXZ0AMRXz8tPU5NfZbxx0cqyk5YSQB4AbvnwLAGDGz+8CEOoEqZST3/Q/2slc/38GYP4+m9IF3yv/P8nztucbM1Et77F00bI8ACzfVKddp7KbkE4xqv945psL8tWuewfwZJq2jMbkLr9Pc4KRt78OALhs+icAmBXXBJXxrL+q+1bcNghBOQCAM/qelAOA1W+9G1pXlEpuK8/0XK6OYIN1/tlvqDo/lfBaQzfDnz55FACQm1lSsc349TSOblVOsOTl0vYDKEL/HpaqUbf8vm792e8AAJU9F+l3jdFH6976s4nBfZ8B0NwxisoJdQKp/FT8G756vfbXxAuL5gMAZvz0QRTnM6r/eL8/gMcjacs4/JRhvTQnYN0yroKa6uhUEpYzf9XWyHxYp335n17Xzl+7+xORz/Nw7Z+146rlmyPT2yjU+fVoT+VUpfAPz/uz9lwk7ud15fPPq5lZ97Z5FABwFgalki+R/TVUfq6v8+8TJ+o3PLFDO2Q63lf1lc8AKDgB25Q2qORS8ansJqRTMB8T3gE8maZpVQipUFLJXZ3A1Fagosty5Ox/CaMMjE5R4aXiSuVvik7cq5SsKBqjlWvqB+DYm9lvNITW+T/5p3ZBufp9fI5gobTUlJ+wDfD5568KzqTTBpA1AKn8hffnGvVS6aQTnN27fQ4AXtpyJNbzUfn3vbPXKZ2trUC8A3gyjXVtUCo4le2sv+rnCZWfdXap0CaKFDh0fwBGo1bcpsebWfcmMh7N+4rQ8jcpP0efctQl20KVUweFlis/J+u4l5+m1rGf/Ya+jn1cuvboDQDYuX0LgPK1AUxOJXvOTU5NZLphE3+nXS9V+duc2CYHAMf+cUxL1+bENkyXL77P5gTeATyZxugAss5/1l/dlIbpBgzX84lL5y6qTlq/fG7gBPp16QhS8dnmYD6Nu6x18TxQmD8gxzpJJ5I95lTKrj16B8q/xVZeJHKULqNPjPunHf2xcXBf02jKyJ7conSpQOU/oe0JmvK/9foGLV3fQQO0dHQCG94BPJmm2a9ZzsCSY10KbQFdgUx1fypjghlaWh1c9gfI8tnTTKjYMcbIhI6JcnW+tMbimOZnMOokSXvU6dBR4wAAa5Yv1r7/GGOaQu8bOmpcLsjX9gjaKNCQqI9T+aTm5I4AzKNCvQN4Mk3Ur0lTYFMPr8Q0KtRSlrF8uT68dAJT9EeuD+9QfmidkfF/6QT8XGmNxjQpv2xr0GHl+017TnDETLdY7zHuvAs5EyzCCSIZdYFa1fsvP/0T8w2dGeYdwJNpjFEgKgqjMISKI9sGsqc1bWUqRKPUsXQCqfwJ0HY3lGNiDgYf1+QEpX5Ok/LLNlW5lZ9E9M/YcOpvMUGFpmKvfqlecwJXqPy9TlNRua2GqJx3AE+msf66TevR2FZhKFWZTHXQkD2jAITW+ZlP3Lm/TqtaVFbW5ADg0KF4e6DZyjXNMGsp5W9tJF0dwrYaBPEO4Mk0sSMWtpXayrUSW9GYmFCllD2xHDtTKlOG9QIAzF+1Ne0V8zRcd0LJivK3FN4BPJnmuFtFzKSUaa/45skG3gE8mSa2A1x0pvr71Kt6tOSiM1VeT72axmN5PC2DdwBPpnF2gEFd1Yyb13ceywPA+rv06wNvaUqXC9IleqDRvdWox2VbjmoOUxR3j4ySmNJ9WBzK7xOQLt4BPJkmzAEiFfYXV6ieufPP0nvYnn1Znf/SY+E9bzYFlsrPcmR+pvXxieyRplPRoaZN+WgOAJ6f/7fIfFz5+CUXAgD+8sTToe9t0lnj1b4JL9eFXU5Ci+wTcMU56u9jL0T/f7DR2p3XO4An0xhHg5rq+ISKH+P+0LUZJ5x1JQDglZdnacr/TNWnAACXTVfpLjj4ewDAfZatxVjuzfVfC/6q46XzzgcAjJl6aR4APn7JhTkA+MsTT0dnaEAqf8PWdaHpuvcarCloqeWSiPkIJSGV/+ii8HSb/+qWH7/3GE4Q6jgnjByRA4D3V9RHtwHPHKnagK+ucNqfwDuAJ9NY2wBUVFnHf/gxlaw6WOblE9eqrGQbQTpHSJn54vxGj1En592sxhzRCQidgMi2CJWf3Pa587XjvkOGAAC69xpsep5IXJXfRNJyiyj3PgGhyj9ri/79rF2o/h5oD+38MrWQHCZs0Isv+n/gNqPs+d/qZ6d9FgBQM/ES7XTV2cO14+13/hAA0ONb3w49L8v3DuDJNNaV4Qq/XF35+Ysnf35YnacT4DH1J24dtd0f+QNVTiLXJ+p1hRptuvUxfVHOVwYExlX/de2+z31T/X3uf37hVL6JpMr/1tq1JZVr4junBtb85dT3CdBwVX6eR3B+ZS913/Ctzkak1Tx6PKPeG5V73OixAIDNUvEvGKIdj5ur0i0O7pOOAbE/gXcAT6YxOoApzsw6P+t6VAAqgi1Ob2JPsMzys9DbGr+4YgkA4L6VKt13V04DAHz/W8oJXgnK/e8fTNPym32dcpyQNkgs2D/RWpRfMna72hNrCca2SHnlhnV3qfxb3lEr+/Wb+7yWXh4zHe9bvOgJAAUn2BccE+8AnkxjbQNQScnld1KB1S+PTkAFbpb+oWhHGN27XQ4AvvRY9JzPL566RDv+7p3him+iKPriBOcdLAvmHTC6dd4/fwmAuU1B5R8zVe2dtXTenFjlHu+whsAagSvt+vbLAcD2O3+YB5or/9atbvssyHTSCdp07KLWGN27C4B3AE/GMToAoy7PvqyUl3Xy9XcppX1WRGFmX6fH/amYcocYybItR/nP0P6B+95Uv2DpADyW/QCk4DyqXCoxlXno4IFqrcp167X7TDvAnz+Cq02ocukE5Df33KTlL5Wf58eMGK72q61fGfrcJuQ+Af/5ZvCiewQJ3kwnCjR5tPoe2k1kf4D6WmYtDaJBk1Q6Rn2a2oLiPPsB+P9hwkCV7yv6627i6Fvhe4dR0SsqKnLBcWRNQabrfXIv7TqVn3gH8GQaowOwx9U0ulOeX39W+PVfXKHyeTzmg8n9Ae6D3paQjiDbGnQcqcRFThA6NkkqP2EP891n6U5Ah3Kt88dV/sIMPH01jHLF/Rcss6cppllUMHAC/FFPZ1J+V44da5pfEtmxUJTOCe8AnkxjdAAq24hR6piKWhgFGj4fgOfZH1AYvRlvtGLjrq3auHep+Hw+5t8s+hQ4RtrRmKaxRsE2kNwJJ63RmETOvS6McmW54Xu0pcUV58RrC9AJ2JPPun/c+QAn1Z6UA4DFy5bkAaBXL1WHL6r7RzrA0aNHtfsWL1ui5fvu7ne19N4BPJnGeZdI/r0vUBr20BIq8mXT01WmQrn6eRkFkm0AW/TJhNzl0LRWJ1eiM11Pikn5yd1BNIpOVK41Qx97Qf11dYJSlZ9QoV2jPiZk9EgqP/EO4Mk0zepTctUBuUMMMa3OLK+XoExaDyyh05iQbQEqkikuD0Od0tQfQOQq1MTU1rCVV0So8rONxfkRLb1atG2mWLuJ6m9rnwMs8Q7gyTRGNTI5gSulKpNpfSA5Z5iwbixHf5qU33V1CNNapCGrUOfTKA+tfJ8A02oRbCuw7XC84B3Ak2kS7xDjcF+qyiRXpjPtUGOrg6e9LhCZNuWjCPLNi/OxyvP7BLQs3gE8mea42x+gsrIGgH2NUEm5lN9zfOMdwJNpnKNAcUl7x5bOgysAAI3rDkevDNalrVoZbNd7qZTr+XDjHcCTaZo5gIxCuMb/ZU8we0pLdYKOfU8EAOx96x95AJh4S6/I9Ivu2sr7csF9icptrXRur2biNR7ZHemEndurXTsbj6S7a6erE3cerMbgNK47nGr5aeMdwJNpjGuDmnZkdyVk5/bIiJMt/k3lp8KbsKVLu20yoptS5Pod4Yp8aqcOOQB4c8/+VMpD8P2M7z4yMlFdwwr+M5VIn1R+Vydu21U58Xs7W6cTewfwZJrYO8SkXFazaBOd54VNDwEAzhivlMem/BIq1Oo6VQc9p/91AAqOVGpPqlT+u6eqqXNrG/dp6e6vb3KatPpctO/H5ARpOYBJ+c8JNrx5Z1+Vlv7kmoMAgJ9Cvfe9CxoBtF4n8A7gyTTGGWG2Op4rNuWWo02p/GnDfItWq3aaYyqhItav05V/1pjtAIArl6qFeqQTpA0/R13Kc5GJq/L/Znl4W+pzo1Sb7o+T1fHeBY15wMkJQmsg51erFd2ePbArsoZyXYWa+/vQ4Xf9DjEejw2jA7DubIJ1c1u6IiIVl1GjDZv09W6Yv4zuSIeS503PlXSucFOdP1D+pvKD9XDOfE4p4vc6bQIAXIPOsfKPi+x3IRPeV+UXtT1iEVf5Td8D+SpUfj+drN4HnQAW5327+zDtuE/DqjwA3DpovHb+S3sOhKYLuT+0HO8AnkxjXRWCrXjJanSOvN5xcrgCtumkijy2J3ysDqM1sv9hUbAmKfOVCs/zVCDZg21STBumOj+V/3vHdMW/Zo/6SwXuWV2ZA4BtBw4lKt9Gk3OWuPpGUuWPUQOwoc/861QNALjjdfUAXOX5S2/ris90ZFwfla5PsB5Qk2MUgn1+hxiPh1gdIC06GuqAch0eh/udyqlfoNfxZZ3f1iPM/onGdQ2aIn6vTin+/23TH0BB8f/QqVE7Jmkp/8DaDgCA9btVj3L3V58CADSceVEq+bvG+YlUfn4vjP4khYotlZ/7BHyyj4xOvq8dyR1i7lhWF5ov8Q7gyTTNWuJtu6rRl+/tVKMvTXV5/uJt10nIGB1TFCC0XKmsQzrXaMcy7k5FDnmeyOiDaTWMT9Wq+xnvpwLK52LdP60xQHKMlKnH+ZUTlCOFRIFc+zmc6v78XmQPvVT+uD3C/YKZfpuDmX6mHWK45qcJmY77A3CN0H6VNbmgHADeATwZp1kbgL9M/lKL6uwa7U5uH3ndtc4uadOprZbvjSOUslDRqTx4Tv2hE/AvlVFGY5ivKfpETCvi/T6IsnwqiP7MGq+c4A91jdrnZNQnbeXnGKlHnnkJAHD1MP3zUvnTRiq/jaRjgajIkrR3iJHleAfwZBpjFKjolxpahzz6zhF5Xau729oIJqRCU9mvCYyEiovzggQWJzDla0P2G0gnqL9L9VhTmR+HGmWaVtTHtCZprwvOBmB2grTbIBJb3b9co0D9DjEeTxlw6QeINT+Av3zTGJHuZ1blAKDh1YNO+VHZkjpBXGz7AyQdS5Q2R3p3AQA8skrteljXkI7yN82fCMbwEH6vixaoY6n8f6zR20JJld/vEOPxtCAuMeLI/gCJaQZXjH4ArVxGYxjlkHV8GR2igg3Yp+LlRUoda9x/3P0B0p5rDPH5TfDzlboKhKn/53/ti/7e01J+SUWF+j4PH262+oTT/5uifHJBPqGJvQN4Mo1VFaUyuCJ7DInruj2mHlmbE0jlL3Xub4z9AVLFdWW+tFeJdh0JQFr7nF8b3gE8mSb11aGLxvtrymUaQ2J7htayP0HWcHX+41X5iXcAT6Yp+/4AJkc4XtaO9Hy48Q7gyTStZoeYQRddCQB4/alZoXXOPuOn5ADg7br5kfn0GT8FQbrQfKZceWUOAObPmpX4WT0fHrwDeDJNkwNIBTYprkmpB12klPX1p3RllYos08n8bno9POjwo0G6WbVpe6J24th7erSC+XxCTFGdmlO3peUEtlWt045G2aJiPvoVD+8AnkyTMymwVNzhV9+YA4CVj9wfqtRML9MRmW/3YWPUqNBVSyOVf8G/zwMArHtmunZ+/269B7ZDbW/tePAFMwEAk38wFYDZCZCwHWQbKyR3dE9aTgiRY4TKUB4AYMqV6v/J/FnhbbSidGVpY13YX/X8P70penfQC/urOb9Pb3Jbm9U7gCfTtJXKT8UlRcqdKB0Vn+lluqRIxW8ppGNK5SflnjfAfItWuy5LOVL55+Wjv7apOfW9puUEUvlf+/TpkelPf+C1fHCfkxN4B/BkGuuMsBDlBgCMvvoFLR3PmxwiLrz/2Lo7AADTLr1cu/78nNnasby+YeUdQT7BCUNbwBXW+aVjbvz+10PTb/7HJ4N/3Rt6vVRu+PItAIAZP78LQPmcwFX5CdPRCVBiW8RV+QnT0Qls5XsH8GQaowNQ4Zc9cg4A4Ng6pTBUGp4nPD/vqmkACkokncKGVP42g28FAJzy3alaumnivlO++xMABYW/+Ro9H+kErtT2Vf0YWzfN1+r8LOfPQbnSCfh+OnQbkQOA/TvqY5Vr4/qf3akdL3l5uSFluvzZMuEtqcO6suK1dpHXR55+NFZ+3gE8mcbYD0All+vP29bZl+l4PPXR5wEU2grsaSamsTu2/gEyWSg7lago3q9h6rkmMvpBJ+t34p+0dKcIB2Ddv8gh0x5vlQcKbYCa/62cQDpvqeV27aGibDu3b4nspzHB7znpzLmu7Tuq8o/szQPAHyZ8JNb917zyd+aTC/IJTecdwJNpmlRCjtkxxbdNTmBzCK6i4DqqE6LHU+ZL5SWyDp60J7a6g9oL7MD+3Vr0g3Vf6TzSEfg5a/uqz7n7LevnjIv2XA9+5VsACm2AUh3A1MPN98k2mQm2ufh98X24rprRu0qtd7TloNoN8vJ+kwAAbx9W60id1+nEyPuf26NmpvWpUKtaz968kPnmgny19N4BPJkmTCU05ZVxZZMzELleTkg+sdarlwpETA4krxc9T6z1ZExjbdiWIXQellOu1SJknbyMbYDQ9y57nk3IdEm/B6n83Pl+fPeRkTfLdNIJZPneATyZxtgP0FTXEw5gawNIqJj1g0oLhrgqfqnIOj+Vten6VbIHQidt5ZfRKCpzU9z/5ejnKRW5vlL98rlO6xQxXanfCxWdK9/VNayILF+m6xM4iQnvAJ5MY3SApuiG6MllK9+EjBebxsq4YutXYLz/ptHh/RZxkf0Gsl+EuNaJk2IahfnjT6n36erAaZE7oel7jbTyonSp8n6+qYc3svyidE54B/BkGmsUyFSHc62DlzAzKjQaxWMZj6YzRYyTj1Vu0ahGAM2dQEbH0pqLa1J+OQaHzirfb9proTbtgBMziiPvK7UfwBTFMZVwSKfRAAARaUlEQVQv7/P9AB5PCM1+TaZVmWXdWiqgLV1cZTKtfmDrF5D9EAkUMbQSKx2hMthv9pBhd8MSCFV+W0932qtBRKx2Eas/Jem+CdIJkpZvUn7iHcCTaYy/JjkmRtapqzvUavfa0h3Yn2znEiJ7QiPSpdoTO2KKGiNVP7/ZaNVyrarnNBarXMqfNbwDeDKN8x5hxKQ4ESuWtZr1R48HbCvNEa/86eAdwOPxeDweTwY5burnk0Z0BQAsrN8ZWTe+eFyPHAA8uXh7CzyV53jHtwE8mabVO8DwgZ0AACvX78kDwON3T9auj+zSXjs+5TPPAQAmnn5SDgAWvfZu+R/yQ4CrwyJmT6yktTm0dwBPprE6QLfuPQEAOxq2xRroPWDg4BwAbFi/zin9xeN6AACeXLw9tBwq//W3r4/MZ+WP1JggOkFIOakq0NjxEwEAS+oWhT533PcQA9P3EcvVpfLzPV928wIAwMbfnQdAe59ODmDLJ/b3MHmc+rtgcfT/w8njguXIFztl6x3Ak2mMv2ap/B879xIAwMAhbqv0ctVimwJKBaJSkBW7jgCwK7+ETiBJrEACqfwzHnxEu75woVIgvgekvEMM4ffy4twnZLpY8x9siu3apjK12RI7ilT+538b/WmmfZb3OTmBdwBPpmk2J7hU5SdF69er1QEMTiDrnhIZ5XGFziHvL1KgROvXuyp/uSl8DqX8UmnTZv/R98uSrxVX5SdMN+2zfn8Aj8dGMwcoVfkl0gkQU3Gp5A/eNhBAoS0g6/jDb1qtpUubAQMHAzArv2T92tfK8hwSOgHfU1yGD+yUA4DLbl6gOTHr6EXOki9Ov3L9HpkPgvOptikkPZ5ZG3l9+wVDYuXnHcCTaax7hLU0JiX70ZNqvXgqvEzH80x308V7I/NzhW2iDevXaWtySmTdn1GZ2lo1J3X37vA5qUm5vW4EAOC28aXtPCOVXEIFl05gyse1LWJT/p491PySbdvVfAeb8hOmY2xP5iPxDuDJNFYHuHRgnXY8Z/340HSs8/5uuq64VCoTsg4qYVuEik6FN8HyPzNTpQuJj2vlmhSw0D+ht4lsyLp/2sov4fsttc0xaUTX0LYAkXV5E6zjy3Su/S+n9u8HAHhz0+Y8ANw4/ToAwPK5aiXA1048ObL80//xDgDgE8F99898KB/kmwvy1dJ7B/BkGqMDUHFlXe7xu9VfqcRUXjkGZ+Pv1N8ZPw8vRypwyEpgAArOc9PFddoxYV244Di6It46SKW/4/W60HKJHJNEJfzRk3o6WeenAtNxunXvmQOAHQ3bQsuJy8TTTwJQvtGtC+t3AmjuBITv4Vd3qPcmd2K5qqdaHymkpxeAe897M+Vfper0i5ctAQCMGz028n6mIzcKJ4DfH8DjKRA7CiSjAuxpNY2+LBXZD0HlZ9uE5cu2Bu8ztQFMUPllHbbQBgmva8uoT1rKLx2Jz3V7nfmeUqAToKCUmhNQ+b854BgA4J4NageXvzdWAgAmNs+ypDFXVPSTalW/weJlSyJHg8p0o4ZF9wt4B/BkGqMDsI5viuva4rwFpaIyp+MQVP7F9x0GAPz+yHsAgHu+L9sA6UKnoRNIXgyWSk0r6mNSfvZr8D2YonLl5p4NbQAUnODRbeXtUmpzQlPVPXIkQVE6J7wDeDKN9WdLhWH0J77ylwajK7ItsOaIevSh7d+LvC8ujFZwtKhsC8g2jy0unqB8AOa2iKTc0ScThTaAcoLzOoV/D3FhvJ5RG1sUR7KzsVHep+Xr+wE8niLC5gPkAODFuU/ore1gkKWpTSCVSiqTaT5A1/aqrbHzSHjdWkZf5kA50qe+wShQNYDmPaJN/RL6NgZN9KusAQBsFuv7M1phcwKS1gyzovIjZ8YRttFaWvm5U/s9G/R+gI905nvsVFL+VGjpBHGxKT/xDuDJNM5zgiUcS9OhnfoNLXrt3dB0Dsqk7elE2BMs+xs+M1P9lW0CKj8dQ9bV2RNM2CMMS53StFpFGdcdinSAllZ+06oRppl6aTtiufEO4Mk0rWFluFAHINIJXKNQJuUnrg7Q0tjWRyItVecnH9a1Wb0DeDJNa1C/SAcgdAKmM8X/qewm5Zfp0DregecDwjuAJ9MY1e/jl1wIAPjLE0+XtE/rxy+5MBfk45T+snFTcwCwa5Oaw8n+gTZV7QAAK7e9GVkHndR7QA4A2hxScer+Qby/oq+qW/96UYvt9ug5DvAO4Mk0zdRPKn/DVtVz273XYOM9gtD7IpwgNH1NhxqtnH3792ljPEywB7BnD7WL4v4Dh7T7E3ye1koqq0NLpk35KADg+fl/ywfHueD4A8lnzIjhAICl9Stj9QiPGTE8F9wXmc47gCfTNI0Fsin/ReefkwOAp559ITJDpuvea7DMJx+UE+oEb61Vcz8551PO/OH5h+e8GFl+yOhB7f60sSmUbSxKAkI/V9Fc2EQr8BEq9tJ5cwAAY6ZemgeAC86ZnAOAZ14IX72DyHQyH9fnku/1l3f/JwBg7OiPRN63ZNnfAQBfuPk7+SCfSCfwDuDJNMW/Rk2xCZV5zNRLtfOsY5Nt2/Ud4vnL7ztEn5MZUvcOVZQi5QBQULo1b0b3fF576ccAFNoCMp8QEimlSaHI0hWrtOdIWk4IeQD49KVfBwA8MOcnAIDRZ0wBACxbPb/U8jTlJnx/8nNKvnDzdxB1f4zniqX8kiIniCzXO4An08SeyGmqY8sZOHGRdVkqhlwfhgov2wJDT+0Zmp9U/lKf01X5Wwoqf7n45W/+oP5alL8pfZCO933hc9eUVD6V/45P/xeAwgiAy++/TUs3+8bbARRmCt76wL855e8dwJNpjA4g6/4y/m6Kx/M87zO1BSRcv0Wu40LlJ1R+OoE8L++39Ru4wjUrTcovkc+dNu1r1eoTHxmoZsL9fX1pq0QTRk0YtWlS9BnPaOVN+pi+RufCF9/RnuMLN1yAIB8tX1tc3gSVnwovsc0RN+EdwJNpmv2cpPInjZ/LOriMCkhsiinXhmR6Kr6M/sh0STmpVq3JKdeslMi6P5+XPdr79u9rflMK0AnaVBxIJT+TQkunkQ7A80znmq+kaKcZAIVojqzzS2Sdn/cR09qq3gE8mabJAUx1P/Lrh2YDsK+1SMX9/HWXa+dNdUEqpG3Nx5Aez9BjUzqJTZn79zwNALBp2xv54nxtSMdJS/k7VCll3H8wekeXtMuhs0362LDg78naecI6P5HXe3TpDQDYvmtLZPnN9xiz9iuEXmf837YrqHcAT6ZpcgBZR6PiU0npCDwvFV6e5y9QKqcsRyrk+O4jAQB1DSsAmOvcpmiRjCaxTXBhxysBAE/vnRVaLpHKzx7X1Vv0/Qqkwsl17LlK8bu7S1s1Qj5PueP++w/u0crh+/vlSPX9h/RwAwBuRBD9GzlMu17UY51ojFKTggvFZ02i6bgw1ki7z4Z3AE+mce4JnvHfjwIAPv+vVwHQxlgAKDgE06WFSdkltv4DV6TykzN6TwryXdj8JjSP+qSt/PJ5lixVUZexY/qUVI4Nliu/bzkWrGlkwEx1nJZTcXWP4aeo97pyo3LukKhSLkjH+5zWVvUO4Mk0RgeQiloXKNwNuCoyQ9bdWfdnPraojKSpLSDuc41CsTzW/dOCTiBheaVGfWzKLylX24NwtGmXTkrxd+1Rc7VD9t3NAUBVRQcAwLLVau61qV8gLofeS7REqBXvAJ5MY3QAWfeWmOLiUvmT1sVNTmLLTz7v08tU1MfVCfr3PC0HFKIWJgWmMtoUOi425WePK3t+y6X8kkNHDjqlq2yvVos+eHh/onJM+xWb9pGWsI0gVwg0rVjnHcCTaZrFZGs6qFa0aRUGkzOYzjMebOp5rWmn6oz7ju7PA+79AK6Y+gE6t+mWA4DGYztC77PVxekARelzQfqSnhdixhdpKeWv7dgNALB77w6tP6BoppkTcsZa3PdjWpVaUuoq1d4BPJmmWRtAKrStLWDCdUyMVH7XfF0dSFLkBJE9k1Qq2SYgPbr0zgGFsS0pKH9keZJy1fl371WOWNtROSSjOaa4vozy0KmSKj+x7Vxvw3WVau8AnkxjjALJHbeb5uqOODN07ybT+bSUSsa7pdLLfoa4jmWiSLk0p7CNaky7PEm5oj3E5AQSU9uA95XqjCE71zvhuj+BdwBPpmkN62JGtgEYDSIySkRklEeelxSlaw3vwPMB4R3Ak2k+cPXrXa1mGFW2qQAAdK6oBQA0Ht4NANh+SNUBq2vUfsDvNEbvnTW47xk5ANi5VdVh+52oNjg+uV1fdf/RtwAA+99X+w68cWR1Kp8ja0zsqHp8F+09mA+Oc8Fxi5TfPtgl9Mja1/LBcS44jpWPdwBPpvnAHcBGj+5qZ5ftDUr5P33t9QCAyReHr/V5w/VXAwCGDFVOsHbNh0Phq6qCMTYHD0Y6YFWVUuKDB8ujxFL5Hx2u1ku6auVmXi+rE0jl7/GtbwMAtt/5Q16P5QTeATyZxuoArsoTcl8sJerfTynJps2bQ8uh8j/w8IOR+cx48BEABSeQjB0/MQcAS+oWOT2XDdv7SVGR8wBwSv9TIhNt3LSR/0zV3U+uVJ/znUO68kvoBCdXqs/9zqF0nKBtZ7X263uN2zTll9AJ2nZW+yi/1xi9mrh3AE+mMaqEVDYqz5SP/lNkhvP/9lcABSWyKaBUfio982F5NuWX0AnuuuMOAMAtt94KoOAMpTqB7f3I94DSFVlzGJMTpO0Ass5/UV/1fX22U3j63wbLFj31VjptAlnnr5l4CQCg6uzhoekPvqTmCu9b9ATvj2wTeAfwZJpmY4GSKj+R6TZu2pgP8g11ApPypw2doKiNkGidGulYpvfD4yJFTgVbGyctbNEeQHcCqfxF6RP1E9iiPYROIJW/KH1kP4F3AE+maeYASZVfYnICxFRcOoKMAsn+ACqirPunRUV71VMtHUs+p2wDlAt+TnL7rf8KoHTHYQ1AKj8xOYFU/pD0kTUBWf5BofzE5ARS+UPSh5bvHcCTaawrw0klc40CJcWUP5WfzsRy6pa/CgAYOvRMAM2dICmyLXT4yGGtfOlEpuhPuXtm00bWAID3Q9MxGkTl57EJ5merCcjyDxnyYzSIys/juOV7B/BkGqMDDH1f/fLZyv8/+9RvRdZ1iVT+/1ej7md0YKOhnP791E7qDzz8YGRPc1o9wcTUDzB2/EQE50N7XuXnlk6QtvIXjYUCACx4Uq2DbxoLlTb8/mS0Z80Junby+Ld73g9Nn1RqGd2R0Z4u24KoT5COx7teQmj6SkP+3gE8mSasHqYpn8kJTEjlpzLE6KGMHPNiaiNQEU3RnzVrXo0sXyq/Kcpieg46QY/uajUCKnZS5PPIqBPh5w6JAiXqCTb1A0lYTlHdGi7pnaNALVS+dwBPpjE6gFSchpcWADA7gVT+7mfrK3kV1d0jlYnx9sNHDjs5gavyV1VVB798426Kocovo0omJ3D9fDZMTsS6v4m0xx7ZRrmalNfUDxG3TdRS5XsH8GSaZiohZ2CZRjmaokCmeHiCunFkFIb5V1Z1BFAY7SmdwFb3l+XJKJLpWFIUdUpl1KepHOkE5e536NK5MwBgV2Oj9n2wvA4dOuQAYP/+/aHXu3TunAvub5XlewfwZJootYocn28iYhx/XGWMHHND6ACETkBcldlU9zY5AQk5X1YHIDLqU8YeZ+174PdZ0b4iBxR6yGXbLaTfJul7KWv53gE8mcbYEyx7aGVdXPbISqXmdeazafNmxIFtBlm+dCDZI8o2AOv+rqtDsEeYPcScL2BS4l69+2jpWooWVP5IqqtVlIYKLI+Pl/K9A3gyTeJVIajQhFGjovtSXQ3B1BNKpBOUWieXbYIQyrKmkkO5AFpO+U1ztk1jsuT1pDWAlirfO4An07T6leFs6wWZSHv9n6xjUmJJWsrfUuV7B/BkmlbvAJ7Whc2R01b+cpfvHcCTaf4/YFLepbrosbwAAAAASUVORK5CYII=';
var ICON_COL={hlm:0,arm:1,glv:2,boot:3};
function iconCell(slot,tier){ var col=ICON_COL[slot]; if(col===undefined)return null; var row=Math.min(8,((tier||1)-1)*3);
  return 'width:38px;height:38px;background-image:url('+ICON_ATLAS+');background-size:228px 342px;background-position:-'+(col*38)+'px -'+(row*38)+'px;image-rendering:pixelated;'; }
function slotIcoHTML(slot,tier,op){ var st=iconCell(slot,tier); if(st) return '<div style="margin:auto;'+(op?'opacity:'+op+';':'')+st+'"></div>'; return '<span style="'+(op?'opacity:'+op:'')+'">'+SLOTICON[slot]+'</span>'; }
function itemHTML(it){var pl=it.plus||0;return slotIcoHTML(it.slot,it.tier)+(pl>0?'<span class="pl">+'+pl+'</span>':'')+'<span class="v">'+eVal(it)+'</span>';}
function findMy(id){for(var i=0;i<myInv.length;i++)if(myInv[i].id===id)return{item:myInv[i],loc:'bag'};
  for(var s in myEquip){if(myEquip[s]&&myEquip[s].id===id)return{item:myEquip[s],loc:'equip',slot:s};}return null;}
function renderInv(){
  var cs=document.getElementById('companionStrip'); cs.innerHTML='';
  var petChip=document.createElement('div');
  petChip.style.cssText='flex:1;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:8px;text-align:center;font-size:11px;color:#c8b48a';
  if(myPetOwn){ var pt=PETTYPES.find(function(t){return t.id===myPetOwn.type;})||{icon:'🐾',name:'Đệ Tử'};
    petChip.innerHTML='<div style="font-size:20px">'+pt.icon+'</div>'+pt.name+' Lv'+myPetOwn.lv;
  } else { petChip.innerHTML='<div style="font-size:20px;opacity:.4">🐾</div>Chưa có Đệ Tử'; }
  petChip.addEventListener('pointerdown',function(ev){ev.preventDefault();
    document.getElementById('inv').style.display='none'; invOpen=false;
    petOpen=true; document.getElementById('petPanel').style.display='flex'; renderPet();});
  cs.appendChild(petChip);
  var mtChip=document.createElement('div');
  mtChip.style.cssText='flex:1;background:#1b140d;border:1px solid #6b5636;border-radius:8px;padding:8px;text-align:center;font-size:11px;color:#c8b48a';
  var curMt=myMounted?MOUNTTYPES.find(function(t){return t.id===myMounted;}):null;
  if(curMt){ mtChip.innerHTML='<div style="font-size:20px">'+curMt.name.split(' ')[0]+'</div>Đang cưỡi'; }
  else { mtChip.innerHTML='<div style="font-size:20px;opacity:.4">🐴</div>Chưa cưỡi (mua ở Thương Nhân)'; }
  cs.appendChild(mtChip);
  var eq=document.getElementById('eqrow'); eq.innerHTML='';
  for(var i=0;i<PAPERDOLL.length;i++){ var s=PAPERDOLL[i];
    if(s===null){var bl=document.createElement('div');bl.className='cellblank';eq.appendChild(bl);continue;}
    if(s==='FIG'){var fg=document.createElement('div');fg.className='figc';fg.textContent='🧍';eq.appendChild(fg);continue;}
    (function(slot){var it=myEquip[slot];
      var el=document.createElement('div');el.className='slot'+(it?(' t'+it.tier):'')+(it&&it.id===selId?' sel':'');
      el.innerHTML=it?itemHTML(it):slotIcoHTML(slot,1,'.28');
      if(it)el.addEventListener('pointerdown',function(ev){ev.preventDefault();selId=it.id;renderInv();renderDetail();});
      eq.appendChild(el);})(s);
  }
  var g=document.getElementById('invgrid'); g.innerHTML='';
  for(var j=0;j<24;j++){var item=myInv[j];
    var c=document.createElement('div');c.className='cell'+(item?(' t'+item.tier):'')+(item&&item.id===selId?' sel':'');
    if(item){c.innerHTML=itemHTML(item);(function(iid){c.addEventListener('pointerdown',function(ev){ev.preventDefault();selId=iid;renderInv();renderDetail();});})(item.id);}
    g.appendChild(c);
  }
}
function renderDetail(){
  var d=document.getElementById('detail'); var f=selId?findMy(selId):null;
  if(!f){d.style.display='none';return;}
  var it=f.item, pl=it.plus||0, me=players[myId], gold=me?me.gold:0, stones=me?(me.stones||0):0;
  var statTxt=(it.stat==='atk'?'⚔ +':'🛡 +')+eVal(it);
  var top=SLOTICON[it.slot]+' '+SLOTNAME[it.slot]+(pl>0?' <b style="color:#ffd76b">+'+pl+'</b>':'')+' · '+statTxt;
  var cost=eCost(it), need=eStones(it), rate=Math.round(eRate(pl)*100), maxed=pl>=MAXPLUS, poor=(gold<cost||stones<need);
  d.style.display='flex';
  d.innerHTML='<div class="dtop">'+top+(it.gem?' · '+GEMTYPES[it.gem].name:'')+'</div><div class="drow">'+
    '<button id="dAct">'+(f.loc==='bag'?'Mặc':'Cởi')+'</button>'+
    '<button class="ench" id="dEnch" '+((maxed||poor)?'disabled':'')+'>'+
      (maxed?'Tối đa +'+MAXPLUS:'⚒️ +'+(pl+1)+' · '+cost+'🪙 '+need+'🔨 · '+rate+'%')+'</button></div>';
  document.getElementById('dAct').addEventListener('pointerdown',function(ev){ev.preventDefault();
    if(f.loc==='bag')ws.send(JSON.stringify({t:'equip',itemId:it.id}));else ws.send(JSON.stringify({t:'unequip',slot:f.slot}));});
  if(!maxed&&!poor)document.getElementById('dEnch').addEventListener('pointerdown',function(ev){ev.preventDefault();
    ws.send(JSON.stringify({t:'enchant',itemId:it.id}));});
  if(f.loc==='eq'){
    var gemBox=document.createElement('div'); gemBox.style.cssText='margin-top:10px;width:100%';
    var gemTitle=document.createElement('div'); gemTitle.style.cssText='font-size:11px;color:#9a8a6a;margin-bottom:5px';
    gemTitle.textContent='💎 Gắn Đá Thuộc Tính (150🪙, độc lập cường hóa)'; gemBox.appendChild(gemTitle);
    Object.keys(GEMTYPES).forEach(function(gk){
      var owned=myGemCount[gk]||0;
      var row=document.createElement('div'); row.style.cssText='display:flex;justify-content:space-between;align-items:center;background:#1b140d;border:1px solid #6b5636;border-radius:6px;padding:5px 8px;margin-bottom:4px;font-size:10.5px;color:#c8b48a';
      row.innerHTML='<span>'+GEMTYPES[gk].name+' ('+owned+' viên) · '+GEMTYPES[gk].desc+'</span>';
      var gbtn=document.createElement('button'); gbtn.textContent=(it.gem===gk)?'Đang gắn':'Gắn';
      gbtn.disabled=(owned<=0)||(it.gem===gk); gbtn.style.cssText='padding:4px 8px;border-radius:5px;border:1px solid #a87b3e;background:#241a10;color:#e0b062;font-size:10px';
      gbtn.addEventListener('pointerdown',function(ev){ev.preventDefault();ws.send(JSON.stringify({t:'socketgem',slot:f.slot,gemType:gk}));});
      row.appendChild(gbtn); gemBox.appendChild(row);
    });
    d.appendChild(gemBox);
  }
}
document.getElementById('bag').addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();
  invOpen=!invOpen;document.getElementById('inv').style.display=invOpen?'flex':'none';if(invOpen){renderInv();renderDetail();}});
document.getElementById('invClose').addEventListener('pointerdown',function(ev){ev.preventDefault();
  invOpen=false;document.getElementById('inv').style.display='none';});
var CLS={
  war:{n:'⚔️ Chiến Binh',d:'Cận chiến · trâu bò · máu cao'},
  mage:{n:'🔮 Pháp Sư',d:'Cầu phép tầm xa · sát thương cao · máu giấy'},
  arc:{n:'🏹 Xạ Thủ',d:'Bắn tên nhanh · tầm xa · cơ động'},
  blade:{n:'⚡ Ma Kiếm Sĩ',d:'Lai kiếm-phép · cân bằng'},
  cmd:{n:'👑 Thống Lĩnh',d:'Trượng tầm xa · trâu · chỉ huy'}
};
function submitLogin(){
  var u=(document.getElementById('userInput').value||'').trim();
  var pw=document.getElementById('passInput').value||'';
  if(!u||pw.length<3){ document.getElementById('loginMsg').textContent='Tên đăng nhập + mật khẩu (tối thiểu 3 ký tự).'; return; }
  document.getElementById('loginSubmit').disabled=true;
  document.getElementById('loginMsg').textContent='';
  if(ws.readyState===1) ws.send(JSON.stringify({t:'authlogin',user:u,pass:pw}));
  else setTimeout(function(){ if(ws.readyState===1) ws.send(JSON.stringify({t:'authlogin',user:u,pass:pw})); },500);
}
document.getElementById('loginSubmit').addEventListener('pointerdown',function(ev){ev.preventDefault();submitLogin();});
document.getElementById('passInput').addEventListener('keydown',function(ev){if(ev.key==='Enter')submitLogin();});
function renderSlots(slots){
  var box=document.getElementById('slotCards'); box.innerHTML='';
  for(var i=0;i<3;i++){(function(idx){
    var s=slots[idx];
    var el=document.createElement('div');
    el.style.cssText='width:130px;padding:16px 10px;border:2px solid #a87b3e;border-radius:10px;background:#2c2114;color:#e0b062;text-align:center;cursor:pointer';
    if(s){ var cn=CLS[s.cls]?CLS[s.cls].n:s.cls; el.innerHTML='<div style="font-size:22px">'+cn.split(' ')[0]+'</div><div style="margin-top:6px;font-size:13px">'+cn.replace(/^\S+\s/,'')+'</div><div style="color:#9a8a6a;font-size:12px;margin-top:4px">Lv '+(s.lv||1)+'</div>'; }
    else { el.innerHTML='<div style="font-size:22px">➕</div><div style="margin-top:6px;font-size:13px;color:#9a8a6a">Ô Trống</div>'; }
    el.addEventListener('pointerdown',function(ev){ev.preventDefault();
      if(ws.readyState===1) ws.send(JSON.stringify({t:'selectslot',slot:idx+1}));
    });
    box.appendChild(el);
  })(i); }
}
(function buildPicker(){var box=document.getElementById('pcards');
  var order=['war','mage','arc','blade','cmd'];
  for(var i=0;i<order.length;i++){(function(c){
    var el=document.createElement('div');el.className='pcard';
    el.innerHTML='<div class="ic">'+CLS[c].n.split(' ')[0]+'</div><div class="cn">'+CLS[c].n.replace(/^\S+\s/,'')+'</div><div class="cd2">'+CLS[c].d+'</div>';
    el.addEventListener('pointerdown',function(ev){ev.preventDefault();
      var cName=(document.getElementById('charNameInput').value||'').trim();
      if(!cName){ document.getElementById('charNameInput').style.borderColor='#ff4a4a'; document.getElementById('charNameInput').focus(); return; }
      if(ws.readyState===1)ws.send(JSON.stringify({t:'pick',c:c,name:cName}));
      document.getElementById('me').textContent=cName;
      chosen=true; document.getElementById('pick').style.display='none';
      setTimeout(function(){ if(!lastSkillMeta){ chosen=false; document.getElementById('pick').style.display='flex'; } },4000);
    });
    box.appendChild(el);
  })(order[i]);}
})();
var myPX=null, myPY=null, myFX=0, myFY=1;   // vị trí dự đoán của nhân vật mình
var SKdur={b:0.45,q:2.2,w:0.9,e:5.0,r:12.0}, SKmp={b:0,q:12,w:18,e:30,r:55}, cd={b:0,q:0,w:0,e:0,r:0};

var proto=location.protocol==='https:'?'wss://':'ws://';
var ws=new WebSocket(proto+location.host);
ws.onopen=function(){document.getElementById('st').textContent='Đã vào · joystick trái để đi, phải để đánh';};
ws.onclose=function(){document.getElementById('st').textContent='Mất kết nối — tải lại trang';};
ws.onmessage=function(e){
 try{
  var m=JSON.parse(e.data);
  if(m.t==='welcome'){myId=m.id;document.getElementById('me').textContent='#'+m.id; if(m.obstacles)zoneObs=m.obstacles;}
  else if(m.t==='authresult'){
    var lsBtn=document.getElementById('loginSubmit'); if(lsBtn)lsBtn.disabled=false;
    if(!m.ok){
      var reasonTxt = m.reason==='wrongpass' ? 'Sai mật khẩu.' : m.reason==='nodb' ? 'Server chưa kết nối được lưu trữ, báo admin.' : 'Lỗi đăng nhập, thử lại.';
      document.getElementById('loginMsg').textContent=reasonTxt; return;
    }
    document.getElementById('loginScr').style.display='none';
    document.getElementById('slotScr').style.display='flex';
    renderSlots(m.slots||[null,null,null]);
  }
  else if(m.t==='slotresult'){
    if(!m.ok)return;
    document.getElementById('slotScr').style.display='none';
    if(m.returning){ chosen=true; if(m.name)document.getElementById('me').textContent=m.name; }
    else { document.getElementById('pick').style.display='flex'; }
  }
  else if(m.t==='zones'){ ZONEDATA=m.zones||{}; }
  else if(m.t==='npcs'){ NPCLIST=m.npcs||[]; }
  else if(m.t==='pettypes'){ PETTYPES=m.types||[]; }
  else if(m.t==='mounttypes'){ MOUNTTYPES=m.types||[]; }
  else if(m.t==='gemtypes'){ GEMTYPES=m.types||{}; }
  else if(m.t==='mounts'){ myMounts=m.owned||[]; myMounted=m.mounted; if(document.getElementById('shopMount').style.display==='flex')renderMountShop(); }
  else if(m.t==='nearnpc'){ nearNpcId=m.npcId; nearNpcKind=m.kind;
    document.getElementById('talkBtn').style.display=nearNpcId?'flex':'none';
    if(nearNpcId){ var lbl = m.kind==='shop'?('🛒 Mua bán: '+m.name):('💬 Nói chuyện: '+m.name);
      document.getElementById('talkBtnInner').textContent=lbl; }
    if(!nearNpcId && npcOpen){ npcOpen=false; document.getElementById('npcPanel').style.display='none'; } }
  else if(m.t==='npcdata'){ curNpcId=m.npcId; curNpcData=m; npcOpen=true;
    document.getElementById('npcPanel').style.display='flex'; renderNpcPanel(); }
  else if(m.t==='shopdata'){ mySh=m; document.getElementById('shopPanel').style.display='flex'; renderShop(); }
  else if(m.t==='toast'){ var tt=document.getElementById('toastTxt'); tt.textContent=m.text; tt.style.opacity=1;
    if(m.flashSlot) flash(m.flashSlot);
    setTimeout(function(){tt.style.opacity=0;},2600); }
  else if(m.t==='dungeon'){ document.getElementById('dglbl').textContent='🎫 Vé Mật Thất: '+m.entries+'/'+m.max; }
  else if(m.t==='state'){
    players=m.players; enemies=m.enemies; bolts=m.bolts||[]; loot=m.loot||[]; myPets=m.pets||{}; mySummons=m.summons||{}; myTraps=m.traps||[]; myCrystals=m.crystals||[]; myWells=m.wells||[]; myIllusions=m.illusions||[]; myBanners=m.banners||[];
    document.getElementById('cnt').textContent=Object.keys(m.players).length;
    var me=players[myId];
    if(me){ myZone=me.zone||'town';
      myPetOwn=me.pet||null; myFusedT=me.fusedT||0; myFusionCd=me.fusionCd||0; myHsPet=me.hspet||null; if(petOpen)renderPet();
      var pdot=document.getElementById('petbtn'); if(pdot){ pdot.style.opacity = myPetOwn ? 1 : 0.5; }
      var pkb=document.getElementById('pkBox');
      if(me.pkScore>0){ pkb.style.display='block';
        pkb.textContent='☠️ PK: '+me.pkScore+(me.jailed>0?(' · Đang tự thú ('+me.jailed+'s)'):'');
      } else { pkb.style.display='none'; }
      if(myZone!==lastZoneSeen){ myPX=null; lastZoneSeen=myZone; }
      var zd=ZONEDATA[myZone]; var zel=document.getElementById('zonelbl'); if(zel&&zd)zel.textContent=zd.name+(zd.safe?' · An toàn':'');
      var bl=document.getElementById('bosslbl');
      if(m.bossTimers && m.bossTimers[myZone]){ var bt=m.bossTimers[myZone];
        var mm=Math.floor(bt.t/60), ss=String(bt.t%60).padStart(2,'0');
        bl.textContent = bt.phase==='active' ? ('⚔️ BOSS ĐANG HOẠT ĐỘNG · rút lui sau '+mm+':'+ss) : ('⏳ Boss xuất hiện sau '+mm+':'+ss);
      } else { bl.textContent=''; }
      setBar('hpb','hpt',me.hp,me.maxhp); setBar('mpb','mpt',me.mp,me.maxmp);
      document.getElementById('xpb').style.width=(me.xp/me.xpNext*100)+'%';
      document.getElementById('lvt').textContent='Lv '+me.lv;
      document.getElementById('gt').textContent=me.gold;
      document.getElementById('wt').textContent=me.gAtk||0;
      document.getElementById('at').textContent=me.gHp||0;
      var resBox=document.getElementById('resBox'); resBox.innerHTML='';
      if(me.res && me.res.length){ me.res.forEach(function(r){
        var pct=Math.min(100,(r.val/r.max)*100);
        var wrap=document.createElement('div'); wrap.style.cssText='width:172px;height:6px;background:#000a;border:1px solid #0007;border-radius:6px;overflow:hidden;margin-bottom:1px';
        var fill=document.createElement('i'); fill.style.cssText='display:block;height:100%;width:'+pct+'%;background:linear-gradient(90deg,'+r.color+')';
        wrap.appendChild(fill); resBox.appendChild(wrap);
        var lbl=document.createElement('div'); lbl.style.cssText='font-size:9px;color:#9a8a6a;margin-bottom:2px'; lbl.textContent=r.label+' '+r.val+'/'+r.max;
        resBox.appendChild(lbl);
      });
        if(me.cls==='blade'){
          var stTxt=(myBladeStance==='arcane')?'🔮 PHÉP (+15% tốc độ, đánh xa)':'⚔️ KIẾM (+10% hút máu, đánh gần)';
          var stCol=(myBladeStance==='arcane')?'#a878ff':'#ff8a5a';
          var stLbl=document.createElement('div'); stLbl.style.cssText='font-size:10px;font-weight:bold;color:'+stCol+';margin-top:2px'; stLbl.textContent=stTxt;
          resBox.appendChild(stLbl);
        }
      }
      if(invOpen){var rg=document.getElementById('rg'),rs=document.getElementById('rs');if(rg)rg.textContent=me.gold;if(rs)rs.textContent=me.stones||0;}
      myBuild.STR=me.STR||0;myBuild.VIT=me.VIT||0;myBuild.AGI=me.AGI||0;myBuild.INT=me.INT||0;
      myBuild.statPts=me.statPts||0;myBuild.skillPts=me.skillPts||0;
      if(chrOpen)renderChr(); }
  }
  else if(m.t==='skills'){ var mm=m.meta, map={b:'sB',q:'sQ',w:'sW',e:'sE',r:'sR'};
    lastSkillMeta=mm; myPassive=m.passive||null; myFull=m.full||myFull; myLoadout=m.loadout||myLoadout;
    var isBladeCls=(myFull.length>0 && myFull[0].id && myFull[0].id[0]==='b');
    document.getElementById('sSwap').style.display=isBladeCls?'':'none';
    refreshSkillLabels();
    if(chrOpen)renderChr();
  }
  else if(m.t==='inv'){ myInv=m.inv||[]; myEquip=m.equip||{}; myGemCount=m.gemCount||{}; if(invOpen){renderInv();renderDetail();} }
  else if(m.t==='quests'){ myQuests=m; updateQuestDot(); if(qOpen)renderQuests(); }
  else if(m.t==='chatmsg'){
    if(m.channel==='guild'){ chatLogGuild.push({id:m.id,text:m.text}); if(chatLogGuild.length>50)chatLogGuild.shift();
      var glog=document.getElementById('gchatlog'); if(glog){glog.innerHTML=chatLogGuild.map(function(x){return '<div class="cm"><b>#'+x.id+'</b> '+escapeHtml(x.text)+'</div>';}).join('');glog.scrollTop=glog.scrollHeight;} }
    else { chatLog.push({id:m.id,text:m.text}); if(chatLog.length>50)chatLog.shift();
      if(socOpen&&socTab==='chat')renderChatLog(); else document.getElementById('socdot').style.display='block'; }
  }
  else if(m.t==='party'){ myParty=m.partyId?m:null; if(socOpen&&socTab==='party')renderParty(); }
  else if(m.t==='guild'){ myGuild=m.guild; if(document.getElementById('guildPanel').style.display==='flex')renderGuild(); }
  else if(m.t==='guildlist'){ myGuildList=m.list||[]; if(!myGuild && document.getElementById('guildPanel').style.display==='flex')renderGuild(); }
  else if(m.t==='inviteReceived'){ pendingInviteFrom=m.fromId;
    document.getElementById('ibText').textContent='#'+m.fromId+' mời bạn vào nhóm';
    document.getElementById('inviteBanner').style.display='flex';
    setTimeout(function(){ if(pendingInviteFrom===m.fromId)document.getElementById('inviteBanner').style.display='none'; },15000); }
  else if(m.t==='ench'){
    if(m.ok){ dmgs.push({x:m.x,y:m.y-30,val:'✨ CƯỜNG +'+m.plus+' THÀNH CÔNG!',life:1.5,max:1.5,gear:true,big:true}); shake=Math.max(shake,9); }
    else if(m.fail){ dmgs.push({x:m.x,y:m.y-30,val:'💥 THẤT BẠI (còn +'+m.plus+')',life:1.5,max:1.5,foe:false,big:true}); shake=Math.max(shake,7); }
    else if(m.msg){ dmgs.push({x:(m.x||400),y:(m.y||300)-30,val:m.msg,life:1.2,max:1.2}); }
  }
  else if(m.t==='loot'){ dmgs.push({x:m.x,y:m.y-30,val:m.txt,life:1.1,max:1.1,gear:true}); }
  else if(m.t==='level'){ fx.push({kind:'level',x:m.x,y:m.y,fx:0,fy:0,hue:48,R:60,life:0.7,max:0.7});
    dmgs.push({x:m.x,y:m.y-40,val:'Lv '+m.lv+'!',life:1.1,max:1.1,foe:true,big:true}); shake=Math.max(shake,8); }
  else if(m.t==='gold'){ var t='+'+m.val+'🪙'+(m.st?(' +'+m.st+'🔨'):''); dmgs.push({x:m.x,y:m.y,val:t,life:0.9,max:0.9,gold:true}); }
  else if(m.t==='combo'){ comboPrompt.active=m.active; comboPrompt.slot=m.slot; comboPrompt.until=performance.now()+(m.windowMs||600); }
  else if(m.t==='echomark'){ if(m.active){ echoMark.active=true; echoMark.x=m.x; echoMark.y=m.y; echoMark.zone=m.zone; echoMark.maxDist=m.maxDist; echoMark.until=performance.now()+(m.windowMs||5000); } else { echoMark.active=false; } }
  else if(m.t==='stance'){ myBladeStance=m.stance; var swapLbl=document.getElementById('swapLbl'); if(swapLbl)swapLbl.textContent=(m.stance==='arcane')?'PHÉP':'KIẾM'; refreshSkillLabels(); }
  else if(m.t==='skillcd'){ cd[m.slot]=m.dur; comboPrompt.active=false; }
  else if(m.t==='fx'){ var lf=FX_DUR[m.kind]||0.4;
    fx.push({kind:m.kind,x:m.x,y:m.y,fx:m.fx,fy:m.fy,hue:m.hue,R:m.R||60,life:lf,max:lf});
    if(m.kind==='ring')shake=Math.max(shake,14); if(m.kind==='nova')shake=Math.max(shake,7);
    if(m.kind==='bigswing')shake=Math.max(shake,m.hue===5?22:(m.hue===12?16:8));
    if(m.kind==='rally')shake=Math.max(shake,14);
    if(m.kind==='jumpslam')shake=Math.max(shake,18); }
  else if(m.t==='hit'){ dmgs.push({x:m.x,y:m.y,val:m.val,life:0.7,max:0.7,foe:m.foe}); if(!m.foe)shake=Math.max(shake,5);}
 }catch(e){}
};
function setBar(bi,ti,v,mx){var el=document.getElementById(bi);if(el){el.style.width=Math.max(0,v/mx*100)+'%';document.getElementById(ti).textContent=Math.ceil(Math.max(0,v))+'/'+mx;}}

// ---- gửi input 30/giây ----
var joy={active:false,id:null,bx:0,by:0,kx:0,ky:0,dx:0,dy:0,mag:0}, RAD=54;
var MENUBTNS=['bag','chr','qbtn','socbtn','guildbtn','petbtn'];
var menuOpen=false;
function closeMenuPopup(){ menuOpen=false; MENUBTNS.forEach(function(id){document.getElementById(id).classList.remove('show');}); }
function repositionMenuPopup(mtEl){
  var r=mtEl.getBoundingClientRect(); var cx=r.left+r.width/2, cy=r.top;
  MENUBTNS.forEach(function(id,i){
    var b=document.getElementById(id); b.style.left=(cx-128+i*44)+'px'; b.style.bottom=(window.innerHeight-cy+8)+'px';
  });
}
(function(){
  var mt=document.getElementById('menuToggle');
  var saved=null; try{ saved=JSON.parse(localStorage.getItem('menuPos')||'null'); }catch(e){}
  if(saved){ mt.style.left=saved.left+'px'; mt.style.bottom=saved.bottom+'px'; }
  else { mt.style.left=(window.innerWidth/2-25)+'px'; mt.style.bottom='4px'; }
  var dragging=false, holdTimer=null, startX=0, startY=0, moved=false;
  mt.addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();
    startX=ev.clientX; startY=ev.clientY; moved=false;
    holdTimer=setTimeout(function(){ dragging=true; mt.classList.add('dragging'); },380);
  });
  mt.addEventListener('pointermove',function(ev){
    if(Math.abs(ev.clientX-startX)>6||Math.abs(ev.clientY-startY)>6) moved=true;
    if(!dragging)return;
    var nl=ev.clientX-25, nb=window.innerHeight-ev.clientY-25;
    nl=Math.max(4,Math.min(window.innerWidth-54,nl)); nb=Math.max(4,Math.min(window.innerHeight-54,nb));
    mt.style.left=nl+'px'; mt.style.bottom=nb+'px';
    if(menuOpen)repositionMenuPopup(mt);
  });
  function endDrag(ev){
    clearTimeout(holdTimer);
    if(dragging){ dragging=false; mt.classList.remove('dragging');
      localStorage.setItem('menuPos', JSON.stringify({left:parseFloat(mt.style.left),bottom:parseFloat(mt.style.bottom)}));
      if(menuOpen)repositionMenuPopup(mt);
    } else if(!moved){
      menuOpen=!menuOpen;
      if(menuOpen)repositionMenuPopup(mt);
      MENUBTNS.forEach(function(id){document.getElementById(id).classList.toggle('show',menuOpen);});
    }
  }
  mt.addEventListener('pointerup',endDrag); mt.addEventListener('pointercancel',endDrag);
})();
MENUBTNS.forEach(function(id){ document.getElementById(id).addEventListener('pointerup',function(){ closeMenuPopup(); }); });
setInterval(function(){ if(ws.readyState===1 && chosen){
  var mvx=joy.mag>0.15?joy.dx:0, mvy=joy.mag>0.15?joy.dy:0;
  ws.send(JSON.stringify({t:'input',x:mvx,y:mvy}));
}},33);

function isComboSkill(k){ var sid=myLoadout&&myLoadout[k]; for(var i=0;i<myFull.length;i++){ if(myFull[i].id===sid) return !!myFull[i].comboNext; } return false; }
function cast(k,aim){ if(cd[k]>0)return; var me=players[myId];
  if(me && me.mp<SKmp[k]){ flash(k); return; }
  if(ws.readyState===1) ws.send(JSON.stringify(aim?{t:'skill',k:k,aim:aim}:{t:'skill',k:k}));
  if(!isComboSkill(k)) cd[k]=SKdur[k]; // skill combo: chờ server báo đúng lúc nào mới thật sự vào hồi chiêu
}
function flash(k){var id={b:'sB',q:'sQ',w:'sW',e:'sE',r:'sR'}[k];var el=document.getElementById(id);
  el.animate([{transform:'translateX(-3px)'},{transform:'translateX(3px)'},{transform:'translateX(0)'}],{duration:140});}
function bindBtn(id,k){document.getElementById(id).addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();cast(k);});}
var aimState={active:false,slot:null,dx:0,dy:1,mag:0,ox:0,oy:0,cancelZone:false};
var cancelHover={active:false,cancelZone:false,x:0,y:0,r:30};
var chargeState={active:false,slot:null,startT:0};
var comboPrompt={active:false,slot:null,until:0};
var echoMark={active:false,x:0,y:0,zone:'',maxDist:500,until:0};
var myBladeStance='blade';
function refreshSkillLabels(){
  if(!lastSkillMeta)return;
  var map={b:'sB',q:'sQ',w:'sW',e:'sE',r:'sR'};
  for(var kk in map){ var el=document.getElementById(map[kk]); var d=lastSkillMeta[kk]; if(!el||!d)continue;
    var isEmpty=(kk!=='b' && !d.name);
    el.classList.toggle('empty', isEmpty);
    var kEl=el.querySelector('.k'); if(kEl && kk!=='b') kEl.textContent = isEmpty ? '?' : kk.toUpperCase();
    var icEl=el.querySelector('.ic'); if(icEl) icEl.textContent = isEmpty ? '' : (d.icon||'');
    var dispName=(myBladeStance==='arcane' && d.nameArcane) ? d.nameArcane : d.name;
    var lbl=el.querySelector('.l'); if(lbl)lbl.textContent = isEmpty ? '???' : (dispName.length>8?dispName.slice(0,8):dispName).toUpperCase();
    var mel=el.querySelector('.m'); if(mel){ if(d.mp>0){mel.style.display='';mel.textContent=d.mp;} else mel.style.display='none'; }
    SKdur[kk]=d.cd; SKmp[kk]=d.mp; }
}
var FX_DUR={enchok:0.6,enchfail:0.6,starfall:0.9,bigswing:0.5,raven:0.55,orderflag:0.5,plantflag:0.8,rally:0.7,horsecharge:0.4,ravenscout:0.6,sacrifice:0.5,soulburst:0.6,swapblade:0.4,swaparcane:0.4,phaseslash:0.35,arcblink:0.4,backstep:0.3,spinattack:0.45,jumpslam:0.5,levitatenova:0.9,braceward:0.35,drainbeam:0.4,resonance:0.5};
var AIM_MAX_PX=90;
function isChargeable(k){ var sid=myLoadout&&myLoadout[k]; for(var i=0;i<myFull.length;i++){ if(myFull[i].id===sid) return !!myFull[i].chargeable; } return false; }
function isChannelable(k){ var sid=myLoadout&&myLoadout[k]; for(var i=0;i<myFull.length;i++){ if(myFull[i].id===sid) return !!myFull[i].channelable; } return false; }
var AIMABLE_TYPES={dash:1,warcleave:1,predstep:1,groundbreak:1,pierce:1,huntmark:1,trap:1,starfall:1,windguard:1,
  emberlance:1,frostprism:1,arcanethread:1,cataclysm:1,mirrorstep:1,gravitywell:1,arcanedet:1,blooddebt:1,warlordverdict:1,ravenmark:1,cmdadvance:1,banner:1,horsecharge:1,tacticalrecall:1,blinkcut:1,arcslash:1,wildhunt:1,lifesteal:1,swordwave:1,voidsword:1,bloodsword:1,rupture:1,proj:1,cone:1,nova:1,slow:1,leap:1};
function isAimable(k){ var sid=myLoadout&&myLoadout[k]; for(var i=0;i<myFull.length;i++){ if(myFull[i].id===sid) return !!AIMABLE_TYPES[myFull[i].type]; } return false; }
function bindSkillBtn(id,k){
  var btn=document.getElementById(id);
  var holding=false,startX=0,startY=0,dragged=false,wasCharge=false,wasChannel=false,wasAimable=false,lastAimSendT=0,nearCancel=false;
  btn.addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();
    if(cd[k]>0){ flash(k); return; }
    startX=ev.clientX;startY=ev.clientY;dragged=false;nearCancel=false;
    try{btn.setPointerCapture(ev.pointerId);}catch(e){}
    wasCharge=isChargeable(k); wasChannel=isChannelable(k); wasAimable=isAimable(k);
    if(wasCharge){ if(ws.readyState===1)ws.send(JSON.stringify({t:'chargestart',k:k})); chargeState.active=true;chargeState.slot=k;chargeState.startT=performance.now(); }
    if(wasChannel){ if(ws.readyState===1)ws.send(JSON.stringify({t:'channelstart',k:k})); }
    holding=true;
    if(wasAimable||wasCharge||wasChannel){ aimState.active=true;aimState.slot=k;aimState.dx=0;aimState.dy=1;aimState.mag=0;aimState.ox=startX;aimState.oy=startY;aimState.cancelZone=false; }
    cancelHover.active=true; cancelHover.cancelZone=false;
  });
  btn.addEventListener('pointermove',function(ev){
    if(!holding)return;
    var cbtn=document.getElementById('sB'); var cr=cbtn?cbtn.getBoundingClientRect():null;
    var cbx=cr?(cr.left+cr.width/2):startX, cby=cr?(cr.top+cr.height/2):startY;
    var cdist=Math.hypot(ev.clientX-cbx,ev.clientY-cby);
    nearCancel=(cdist<((cr?cr.width/2:30)+14)) && !wasChannel;
    cancelHover.cancelZone=nearCancel; cancelHover.x=cbx; cancelHover.y=cby; cancelHover.r=cr?cr.width/2:30;
    if(wasAimable||wasCharge||wasChannel) aimState.cancelZone=nearCancel;
    var dx=ev.clientX-startX, dy=ev.clientY-startY, d=Math.hypot(dx,dy);
    if(d>4){ dragged=true;
      if(wasAimable||wasCharge||wasChannel){ aimState.dx=dx/d; aimState.dy=dy/d; aimState.mag=Math.min(1,d/AIM_MAX_PX);
        if(wasChannel){ var now=performance.now(); if(now-lastAimSendT>70){ lastAimSendT=now; if(ws.readyState===1)ws.send(JSON.stringify({t:'channelaim',k:k,dx:aimState.dx,dy:aimState.dy})); } }
      }
    }
  });
  function release(ev){
    chargeState.active=false; cancelHover.active=false;
    if(wasChannel){ holding=false; aimState.active=false; if(ws.readyState===1)ws.send(JSON.stringify({t:'channelend',k:k})); return; }
    if(holding){ holding=false; aimState.active=false; aimState.cancelZone=false;
      if(dragged && nearCancel){ /* hủy hoàn toàn — không cast, không tốn mana, không hồi chiêu */ }
      else if(dragged && (wasAimable||wasCharge)) cast(k,{dx:aimState.dx,dy:aimState.dy,mag:aimState.mag});
      else cast(k);
    } else { cast(k); }
  }
  btn.addEventListener('pointerup',release);
  btn.addEventListener('pointercancel',function(){holding=false;aimState.active=false;chargeState.active=false;cancelHover.active=false; if(wasChannel && ws.readyState===1)ws.send(JSON.stringify({t:'channelend',k:k}));});
}
bindBtn('sB','b');bindSkillBtn('sQ','q');bindSkillBtn('sW','w');bindSkillBtn('sE','e');bindSkillBtn('sR','r');
document.getElementById('sSwap').addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();
  if(ws.readyState===1)ws.send(JSON.stringify({t:'swapstance'}));});

// PC: mũi tên đi, Q W E R + Space đánh
var keys={};
function typingNow(){ var a=document.activeElement; return a && (a.tagName==='INPUT'||a.tagName==='TEXTAREA'); }
document.addEventListener('focusin',function(e){ if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'){ keys={}; } });
addEventListener('keydown',function(e){ if(typingNow())return; var k=e.key.toLowerCase();keys[k]=true;
  if(k==='q')cast('q');if(k==='w')cast('w');if(k==='e')cast('e');if(k==='r')cast('r');
  if(k===' '){e.preventDefault();cast('b');}});
addEventListener('keyup',function(e){ if(typingNow())return; keys[e.key.toLowerCase()]=false;});
setInterval(function(){
  if(joy.active)return; var mx=0,my=0;
  if(keys['arrowleft'])mx-=1;if(keys['arrowright'])mx+=1;if(keys['arrowup'])my-=1;if(keys['arrowdown'])my+=1;
  var d=Math.hypot(mx,my); if(d>0){joy.dx=mx/d;joy.dy=my/d;joy.mag=1;} else if(!joy.active){joy.mag=0;}
},33);

// ---- joystick (chạm bất kỳ đâu) ----
var joyStartT=0;
cv.addEventListener('pointerdown',function(e){ if(joy.active)return;
  var r=cv.getBoundingClientRect();joy.active=true;joy.id=e.pointerId;joyStartT=performance.now();
  joy.bx=e.clientX-r.left;joy.by=e.clientY-r.top;joy.kx=joy.bx;joy.ky=joy.by;joy.dx=0;joy.dy=0;joy.mag=0;});
cv.addEventListener('pointermove',function(e){ if(!joy.active||e.pointerId!==joy.id)return;
  joyStartT=performance.now();
  var r=cv.getBoundingClientRect();var px=e.clientX-r.left,py=e.clientY-r.top;
  var dx=px-joy.bx,dy=py-joy.by,d=Math.hypot(dx,dy),cl=Math.min(d,RAD),a=Math.atan2(dy,dx);
  joy.kx=joy.bx+Math.cos(a)*cl;joy.ky=joy.by+Math.sin(a)*cl;joy.mag=cl/RAD;joy.dx=Math.cos(a);joy.dy=Math.sin(a);});
function jend(e){ if(!joy.active)return; if(!e||e.pointerId===joy.id){joy.active=false;joy.id=null;joy.mag=0;} }
// Bắt sự kiện nhả tay ở NHIỀU nơi (không chỉ trong canvas) + khi đổi tab/app → tránh joystick bị "kẹt ma"
cv.addEventListener('pointerup',jend); cv.addEventListener('pointercancel',jend);
cv.addEventListener('pointerleave',jend); cv.addEventListener('pointerout',jend);
window.addEventListener('pointerup',jend); window.addEventListener('pointercancel',jend);
window.addEventListener('blur',function(){jend();});
document.addEventListener('visibilitychange',function(){ if(document.hidden)jend(); });
// Lớp bảo vệ cuối: nếu joystick "đang giữ" liên tục quá 10s không hề nhúc nhích (bất thường) → tự thả.
setInterval(function(){ if(joy.active && performance.now()-joyStartT>10000) jend(); },1000);

// ---- render ----
var last=performance.now();
function frame(now){
 try{
  var dt=Math.min(0.05,(now-last)/1000);last=now;
  for(var k in cd)if(cd[k]>0)cd[k]=Math.max(0,cd[k]-dt);
  if(shake>0)shake=Math.max(0,shake-30*dt);
  updateBtns(); updatePartyHud();

  ctx.setTransform(scr.dpr,0,0,scr.dpr,0,0);
  ctx.clearRect(0,0,scr.w,scr.h);
  var sx=(Math.random()-.5)*shake, sy=(Math.random()-.5)*shake;
  ctx.save();
  ctx.translate(scr.ox+sx,scr.oy+sy); ctx.scale(scr.scale,scr.scale);

  var zd=ZONEDATA[myZone]||{w:900,h:700,bg:'#14100c',portals:[]};
  ctx.fillStyle=zd.bg||'#14100c';ctx.fillRect(0,0,WW,WH);

  // --- DỰ ĐOÁN vị trí nhân vật MÌNH (client prediction) — PHẢI chạy TRƯỚC khi camera tính theo dõi,
  //     nếu không camera sẽ dùng vị trí cũ của khung hình trước, chậm sau nhân vật đúng 1 khung ---
  var meNow=players[myId];
  if(meNow && !meNow.dead){
    var justReset=(myPX===null);
    if(justReset){myPX=meNow.x;myPY=meNow.y;myFX=meNow.fx;myFY=meNow.fy;}
    else {
      var pmx=joy.mag>0.15?joy.dx:0, pmy=joy.mag>0.15?joy.dy:0;
      var spd=meNow.spd||250; if(meNow.bcd)SKdur.b=meNow.bcd;
      myPX+=pmx*spd*dt; myPY+=pmy*spd*dt;
      myPX=Math.max(15,Math.min(zd.w-15,myPX)); myPY=Math.max(15,Math.min(zd.h-15,myPY));
      var gap=Math.hypot(meNow.x-myPX,meNow.y-myPY);
      if(gap>110){myPX+=(meNow.x-myPX)*0.5;myPY+=(meNow.y-myPY)*0.5;} else {myPX+=(meNow.x-myPX)*0.35;myPY+=(meNow.y-myPY)*0.35;}
      if(joy.mag>0.2){myFX=joy.dx;myFY=joy.dy;} else {myFX=meNow.fx;myFY=meNow.fy;}
    }
  } else { myPX=null; }

  var followX = (myPX!==null?myPX:(meNow?meNow.x:zd.w/2));
  var followY = (myPY!==null?myPY:(meNow?meNow.y:zd.h/2));
  var camX = zd.w<=WW ? zd.w/2 : Math.max(WW/2,Math.min(zd.w-WW/2,followX));
  var camY = zd.h<=WH ? zd.h/2 : Math.max(WH/2,Math.min(zd.h-WH/2,followY));
  var camOX = WW/2-camX, camOY = WH/2-camY;
  ctx.save(); ctx.translate(camOX,camOY);

  drawGround(zd, myZone, camX, camY);
  ctx.strokeStyle='#000';ctx.lineWidth=6;ctx.strokeRect(0,0,zd.w,zd.h);

  var decor=ZONE_DECOR[myZone];
  if(decor){ for(var di=0;di<decor.length;di++){ var dd=decor[di]; var dcTy=DECOR_TYPES[dd.t];
    if(dcTy) drawPixelGrid(dcTy.grid,dcTy.col,dd.x,dd.y,6.5); } }
  var obsList=zoneObs[myZone];
  if(obsList){ var obT=(myZone==='cave')?'frock':(myZone==='dungeon')?'pillar':'tree'; var obG=DECOR_TYPES[obT];
    for(var oi=0;oi<obsList.length;oi++){ var ob=obsList[oi];
      if(ob.x<camX-WW/2-40||ob.x>camX+WW/2+40||ob.y<camY-WH/2-40||ob.y>camY+WH/2+40)continue;
      ctx.save();ctx.globalAlpha=0.28;ctx.fillStyle='#000';ctx.beginPath();ctx.ellipse(ob.x,ob.y+ob.r*0.7,ob.r*0.9,ob.r*0.4,0,0,7);ctx.fill();ctx.restore();
      if(obG) drawPixelGrid(obG.grid,obG.col,ob.x,ob.y-ob.r*0.5,7.5); } }

  var pts=(zd.portals||[]);
  for(var pi=0;pi<pts.length;pi++){var pt=pts[pi];var pulse=6*Math.sin(performance.now()/260+pi);
    ctx.save();ctx.globalAlpha=.85;ctx.strokeStyle='#ffd76b';ctx.lineWidth=3;ctx.shadowColor='#ffd76b';ctx.shadowBlur=16;
    ctx.beginPath();ctx.arc(pt.x,pt.y,pt.r+pulse,0,7);ctx.stroke();
    ctx.beginPath();ctx.arc(pt.x,pt.y,pt.r*0.6,0,7);ctx.strokeStyle='#fff3c2';ctx.stroke();
    ctx.shadowBlur=0;ctx.fillStyle='#ffe9a8';ctx.font='bold 12px Trebuchet MS';ctx.textAlign='center';
    ctx.fillText(pt.label||'',pt.x,pt.y-pt.r-8);ctx.restore();}

  for(var ni=0;ni<NPCLIST.length;ni++){var np=NPCLIST[ni]; if(np.zone!==myZone)continue;
    var bob=Math.sin(performance.now()/450+ni)*3;
    ctx.save();ctx.font='28px serif';ctx.textAlign='center';ctx.fillText(np.icon,np.x,np.y+bob);
    ctx.fillStyle='#ffe9a8';ctx.font='bold 11px Trebuchet MS';ctx.fillText(np.name,np.x,np.y-24+bob);
    if(np.id===nearNpcId){ctx.strokeStyle='#ffd76b';ctx.lineWidth=2;ctx.beginPath();ctx.arc(np.x,np.y-4,26,0,7);ctx.stroke();}
    ctx.restore();}

  for(var pid2 in myPets){ var pd2=myPets[pid2]; if(pd2.zone!==myZone)continue;
    var pbob=Math.sin(performance.now()/380+pd2.hue)*2;
    ctx.save();
    ctx.fillStyle='hsl('+pd2.hue+',60%,50%)';ctx.globalAlpha=.5;ctx.beginPath();ctx.arc(pd2.x,pd2.y+9,10,0,7);ctx.fill();ctx.globalAlpha=1;
    ctx.font='18px serif';ctx.textAlign='center';ctx.fillText(pd2.icon,pd2.x,pd2.y+pbob+5);
    ctx.fillStyle='#cdbf9a';ctx.font='9px Trebuchet MS';ctx.fillText('Lv'+pd2.lv,pd2.x,pd2.y-10+pbob);
    ctx.restore();}
  for(var sid3 in mySummons){ var sd3=mySummons[sid3]; if(sd3.zone!==myZone)continue;
    var sbob=Math.sin(performance.now()/300)*2;
    var sPhase=sd3.phase;
    ctx.save();
    if(sPhase==='hold'){
      var epulse2=(Math.sin(performance.now()/150)+1)/2;
      ctx.globalAlpha=0.35+epulse2*0.25;ctx.strokeStyle='#ffcf6b';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(sd3.x,sd3.y,20+epulse2*5,0,7);ctx.stroke();
      ctx.globalAlpha=0.8;ctx.strokeStyle='#ffcf6b';ctx.lineWidth=3;
      ctx.beginPath();ctx.moveTo(sd3.x,sd3.y);ctx.lineTo(sd3.x+34,sd3.y-4);ctx.stroke();
      ctx.globalAlpha=1;
    } else if(sPhase==='charge'||sPhase==='return'){
      ctx.globalAlpha=0.3;ctx.strokeStyle='#ffcf6b';ctx.lineWidth=2;
      ctx.beginPath();ctx.moveTo(sd3.x-14,sd3.y);ctx.lineTo(sd3.x-4,sd3.y);ctx.stroke();
      ctx.globalAlpha=1;
    }
    ctx.fillStyle='#ffd76b';ctx.globalAlpha=.45;ctx.beginPath();ctx.arc(sd3.x,sd3.y+9,11,0,7);ctx.fill();ctx.globalAlpha=1;
    ctx.font='20px serif';ctx.textAlign='center';ctx.fillText('🛡️',sd3.x,sd3.y+sbob+6);
    ctx.restore();}

  for(var i=fx.length-1;i>=0;i--){var f=fx[i];f.life-=dt;if(f.life<=0){fx.splice(i,1);continue;}
    var t=1-f.life/f.max; ctx.globalAlpha=f.life/f.max;
    if(f.kind==='nova'||f.kind==='ring'){ctx.strokeStyle='hsl('+f.hue+',80%,65%)';ctx.lineWidth=4;
      ctx.beginPath();ctx.arc(f.x,f.y,f.R*t,0,7);ctx.stroke();}
    else if(f.kind==='starfall'){
      if(t<0.3){ var up=t/0.3;
        ctx.strokeStyle='#ffe070';ctx.lineWidth=3;
        ctx.beginPath();ctx.moveTo(f.fx,f.fy);ctx.lineTo(f.fx,f.fy-30-up*70);ctx.stroke();
      } else {
        var fall=(t-0.3)/0.7;
        ctx.strokeStyle='#ffe070';ctx.lineWidth=2;
        for(var si=0;si<7;si++){
          var sang=si*0.9+1.3, sr=(f.R||40)*0.72*(0.3+0.7*((si*37)%10)/10);
          var sx=f.x+Math.cos(sang)*sr, sy=f.y+Math.sin(sang)*sr;
          var dr=Math.min(1,fall*1.8-si*0.05); if(dr<0)continue;
          var dropY=sy-36+dr*36;
          ctx.globalAlpha=(f.life/f.max)*Math.min(1,dr*3);
          ctx.beginPath();ctx.moveTo(sx,dropY-12);ctx.lineTo(sx,dropY);ctx.stroke();
        }
        if(fall>0.65){ ctx.strokeStyle='hsl('+f.hue+',80%,65%)';ctx.lineWidth=3;
          ctx.beginPath();ctx.arc(f.x,f.y,(f.R||40)*Math.min(1,(fall-0.65)/0.35),0,7);ctx.stroke(); }
      }
    }
    else if(f.kind==='raven'){
      var rt=Math.min(1,t/0.75);
      if(t<0.75){
        var rx=f.fx+(f.x-f.fx)*rt, ry=f.fy+(f.y-f.fy)*rt-Math.sin(rt*Math.PI)*40;
        var wingFlap=Math.sin(performance.now()/55)*0.2;
        ctx.save();ctx.globalAlpha=(f.life/f.max);ctx.translate(rx,ry);ctx.rotate(wingFlap);
        ctx.font='18px serif';ctx.textAlign='center';ctx.fillText('🐦‍⬛',0,0);
        ctx.restore();
      } else {
        var land=(t-0.75)/0.25;
        ctx.save();ctx.globalAlpha=(f.life/f.max);
        ctx.strokeStyle='#3a3a3a';ctx.lineWidth=2;
        ctx.beginPath();ctx.arc(f.x,f.y,8+land*20,0,7);ctx.stroke();
        ctx.font='16px serif';ctx.textAlign='center';ctx.fillText('🐦‍⬛',f.x,f.y+5);
        ctx.restore();
      }
    }
    else if(f.kind==='horsecharge'){
      ctx.save();ctx.globalAlpha=(f.life/f.max)*0.6;ctx.strokeStyle='#c9a86a';ctx.lineWidth=8;ctx.lineCap='round';
      ctx.beginPath();ctx.moveTo(f.fx,f.fy);ctx.lineTo(f.x,f.y);ctx.stroke();
      ctx.globalAlpha=(f.life/f.max);ctx.strokeStyle='#ffd76b';ctx.lineWidth=2;
      ctx.beginPath();ctx.moveTo(f.fx,f.fy);ctx.lineTo(f.x,f.y);ctx.stroke();
      ctx.restore();
    }
    else if(f.kind==='ravenscout'){
      ctx.save();
      for(var rsi=0;rsi<5;rsi++){ var rang=(performance.now()/300)+rsi*1.26;
        var rr=(f.R||280)*(0.4+0.5*((rsi*23)%10)/10);
        var rx2=f.x+Math.cos(rang)*rr, ry2=f.y+Math.sin(rang)*rr;
        ctx.globalAlpha=(f.life/f.max)*0.85;ctx.font='13px serif';ctx.textAlign='center';ctx.fillText('🐦',rx2,ry2); }
      ctx.globalAlpha=(f.life/f.max)*0.15;ctx.strokeStyle='#8ad6ff';ctx.lineWidth=1.5;ctx.setLineDash([3,8]);
      ctx.beginPath();ctx.arc(f.x,f.y,f.R||280,0,7);ctx.stroke();ctx.setLineDash([]);
      ctx.restore();
    }
    else if(f.kind==='resonance'){
      ctx.save();var resR=(f.R||40)*Math.min(1,t*2);
      ctx.globalAlpha=(f.life/f.max)*0.75;ctx.strokeStyle='#ff8a5a';ctx.lineWidth=4;
      ctx.beginPath();ctx.arc(f.x,f.y,resR,-Math.PI/2,Math.PI/2);ctx.stroke();
      ctx.strokeStyle='#c9a8ff';
      ctx.beginPath();ctx.arc(f.x,f.y,resR,Math.PI/2,Math.PI*1.5);ctx.stroke();
      ctx.restore();
    }
    else if(f.kind==='drainbeam'){
      ctx.save();ctx.globalAlpha=(f.life/f.max)*0.7;ctx.strokeStyle='#c9a8ff';ctx.lineWidth=3;ctx.setLineDash([4,4]);
      ctx.beginPath();ctx.moveTo(f.x,f.y);ctx.lineTo(f.fx,f.fy);ctx.stroke();ctx.setLineDash([]);
      var dbT=1-t; ctx.fillStyle='#c9a8ff';
      ctx.beginPath();ctx.arc(f.fx+(f.x-f.fx)*dbT,f.fy+(f.y-f.fy)*dbT,4,0,7);ctx.fill();
      ctx.restore();
    }
    else if(f.kind==='braceward'){
      ctx.save();ctx.globalAlpha=(f.life/f.max)*0.7;ctx.strokeStyle='#c9a86a';ctx.lineWidth=4;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.R||50)*t*0.6,0,7);ctx.stroke();
      ctx.restore();
    }
    else if(f.kind==='backstep'){
      ctx.save();ctx.globalAlpha=(f.life/f.max)*0.6;ctx.fillStyle='#c9a8ff';
      for(var bsi=0;bsi<3;bsi++){ctx.beginPath();ctx.arc(f.x+f.fx*bsi*6,f.y+f.fy*bsi*6,4-bsi,0,7);ctx.fill();}
      ctx.restore();
    }
    else if(f.kind==='spinattack'){
      ctx.save();var spinA=t*Math.PI*3;
      if(f.fx || f.fy){ ctx.globalAlpha=(f.life/f.max)*0.4;ctx.strokeStyle='#ffb060';ctx.lineWidth=(f.R||90)*1.6;ctx.lineCap='round';
        ctx.beginPath();ctx.moveTo(f.fx,f.fy);ctx.lineTo(f.x,f.y);ctx.stroke(); }
      ctx.globalAlpha=(f.life/f.max);ctx.strokeStyle='#ffb060';ctx.lineWidth=5;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.R||100)*0.75,spinA,spinA+2.4);ctx.stroke();
      ctx.globalAlpha=0.5;ctx.lineWidth=3;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.R||100)*0.5,-spinA*1.4,-spinA*1.4+1.8);ctx.stroke();
      ctx.restore();
    }
    else if(f.kind==='jumpslam'){
      ctx.save();ctx.globalAlpha=(f.life/f.max);ctx.strokeStyle='#ff8a5a';ctx.lineWidth=5;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.R||185)*t,0,7);ctx.stroke();
      ctx.globalAlpha=(f.life/f.max)*0.5;ctx.fillStyle='#8a6a4a';
      for(var jsi=0;jsi<8;jsi++){ var jsa=jsi*0.78;
        ctx.beginPath();ctx.arc(f.x+Math.cos(jsa)*t*40,f.y+Math.sin(jsa)*t*20,3,0,7);ctx.fill(); }
      ctx.restore();
    }
    else if(f.kind==='levitatenova'){
      ctx.save();ctx.globalAlpha=(f.life/f.max)*0.7;ctx.strokeStyle='#c9a8ff';ctx.lineWidth=3;
      ctx.beginPath();ctx.arc(f.x,f.y-10,(f.R||140)*Math.min(1,t*1.5),0,7);ctx.stroke();
      ctx.globalAlpha=(f.life/f.max)*0.35;
      ctx.beginPath();ctx.arc(f.x,f.y-10,(f.R||140)*Math.min(1,t*1.5)*0.6,0,7);ctx.stroke();
      ctx.restore();
    }
    else if(f.kind==='phaseslash'){
      ctx.save();ctx.globalAlpha=(f.life/f.max);ctx.strokeStyle='#ff8a5a';ctx.lineWidth=9;ctx.lineCap='round';
      ctx.beginPath();ctx.moveTo(f.x,f.y);ctx.lineTo(f.fx,f.fy);ctx.stroke();
      ctx.globalAlpha=(f.life/f.max)*0.6;ctx.lineWidth=4;ctx.strokeStyle='#ffe0b0';
      var pa=Math.atan2(f.fy-f.y,f.fx-f.x);
      for(var psi=0;psi<3;psi++){ var pt=(psi+1)/4;
        var mx=f.x+(f.fx-f.x)*pt, my=f.y+(f.fy-f.y)*pt;
        ctx.beginPath();ctx.moveTo(mx-Math.cos(pa+1.3)*10,my-Math.sin(pa+1.3)*10);ctx.lineTo(mx+Math.cos(pa+1.3)*10,my+Math.sin(pa+1.3)*10);ctx.stroke(); }
      ctx.restore();
    }
    else if(f.kind==='arcblink'){
      ctx.save();
      var abT=t;
      if(abT<0.5){ var shatterT=abT/0.5;
        ctx.globalAlpha=(f.life/f.max)*(1-shatterT);
        for(var abi=0;abi<6;abi++){ var abang=abi*1.05;
          ctx.fillStyle='#c9a8ff';ctx.beginPath();ctx.arc(f.x+Math.cos(abang)*shatterT*22,f.y+Math.sin(abang)*shatterT*22,3,0,7);ctx.fill(); }
      } else { var reformT=(abT-0.5)/0.5;
        ctx.globalAlpha=(f.life/f.max)*reformT;
        for(var abi2=0;abi2<6;abi2++){ var abang2=abi2*1.05;
          ctx.fillStyle='#c9a8ff';ctx.beginPath();ctx.arc(f.fx+Math.cos(abang2)*(1-reformT)*22,f.fy+Math.sin(abang2)*(1-reformT)*22,3,0,7);ctx.fill(); }
        ctx.globalAlpha=(f.life/f.max)*reformT*0.5;ctx.strokeStyle='#c9a8ff';ctx.lineWidth=2;
        ctx.beginPath();ctx.arc(f.fx,f.fy,14*reformT,0,7);ctx.stroke();
      }
      ctx.restore();
    }
    else if(f.kind==='swapblade'||f.kind==='swaparcane'){
      var swCol=(f.kind==='swaparcane')?'#a878ff':'#ff8a5a';
      ctx.save();ctx.globalAlpha=(f.life/f.max);ctx.strokeStyle=swCol;ctx.lineWidth=3;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.R||40)*t,0,7);ctx.stroke();
      ctx.globalAlpha=(f.life/f.max)*0.8;ctx.font='18px serif';ctx.textAlign='center';
      ctx.fillText(f.kind==='swaparcane'?'🔮':'⚔️',f.x,f.y-20-t*15);
      ctx.restore();
    }
    else if(f.kind==='sacrifice'){
      ctx.save();ctx.globalAlpha=(f.life/f.max)*0.7;ctx.strokeStyle='#c93a3a';ctx.lineWidth=3;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.R||60)*(1-t),0,7);ctx.stroke();
      ctx.globalAlpha=(f.life/f.max);ctx.font='16px serif';ctx.textAlign='center';ctx.fillText('💔',f.x,f.y-10-t*15);
      ctx.restore();
    }
    else if(f.kind==='soulburst'){
      ctx.save();
      for(var sbi=0;sbi<6;sbi++){ var sbang=sbi*1.05;
        var sbr=(f.R||60)*t;
        var sbx=f.x+Math.cos(sbang)*sbr, sby=f.y+Math.sin(sbang)*sbr-t*20;
        ctx.globalAlpha=(f.life/f.max)*(1-t)*0.9;ctx.fillStyle='#c9a8ff';ctx.beginPath();ctx.arc(sbx,sby,3,0,7);ctx.fill(); }
      ctx.globalAlpha=(f.life/f.max)*0.5;ctx.strokeStyle='#c9a8ff';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.R||60)*t,0,7);ctx.stroke();
      ctx.restore();
    }
    else if(f.kind==='rally'){
      ctx.save();
      ctx.globalAlpha=(f.life/f.max)*0.8;ctx.strokeStyle='#ffd76b';ctx.lineWidth=4;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.R||220)*t,0,7);ctx.stroke();
      ctx.globalAlpha=(f.life/f.max)*0.5;ctx.strokeStyle='#ff5a5a';ctx.lineWidth=3;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.R||220)*t*0.85,0,7);ctx.stroke();
      if(t<0.3){ ctx.globalAlpha=1;ctx.font='26px serif';ctx.textAlign='center';ctx.fillText('📣',f.x,f.y-10); }
      ctx.restore();
    }
    else if(f.kind==='plantflag'){
      if(t<0.5){
        var dt2=t/0.5;
        var dropY=f.y-90*(1-dt2);
        var sway=Math.sin(dt2*Math.PI*3)*10*(1-dt2);
        ctx.save();ctx.globalAlpha=(f.life/f.max);
        ctx.strokeStyle='#8a6a2a';ctx.lineWidth=3;
        ctx.beginPath();ctx.moveTo(f.x+sway,dropY+18);ctx.lineTo(f.x+sway,dropY-16);ctx.stroke();
        ctx.fillStyle='#ffd76b';ctx.beginPath();ctx.moveTo(f.x+sway,dropY-16);ctx.lineTo(f.x+sway+20,dropY-10);ctx.lineTo(f.x+sway,dropY-4);ctx.closePath();ctx.fill();
        ctx.restore();
      } else {
        var plant=(t-0.5)/0.5;
        ctx.save();ctx.globalAlpha=(f.life/f.max);
        ctx.strokeStyle='#8a6a2a';ctx.lineWidth=3;
        ctx.beginPath();ctx.moveTo(f.x,f.y+18);ctx.lineTo(f.x,f.y-16);ctx.stroke();
        ctx.fillStyle='#ffd76b';ctx.beginPath();ctx.moveTo(f.x,f.y-16);ctx.lineTo(f.x+20,f.y-10);ctx.lineTo(f.x,f.y-4);ctx.closePath();ctx.fill();
        ctx.globalAlpha=(f.life/f.max)*(1-plant)*0.7;
        ctx.fillStyle='#c9a86a';
        for(var pi=0;pi<5;pi++){ var pang=pi*1.25;
          ctx.beginPath();ctx.arc(f.x+Math.cos(pang)*plant*16,f.y+18+Math.sin(pang)*plant*6,3,0,7);ctx.fill(); }
        ctx.globalAlpha=(f.life/f.max)*0.35;
        ctx.strokeStyle='#ffd76b';ctx.lineWidth=1.5;
        ctx.beginPath();ctx.arc(f.x,f.y,(f.R||150)*plant,0,7);ctx.stroke();
        ctx.restore();
      }
    }
    else if(f.kind==='orderflag'){
      var ot=Math.min(1,t/0.35);
      if(t<0.35){
        var ox2=f.fx+(f.x-f.fx)*ot, oy2=f.fy+(f.y-f.fy)*ot;
        var oa=Math.atan2(f.y-f.fy,f.x-f.fx);
        ctx.save();ctx.globalAlpha=(f.life/f.max);ctx.translate(ox2,oy2);ctx.rotate(oa);
        ctx.fillStyle='#ffcf6b';ctx.beginPath();ctx.moveTo(16,0);ctx.lineTo(-8,-9);ctx.lineTo(-3,0);ctx.lineTo(-8,9);ctx.closePath();ctx.fill();
        ctx.restore();
      } else {
        var stamp=(t-0.35)/0.65;
        ctx.save();ctx.globalAlpha=(f.life/f.max)*(1-stamp*0.5);
        ctx.strokeStyle='#ffcf6b';ctx.lineWidth=3;
        ctx.beginPath();ctx.arc(f.x,f.y,10+stamp*35,0,7);ctx.stroke();
        for(var oi=0;oi<4;oi++){ var oang=oi*1.57+0.4;
          ctx.beginPath();ctx.moveTo(f.x,f.y);ctx.lineTo(f.x+Math.cos(oang)*(12+stamp*22),f.y+Math.sin(oang)*(12+stamp*22));ctx.stroke(); }
        ctx.restore();
      }
    }
    else if(f.kind==='swing'){ctx.strokeStyle='#ffd9a0';ctx.lineWidth=5;var a=Math.atan2(f.fy,f.fx);
      ctx.beginPath();ctx.arc(f.x,f.y,26,a-0.9,a+0.9);ctx.stroke();}
    else if(f.kind==='bigswing'){
      var bsa=Math.atan2(f.fy,f.fx), bsR=(f.R||140)*(0.6+0.4*t);
      ctx.fillStyle='hsl('+f.hue+',85%,60%)'; ctx.globalAlpha=(f.life/f.max)*0.5;
      ctx.beginPath();ctx.moveTo(f.x,f.y);ctx.arc(f.x,f.y,bsR,bsa-1.15,bsa+1.15);ctx.closePath();ctx.fill();
      ctx.strokeStyle='hsl('+f.hue+',95%,72%)'; ctx.lineWidth=6; ctx.globalAlpha=(f.life/f.max);
      ctx.beginPath();ctx.arc(f.x,f.y,bsR,bsa-1.15,bsa+1.15);ctx.stroke();
      ctx.lineWidth=3; ctx.globalAlpha=(f.life/f.max)*0.6;
      ctx.beginPath();ctx.arc(f.x,f.y,bsR*0.75,bsa-0.9,bsa+0.9);ctx.stroke();
    }
    else if(f.kind==='dash'){ctx.fillStyle='hsl('+f.hue+',70%,60%)';
      for(var d2=0;d2<5;d2++){ctx.beginPath();ctx.arc(f.x-f.fx*d2*10,f.y-f.fy*d2*10,6-d2,0,7);ctx.fill();}}
    else if(f.kind==='bite'){ctx.strokeStyle='#ff5a4a';ctx.lineWidth=3;var ba=Math.atan2(f.fy,f.fx);
      for(var s=-1;s<=1;s++){ctx.beginPath();ctx.arc(f.x,f.y,16+s*7,ba-0.55,ba+0.55);ctx.stroke();}}
    else if(f.kind==='level'){ctx.strokeStyle='#ffd76b';ctx.lineWidth=4;ctx.beginPath();ctx.arc(f.x,f.y,10+f.R*t,0,7);ctx.stroke();
      ctx.lineWidth=2;ctx.beginPath();ctx.arc(f.x,f.y,f.R*t*0.6,0,7);ctx.stroke();}
    else if(f.kind==='shield'){ctx.strokeStyle='#6bc4ff';ctx.lineWidth=4;ctx.globalAlpha=f.life/f.max;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.R||70)*t+16,0,7);ctx.stroke();
      ctx.lineWidth=2;ctx.beginPath();ctx.arc(f.x,f.y,(f.R||70)*t*0.6+10,0,7);ctx.stroke();}
    else if(f.kind==='heal'){ctx.strokeStyle='#7be08a';ctx.lineWidth=4;ctx.globalAlpha=f.life/f.max;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.R||140)*t,0,7);ctx.stroke();ctx.fillStyle='#aef0b0';
      for(var hp2=0;hp2<6;hp2++){var ha=Math.PI*2*hp2/6;ctx.beginPath();ctx.arc(f.x+Math.cos(ha)*40*t,f.y+Math.sin(ha)*40*t-t*30,3,0,7);ctx.fill();}}
    else if(f.kind==='enchok'){ctx.strokeStyle='#ffe07a';ctx.lineWidth=4;
      for(var rr=0;rr<3;rr++){ctx.globalAlpha=(f.life/f.max)*(1-rr*0.25);ctx.beginPath();ctx.arc(f.x,f.y,(20+rr*22)*t+6,0,7);ctx.stroke();}
      ctx.globalAlpha=f.life/f.max;ctx.fillStyle='#fff6cf';
      for(var sp=0;sp<8;sp++){var aa=Math.PI*2*sp/8;var rad=50*t;ctx.beginPath();ctx.arc(f.x+Math.cos(aa)*rad,f.y+Math.sin(aa)*rad-t*20,3,0,7);ctx.fill();}}
    else if(f.kind==='enchfail'){ctx.strokeStyle='#ff5a4a';ctx.lineWidth=3;ctx.globalAlpha=f.life/f.max;
      for(var cr=0;cr<5;cr++){var ca=Math.PI*2*cr/5;ctx.beginPath();ctx.moveTo(f.x,f.y);ctx.lineTo(f.x+Math.cos(ca)*(28*t+8),f.y+Math.sin(ca)*(28*t+8));ctx.stroke();}
      ctx.strokeStyle='#b8514d';ctx.beginPath();ctx.arc(f.x,f.y,30*t+6,0,7);ctx.stroke();}
    ctx.globalAlpha=1;
  }

  var BOSS_GRID=['..o...o..','.oo.o.oo.','..ooooo..','.oo.o.oo.','..ooooo..','...ooo...','.ooooooo.','ooooooooo','ooooooooo','ooooooooo','.ooooooo.','o.o...o.o','o.o...o.o'];
  var MOB_GRIDS={
    beast:   ['....o.o..','...ooooo.','oooooooo.','oooooooo.','.o.o.o.o.','.........'],
    crawler: ['o.....o','.o...o.','..ooo..','.ooooo.','..ooo..','.o...o.','o.....o'],
    brute:   ['..ooo..','.ooooo.','..ooo..','ooooooo','ooooooo','o.....o','o.....o','o.....o'],
    flyer:   ['o.....o','oo...oo','ooo.ooo','.ooooo.','..ooo..','..o.o..','.......'],
    ghost:   ['..ooo..','.ooooo.','ooooooo','ooooooo','ooooooo','o.o.o.o','.o.o.o.'],
    skeleton:['.ooooo.','oo.o.oo','.ooooo.','..ooo..','o.o.o.o','.ooooo.','o.....o']
  };
  function drawMobPixel(cx,cy,er,hue,shape){
    var bobY=Math.abs(Math.sin(performance.now()/480+cx*0.4))*1.4;
    var oy=cy-bobY;
    if(spriteReady && MOB_SPRITE[shape]!==undefined){
      drawSprite(MOB_SPRITE[shape],cx,oy,er*2.6,er*2.6);
      return;
    }
    var g=MOB_GRIDS[shape]||MOB_GRIDS.brute; var w=g[0].length;
    var ps=(er*3.0)/w; var col={'o':'hsl('+hue+',60%,28%)'};
    var outCol={'o':'#0a0806'};
    drawPixelGrid(g,outCol,cx-ps*0.9,oy,ps);drawPixelGrid(g,outCol,cx+ps*0.9,oy,ps);
    drawPixelGrid(g,outCol,cx,oy-ps*0.9,ps);drawPixelGrid(g,outCol,cx,oy+ps*0.9,ps);
    drawPixelGrid(g,col,cx,oy,ps);
    var eyeY=cy-bobY-er*0.45, eyeGap=er*0.28;
    var eyePulse=(Math.sin(performance.now()/220+cx)+1)/2;
    ctx.save();ctx.globalAlpha=0.75+eyePulse*0.25;ctx.fillStyle='#ff3020';
    ctx.fillRect(Math.round(cx-eyeGap-1.5),Math.round(eyeY),3,3);
    ctx.fillRect(Math.round(cx+eyeGap-1.5),Math.round(eyeY),3,3);
    ctx.restore();
  }
  for(var eid in enemies){var en=enemies[eid];if(en.dead||en.zone!==myZone)continue;var er=en.r||14;
    var mhue=en.boss?330:(en.mhue!==undefined?en.mhue:5);
    var msh=en.boss?null:en.mshape;
    var emvx=en.x-(en._epx!==undefined?en._epx:en.x), emvy=en.y-(en._epy!==undefined?en._epy:en.y);
    var emov=(Math.abs(emvx)>0.12||Math.abs(emvy)>0.12);
    var edir=(Math.abs(emvx)>=Math.abs(emvy))?(emvx>=0?3:1):(emvy>=0?2:0);
    en._epx=en.x; en._epy=en.y;
    var mbob=en.y-Math.abs(Math.sin(performance.now()/480+en.x*0.4))*1.4;
    var msz=er*2.7*(MOBSIZE[msh]||1);
    if(en.boss){
      var bossPulse=(Math.sin(performance.now()/300)+1)/2;
      if(en.zone==='swamp'){ drawMobAnim('flower',en.x,en.y-er*0.5,er*4.0,2,true); }
      else if(en.zone==='dungeon'){ drawMobAnim('pumpking',en.x,en.y-er*0.4,er*3.6,2,true); }
      else if(bossMonReady && BOSS_MON[en.zone]){ drawBossMon(en.zone,en.x,en.y-er*0.3,er*2.8); }
      else if(dragonReady && BOSS_DRAGON[en.zone]){ drawBossSprite(en.zone,en.x,en.y-er*0.4,er*3.0); }
      else { var bossCol={'o':'#7a1838'}; drawPixelGrid(BOSS_GRID,bossCol,en.x,en.y,er*0.31); }
      ctx.save();ctx.globalAlpha=0.4+bossPulse*0.25;ctx.strokeStyle='#ff4a7a';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(en.x,en.y,er+6+bossPulse*4,0,7);ctx.stroke();ctx.restore();
    }
    else if(msh && MOBANIM[msh] && drawMobAnim(msh,en.x,mbob,msz,edir,emov)){}
    else if(msh && mob2Ready && MOB2[msh]){ drawMob2(msh,en.x,mbob,msz); }
    else if(msh && mob3Ready && MOB3[msh]){ drawMob3(msh,en.x,mbob,msz); }
    else if(msh && MOB_GRIDS[msh]){ drawMobPixel(en.x,en.y,er,mhue,msh); }
    else { ctx.fillStyle='hsl('+mhue+',55%,42%)';ctx.fillRect(Math.round(en.x-er*0.8),Math.round(en.y-er*0.8),Math.round(er*1.6),Math.round(er*1.6)); }
    if(en.rooted){ ctx.globalAlpha=0.4; ctx.fillStyle='#8a4a2a'; ctx.beginPath(); ctx.arc(en.x,en.y,er,0,7); ctx.fill(); ctx.globalAlpha=1; }
    else if(en.slowed){ ctx.globalAlpha=0.35; ctx.fillStyle='#5ab0e0'; ctx.beginPath(); ctx.arc(en.x,en.y,er,0,7); ctx.fill(); ctx.globalAlpha=1; }
    var visH=en.boss?(er*2.6):(er*1.6);
    var bw=en.boss?110:30;ctx.fillStyle='#000a';ctx.fillRect(en.x-bw/2,en.y-visH-10,bw,en.boss?6:4);
    ctx.fillStyle=en.boss?'#e07ab8':'#d06a55';ctx.fillRect(en.x-bw/2,en.y-visH-10,bw*Math.max(0,en.hp)/en.maxhp,en.boss?6:4);
    if(en.boss){ctx.fillStyle='#ffb0e0';ctx.font='bold 12px Trebuchet MS';ctx.textAlign='center';ctx.fillText('BOSS',en.x,en.y-visH-16);}
    else if(en.mname){ctx.fillStyle='#c9b896';ctx.font='10px Trebuchet MS';ctx.textAlign='center';ctx.fillText(en.mname,en.x,en.y-visH-14);}
    var stIc=''; if(en.wound>0)stIc+='🩸'; if(en.shred)stIc+='💢'; if(en.weak)stIc+='⬇️'; if(en.marked)stIc+='🎯'; if(en.arcmarked)stIc+='🔮'; if(en.ravenmarked)stIc+='🐦'; if(en.bladefrost)stIc+='🧊'; if(en.rooted)stIc+='⛓️'; else if(en.slowed)stIc+='❄️';
    if(stIc){ ctx.font='11px serif';ctx.textAlign='center';ctx.fillText(stIc,en.x,en.y-visH-(en.boss?24:16)); }}

  for(var li=0;li<loot.length;li++){var it=loot[li]; if(it.zone!==myZone)continue;
    var col=it.tier>=3?'#c77dff':(it.tier>=2?'#6bd0ff':'#9fe0a0');
    var yy=it.y+Math.sin(performance.now()/300+it.id)*2;
    ctx.save();ctx.translate(it.x,yy);
    ctx.rotate(0.785);ctx.fillStyle=col;ctx.shadowColor=col;ctx.shadowBlur=12;ctx.fillRect(-7,-7,14,14);ctx.shadowBlur=0;
    ctx.strokeStyle='#fff8';ctx.lineWidth=1;ctx.strokeRect(-7,-7,14,14);ctx.restore();
    var ic={wpn:'⚔️',arm:'🛡️',hlm:'🪖',rng:'💍',glv:'🧤',boot:'🥾',neck:'📿',wing:'🪽'}[it.slot]||'❔';
    ctx.font='11px Trebuchet MS';ctx.textAlign='center';ctx.fillText(ic,it.x,yy+4);}

  for(var ti=0;ti<myTraps.length;ti++){var tr=myTraps[ti]; if(tr.zone!==myZone)continue;
    var tp2=(Math.sin(performance.now()/260)+1)/2;
    ctx.save();ctx.globalAlpha=0.35+tp2*0.25;ctx.strokeStyle='#7fdc7a';ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(tr.x,tr.y,tr.r*(0.7+tp2*0.3),0,7);ctx.stroke();
    ctx.globalAlpha=0.7;ctx.font='13px serif';ctx.textAlign='center';ctx.fillText('🕸️',tr.x,tr.y+4);
    ctx.restore();}
  for(var ci=0;ci<myCrystals.length;ci++){var cy=myCrystals[ci]; if(cy.zone!==myZone)continue;
    var cp=(Math.sin(performance.now()/220)+1)/2;
    ctx.save();ctx.globalAlpha=0.25+cp*0.2;ctx.strokeStyle='#6bd0ff';ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(cy.x,cy.y,cy.r,0,7);ctx.stroke();
    ctx.globalAlpha=0.85;ctx.font='16px serif';ctx.textAlign='center';ctx.fillText('🔷',cy.x,cy.y+5);
    ctx.restore();}
  for(var wi=0;wi<myWells.length;wi++){var wl=myWells[wi]; if(wl.zone!==myZone)continue;
    ctx.save();ctx.strokeStyle='#c07aff';ctx.lineWidth=2;
    for(var wr=0;wr<3;wr++){var spin=performance.now()/500+wr*2.1;
      ctx.globalAlpha=0.3;
      ctx.beginPath();ctx.arc(wl.x,wl.y,wl.r*(0.35+wr*0.28),spin,spin+2.2);ctx.stroke();}
    ctx.globalAlpha=0.9;ctx.font='18px serif';ctx.textAlign='center';ctx.fillText('🌀',wl.x,wl.y+6);
    ctx.restore();}
  for(var ili=0;ili<myIllusions.length;ili++){var il=myIllusions[ili]; if(il.zone!==myZone)continue;
    var flick=0.35+0.25*Math.abs(Math.sin(performance.now()/150));
    ctx.save();ctx.globalAlpha=flick;
    ctx.fillStyle='hsl('+(il.hue||280)+',70%,60%)';ctx.strokeStyle='#fff';ctx.lineWidth=1.5;
    ctx.beginPath();ctx.arc(il.x,il.y,15,0,7);ctx.fill();ctx.stroke();
    ctx.globalAlpha=flick*0.8;ctx.font='11px serif';ctx.textAlign='center';ctx.fillText('👻',il.x,il.y-22);
    ctx.restore();}
  if(echoMark.active && echoMark.zone===myZone){
    if(performance.now()>echoMark.until){ echoMark.active=false; }
    else {
      var epulse=(Math.sin(performance.now()/200)+1)/2;
      ctx.save();ctx.globalAlpha=0.2+epulse*0.1;ctx.strokeStyle='#8ad6ff';ctx.lineWidth=1.5;ctx.setLineDash([4,6]);
      ctx.beginPath();ctx.arc(echoMark.x,echoMark.y,echoMark.maxDist,0,7);ctx.stroke();ctx.setLineDash([]);
      ctx.globalAlpha=0.55+epulse*0.35;ctx.strokeStyle='#8ad6ff';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(echoMark.x,echoMark.y,16,0,7);ctx.stroke();
      ctx.globalAlpha=0.9;ctx.font='16px serif';ctx.textAlign='center';ctx.fillText('⏳',echoMark.x,echoMark.y+5);
      ctx.restore();
    }
  }
  for(var bni=0;bni<myBanners.length;bni++){var bn=myBanners[bni]; if(bn.zone!==myZone)continue;
    var bpulse=(Math.sin(performance.now()/300)+1)/2;
    ctx.save();ctx.globalAlpha=0.15+bpulse*0.08;ctx.fillStyle='#ffd76b';ctx.beginPath();ctx.arc(bn.x,bn.y,bn.r,0,7);ctx.fill();
    ctx.globalAlpha=0.4;ctx.strokeStyle='#ffd76b';ctx.lineWidth=2;ctx.beginPath();ctx.arc(bn.x,bn.y,bn.r,0,7);ctx.stroke();
    ctx.globalAlpha=0.95;ctx.font='20px serif';ctx.textAlign='center';ctx.fillText('🚩',bn.x,bn.y-10);
    ctx.restore();}

  for(var b=0;b<bolts.length;b++){var bl=bolts[b]; if(bl.zone!==myZone)continue; var br=bl.r||6;var kind=bl.kind||'bolt';
    ctx.save();ctx.shadowColor='hsl('+bl.hue+',85%,65%)';ctx.shadowBlur=10;ctx.fillStyle='hsl('+bl.hue+',85%,65%)';ctx.strokeStyle='hsl('+bl.hue+',85%,70%)';
    if(kind==='arrow'){var ang=bl.a||0;ctx.translate(bl.x,bl.y);ctx.rotate(ang);ctx.lineWidth=3;
      ctx.beginPath();ctx.moveTo(-9,0);ctx.lineTo(9,0);ctx.stroke();ctx.beginPath();ctx.moveTo(9,0);ctx.lineTo(4,-3);ctx.lineTo(4,3);ctx.closePath();ctx.fill();}
    else if(kind==='orb'){ctx.beginPath();ctx.arc(bl.x,bl.y,br,0,7);ctx.fill();ctx.globalAlpha=.4;ctx.beginPath();ctx.arc(bl.x,bl.y,br+3,0,7);ctx.fill();ctx.globalAlpha=1;}
    else if(kind==='scepter'){ctx.beginPath();ctx.arc(bl.x,bl.y,br,0,7);ctx.fill();ctx.strokeStyle='#fff8';ctx.lineWidth=1;ctx.stroke();}
    else if(kind==='chain'){var ang2=bl.a||0,cx=Math.cos(ang2),cy2=Math.sin(ang2);
      ctx.strokeStyle='#c9a24a';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(bl.x,bl.y);ctx.lineTo(bl.x-cx*26,bl.y-cy2*26);ctx.stroke();
      for(var li=0;li<3;li++){var lx=bl.x-cx*(li*9+4),ly=bl.y-cy2*(li*9+4);
        ctx.strokeStyle='#8a6a2e';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(lx,ly,3,0,7);ctx.stroke();}
      ctx.fillStyle='#3a2a12';ctx.beginPath();ctx.arc(bl.x,bl.y,br,0,7);ctx.fill();ctx.strokeStyle='#c9a24a';ctx.lineWidth=1.5;ctx.stroke();}
    else if(kind==='blade'){var bang=Math.atan2(bl.vy,bl.vx);ctx.save();ctx.translate(bl.x,bl.y);ctx.rotate(bang);
      ctx.beginPath();ctx.moveTo(-16,0);ctx.lineTo(6,-6);ctx.lineTo(16,0);ctx.lineTo(6,6);ctx.closePath();ctx.fill();
      ctx.globalAlpha=0.4;ctx.beginPath();ctx.moveTo(-22,0);ctx.lineTo(-16,-4);ctx.lineTo(-16,4);ctx.closePath();ctx.fill();ctx.restore();}
    else {ctx.beginPath();ctx.arc(bl.x,bl.y,br,0,7);ctx.fill();}
    ctx.shadowBlur=0;ctx.restore();}

  for(var id in players){var p=players[id]; if(p.zone!==myZone)continue;
    var rx,ry,ffx,ffy;
    if(id==myId && myPX!==null && !p.dead){ rx=myPX;ry=myPY;ffx=myFX;ffy=myFY; }
    else { if(p._rx===undefined){p._rx=p.x;p._ry=p.y;} p._rx+=(p.x-p._rx)*0.4;p._ry+=(p.y-p._ry)*0.4; rx=p._rx;ry=p._ry;ffx=p.fx;ffy=p.fy; }
    var yOff=0;
    if(p.jumpT>0){ var jp=p.jumpT/0.4; yOff=-Math.sin(jp*Math.PI)*26*(p.jumpScale||1); }
    else if(p.levitateT>0){ yOff=-10-Math.sin(performance.now()/200)*3; }
    if(yOff!==0){ ctx.save();ctx.globalAlpha=0.3;ctx.fillStyle='#000';ctx.beginPath();ctx.ellipse(rx,ry+15,13,4,0,0,7);ctx.fill();ctx.restore(); ry+=yOff; }
    var bodyR=15;
    ctx.globalAlpha=p.dead?0.25:1;
    var bfa=Math.atan2(ffy,ffx);
    var _mvx=(p._prx!==undefined)?(rx-p._prx):0, _mvy=(p._pry!==undefined)?(ry-p._pry):0;
    drawPixelChar(rx,ry,p.hue,p.cls,ffx,ffy,(p._prx!==undefined&&(Math.abs(rx-p._prx)>0.15||Math.abs(ry-p._pry)>0.15)),_mvx,_mvy,(id==myId));
    p._prx=rx; p._pry=ry;
    if(p.cls==='blade' && !p.dead){ ctx.save();ctx.font='13px serif';ctx.textAlign='center';
      ctx.fillText(p.bladeStance==='arcane'?'🔮':'🗡️',rx+ffx*17,ry+ffy*17+4); ctx.restore(); }
    if(p.rooted){ ctx.globalAlpha=0.4; ctx.fillStyle='#8a4a2a'; ctx.beginPath(); ctx.arc(rx,ry,bodyR,0,7); ctx.fill(); ctx.globalAlpha=p.dead?0.25:1; }
    else if(p.slowed){ ctx.globalAlpha=0.35; ctx.fillStyle='#5ab0e0'; ctx.beginPath(); ctx.arc(rx,ry,bodyR,0,7); ctx.fill(); ctx.globalAlpha=p.dead?0.25:1; }
    
    if(p.sh){ctx.strokeStyle='#6bc4ff';ctx.lineWidth=2;ctx.globalAlpha=0.85;ctx.beginPath();ctx.arc(rx,ry,19,0,7);ctx.stroke();ctx.globalAlpha=p.dead?0.25:1;}
    if(p.mt){ctx.save();ctx.globalAlpha=0.55;ctx.fillStyle='#5a3a1a';ctx.beginPath();ctx.ellipse(rx,ry+16,20,9,0,0,7);ctx.fill();ctx.restore();}
    if(p.braceT>0){ ctx.save();ctx.globalAlpha=0.8;ctx.fillStyle='#c9a86a';ctx.strokeStyle='#8a6a2a';ctx.lineWidth=2;
      ctx.save();ctx.translate(rx+ffx*16,ry+ffy*16);ctx.rotate(Math.atan2(ffy,ffx));
      ctx.beginPath();ctx.ellipse(0,0,5,9,0,0,7);ctx.fill();ctx.stroke();ctx.restore(); ctx.restore(); }
    if(p.cls==='blade' && !p.dead){
      var bsPulse=(Math.sin(performance.now()/280)+1)/2;
      var bsCol=(p.bladeStance==='arcane')?'#a878ff':'#ff8a5a';
      ctx.save();ctx.globalAlpha=0.55+bsPulse*0.25;ctx.strokeStyle=bsCol;ctx.lineWidth=2.5;
      ctx.beginPath();ctx.arc(rx,ry,17+bsPulse*1.5,0,7);ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle='#000a';ctx.fillRect(rx-16,ry-46,32,4);
    ctx.fillStyle='#6fce6a';ctx.fillRect(rx-16,ry-46,32*Math.max(0,p.hp)/p.maxhp,4);
    ctx.fillStyle=(p.pk>=50)?'#ff4a4a':'#e8d8b8';ctx.font='11px Trebuchet MS';ctx.textAlign='center';ctx.fillText((p.name||('#'+id))+(p.pk>=50?' ☠️':''),rx,ry-50);
    var pStIc=''; if(p.wound>0)pStIc+='🩸'; if(p.shred)pStIc+='💢'; if(p.counter)pStIc+='🛡️'; if(p.warcryBuf)pStIc+='📯'; if(p.frenzy)pStIc+='🔥'; if(p.marked)pStIc+='🎯'; if(p.arcmarked)pStIc+='🔮'; if(p.ravenmarked)pStIc+='🐦'; if(p.bladefrost)pStIc+='🧊'; if(p.spellBladeArmed)pStIc+='✨'; if(p.resonanceActive)pStIc+='🌗'; if(p.dualityActive)pStIc+='☯️'+(p.dualityStacks||0); if(p.decreeBuf)pStIc+='📣'; if(p.decreeDebuf)pStIc+='😨'; if(p.sacrificeBuf)pStIc+='💔'; if(p.soulBuf)pStIc+='📖'; if(p.willActive)pStIc+='👑'; if(p.windguard)pStIc+='🍃'; if(p.wildhunt)pStIc+='🐾'; if(p.rooted)pStIc+='⛓️'; else if(p.slowed)pStIc+='❄️';
    if(pStIc){ ctx.font='11px serif'; ctx.fillText(pStIc,rx,ry-62); }
    ctx.globalAlpha=1;
  }

  ctx.textAlign='center';
  for(var g=dmgs.length-1;g>=0;g--){var dn=dmgs[g];dn.y-=42*dt;dn.life-=dt;if(dn.life<=0){dmgs.splice(g,1);continue;}
    ctx.globalAlpha=Math.max(0,dn.life/dn.max);
    ctx.font=(dn.big?'bold 22px':'bold 15px')+' Trebuchet MS';
    ctx.fillStyle=dn.gear?'#bfe0ff':(dn.gold?'#ffd76b':(dn.big?'#ffe07a':(dn.foe?'#ffe6ad':'#ff8a8a')));
    ctx.fillText(dn.val,dn.x,dn.y);}
  ctx.globalAlpha=1;

  if(aimState.active && meNow){
    var aimSk=null; var aimSid=myLoadout&&myLoadout[aimState.slot];
    for(var asi=0;asi<myFull.length;asi++){ if(myFull[asi].id===aimSid){ aimSk=myFull[asi]; break; } }
    if(aimSk && aimSk.type==='cmdadvance'){
      var apxC=(myPX!==null?myPX:meNow.x), apyC=(myPY!==null?myPY:meNow.y);
      var maxRC=aimSk.range||160;
      var oxC=apxC+aimState.dx*maxRC*aimState.mag, oyC=apyC+aimState.dy*maxRC*aimState.mag;
      var mySum=mySummons[myId];
      var hasSum=!!(mySum && mySum.zone===myZone);
      var sx=hasSum?mySum.x:apxC, sy=hasSum?mySum.y:apyC;
      if(hasSum){
        ctx.save();ctx.globalAlpha=0.22;ctx.strokeStyle='#ffcf6b';ctx.lineWidth=1.5;ctx.setLineDash([4,6]);
        ctx.beginPath();ctx.arc(sx,sy,aimSk.orderRange||maxRC,0,7);ctx.stroke();ctx.setLineDash([]);ctx.restore();
      }
      ctx.save();ctx.globalAlpha=0.5;ctx.strokeStyle=hasSum?'#ffcf6b':'#888';ctx.lineWidth=2;ctx.setLineDash([3,7]);
      ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(oxC,oyC);ctx.stroke();ctx.setLineDash([]);
      ctx.globalAlpha=0.9;
      var fa=Math.atan2(oyC-sy,oxC-sx);
      ctx.save();ctx.translate(oxC,oyC);ctx.rotate(fa);
      ctx.fillStyle=hasSum?'#ffcf6b':'#888';
      ctx.beginPath();ctx.moveTo(14,0);ctx.lineTo(-6,-9);ctx.lineTo(-6,9);ctx.closePath();ctx.fill();
      ctx.restore();
      if(!hasSum){ ctx.font='bold 12px Trebuchet MS';ctx.textAlign='center';ctx.fillStyle='#ff8a5a';ctx.fillText('Cần triệu hồi Cấm Vệ Quân trước',oxC,oyC-24); }
      ctx.restore();
    } else if(aimSk && aimSk.type==='banner'){
      var apxB=(myPX!==null?myPX:meNow.x), apyB=(myPY!==null?myPY:meNow.y);
      var maxRB=aimSk.range||160;
      var bxB=apxB+aimState.dx*maxRB*aimState.mag, byB=apyB+aimState.dy*maxRB*aimState.mag;
      ctx.save();ctx.globalAlpha=0.18;ctx.fillStyle='#ffd76b';ctx.beginPath();ctx.arc(bxB,byB,aimSk.radius||150,0,7);ctx.fill();
      ctx.globalAlpha=0.5;ctx.strokeStyle='#ffd76b';ctx.lineWidth=2;ctx.setLineDash([5,5]);
      ctx.beginPath();ctx.arc(bxB,byB,aimSk.radius||150,0,7);ctx.stroke();
      ctx.beginPath();ctx.moveTo(apxB,apyB);ctx.lineTo(bxB,byB);ctx.stroke();ctx.setLineDash([]);
      ctx.globalAlpha=0.95;ctx.strokeStyle='#8a6a2a';ctx.lineWidth=2;
      ctx.beginPath();ctx.moveTo(bxB,byB+16);ctx.lineTo(bxB,byB-14);ctx.stroke();
      ctx.fillStyle='#ffd76b';ctx.beginPath();ctx.moveTo(bxB,byB-14);ctx.lineTo(bxB+16,byB-9);ctx.lineTo(bxB,byB-4);ctx.closePath();ctx.fill();
      ctx.restore();
    } else if(aimSk && (aimSk.type==='arcanedet'||aimSk.type==='blooddebt'||aimSk.type==='warlordverdict'||aimSk.type==='ravenmark'||aimSk.type==='tacticalrecall'||aimSk.type==='wildhunt'||aimSk.type==='lifesteal'||aimSk.type==='bloodsword')){
      var apx0=(myPX!==null?myPX:meNow.x), apy0=(myPY!==null?myPY:meNow.y);
      var maxR0=aimSk.range||160;
      ctx.save();ctx.globalAlpha=0.22;ctx.strokeStyle='#ffb060';ctx.lineWidth=1.5;ctx.setLineDash([4,6]);
      ctx.beginPath();ctx.arc(apx0,apy0,maxR0,0,7);ctx.stroke();ctx.setLineDash([]);ctx.restore();
      var hax0=apx0+aimState.dx*maxR0*aimState.mag, hay0=apy0+aimState.dy*maxR0*aimState.mag;
      var bestD0=32,bestX0=0,bestY0=0,bestR0=15,found0=false;
      for(var heid0 in enemies){var he0=enemies[heid0]; if(he0.dead||he0.zone!==myZone)continue; var hd0=Math.hypot(he0.x-hax0,he0.y-hay0); if(hd0<bestD0){bestD0=hd0;bestX0=he0.x;bestY0=he0.y;bestR0=(he0.r||14)+6;found0=true;}}
      for(var hpid0 in players){ if(hpid0==myId)continue; var ho0=players[hpid0]; if(!ho0.chosen||ho0.dead||ho0.zone!==myZone)continue; var hd1=Math.hypot(ho0.x-hax0,ho0.y-hay0); if(hd1<bestD0){bestD0=hd1;bestX0=ho0.x;bestY0=ho0.y;bestR0=21;found0=true;}}
      ctx.save();ctx.globalAlpha=0.95;ctx.strokeStyle=found0?'#ffe070':'#ff6a5a';ctx.lineWidth=3;
      ctx.beginPath();ctx.moveTo(hax0-17,hay0);ctx.lineTo(hax0-6,hay0);ctx.moveTo(hax0+6,hay0);ctx.lineTo(hax0+17,hay0);
      ctx.moveTo(hax0,hay0-17);ctx.lineTo(hax0,hay0-6);ctx.moveTo(hax0,hay0+6);ctx.lineTo(hax0,hay0+17);ctx.stroke();
      ctx.beginPath();ctx.arc(hax0,hay0,11,0,7);ctx.stroke();
      ctx.restore();
      if(found0){ ctx.save();ctx.globalAlpha=0.9;ctx.strokeStyle='#ffe070';ctx.lineWidth=3;ctx.beginPath();ctx.arc(bestX0,bestY0,bestR0,0,7);ctx.stroke();ctx.restore(); }
    } else if(aimSk){
      var apx=(myPX!==null?myPX:meNow.x), apy=(myPY!==null?myPY:meNow.y);
      var maxR=aimSk.range||160, curR=maxR*aimState.mag;
      var tx2=apx+aimState.dx*curR, ty2=apy+aimState.dy*curR;
      ctx.save();ctx.globalAlpha=0.22;ctx.strokeStyle='#ffb060';ctx.lineWidth=1.5;ctx.setLineDash([4,6]);
      ctx.beginPath();ctx.arc(apx,apy,maxR,0,7);ctx.stroke();ctx.setLineDash([]);ctx.restore();
      ctx.save();ctx.globalAlpha=0.55;ctx.strokeStyle='#ffb060';ctx.fillStyle='#ffb06030';ctx.lineWidth=2;
      if(aimSk.type==='trap'||aimSk.type==='frostprism'||aimSk.type==='gravitywell'){
        ctx.beginPath();ctx.arc(tx2,ty2,aimSk.radius||60,0,7);ctx.fill();ctx.stroke();
        ctx.beginPath();ctx.moveTo(apx,apy);ctx.lineTo(tx2,ty2);ctx.setLineDash([5,5]);ctx.stroke();ctx.setLineDash([]);
      } else if(aimSk.arc && aimSk.arc>0.3 && !aimSk.len){
        var fa2=Math.atan2(aimState.dy,aimState.dx);
        ctx.beginPath();ctx.moveTo(apx,apy);ctx.arc(apx,apy,maxR,fa2-aimSk.arc,fa2+aimSk.arc);ctx.closePath();ctx.fill();ctx.stroke();
      } else if(aimSk.len && aimSk.width){
        var fa3=Math.atan2(aimState.dy,aimState.dx);
        ctx.save();ctx.translate(apx,apy);ctx.rotate(fa3);
        ctx.fillRect(0,-aimSk.width/2,aimSk.len,aimSk.width);ctx.strokeRect(0,-aimSk.width/2,aimSk.len,aimSk.width);
        ctx.restore();
      } else {
        ctx.beginPath();ctx.moveTo(apx,apy);ctx.lineTo(apx+aimState.dx*maxR,apy+aimState.dy*maxR);ctx.lineWidth=4;ctx.stroke();
      }
      if(aimSk.type==='huntmark'){
        var hax=apx+aimState.dx*maxR*aimState.mag, hay=apy+aimState.dy*maxR*aimState.mag;
        var bestD=60,bestX=0,bestY=0,bestR=15,found=false;
        for(var heid in enemies){var he=enemies[heid]; if(he.dead||he.zone!==myZone)continue; var hd=Math.hypot(he.x-hax,he.y-hay); if(hd<bestD){bestD=hd;bestX=he.x;bestY=he.y;bestR=(he.r||14)+6;found=true;}}
        for(var hpid in players){ if(hpid==myId)continue; var ho=players[hpid]; if(!ho.chosen||ho.dead||ho.zone!==myZone)continue; var hd2=Math.hypot(ho.x-hax,ho.y-hay); if(hd2<bestD){bestD=hd2;bestX=ho.x;bestY=ho.y;bestR=21;found=true;}}
        ctx.save();ctx.globalAlpha=0.85;ctx.strokeStyle=found?'#ffe070':'#ff5a5a';ctx.lineWidth=2;
        ctx.beginPath();ctx.moveTo(hax-10,hay);ctx.lineTo(hax+10,hay);ctx.moveTo(hax,hay-10);ctx.lineTo(hax,hay+10);ctx.stroke();
        ctx.beginPath();ctx.arc(hax,hay,6,0,7);ctx.stroke();
        ctx.restore();
        if(found){ ctx.save();ctx.globalAlpha=0.9;ctx.strokeStyle='#ffe070';ctx.lineWidth=3;ctx.beginPath();ctx.arc(bestX,bestY,bestR,0,7);ctx.stroke();ctx.restore(); }
      }
      ctx.restore();
    }
  }

  ctx.restore(); // hết camera-space

  ctx.restore();

  if(joy.active){ctx.globalAlpha=.32;ctx.fillStyle='#000';ctx.beginPath();ctx.arc(joy.bx,joy.by,RAD,0,7);ctx.fill();
    ctx.globalAlpha=.9;ctx.strokeStyle='#e0b062';ctx.lineWidth=2;ctx.beginPath();ctx.arc(joy.bx,joy.by,RAD,0,7);ctx.stroke();
    ctx.fillStyle='#e0b062';ctx.beginPath();ctx.arc(joy.kx,joy.ky,20,0,7);ctx.fill();ctx.globalAlpha=1;}

  if(aimState.active && !aimState.cancelZone){
    var ex=aimState.ox+aimState.dx*aimState.mag*AIM_MAX_PX, ey=aimState.oy+aimState.dy*aimState.mag*AIM_MAX_PX;
    ctx.save();ctx.globalAlpha=.85;ctx.fillStyle='#ff9a4a';ctx.beginPath();ctx.arc(ex,ey,8,0,7);ctx.fill();
    ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.beginPath();ctx.arc(ex,ey,8,0,7);ctx.stroke();
    ctx.restore();
  }
  if(cancelHover.active && cancelHover.cancelZone){
    ctx.save();ctx.globalAlpha=.55;ctx.fillStyle='#ff3a3a';ctx.beginPath();ctx.arc(cancelHover.x,cancelHover.y,cancelHover.r+8,0,7);ctx.fill();
    ctx.strokeStyle='#fff';ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(cancelHover.x-11,cancelHover.y-11);ctx.lineTo(cancelHover.x+11,cancelHover.y+11);
    ctx.moveTo(cancelHover.x+11,cancelHover.y-11);ctx.lineTo(cancelHover.x-11,cancelHover.y+11);ctx.stroke();
    ctx.font='bold 14px Trebuchet MS';ctx.textAlign='center';ctx.fillStyle='#fff';ctx.globalAlpha=.9;ctx.fillText('Hủy skill',cancelHover.x,cancelHover.y-cancelHover.r-14);
    ctx.restore();
  }
  if(chargeState.active){
    var held=performance.now()-chargeState.startT;
    var tier=held<200?0:held<700?1:held<1200?2:3;
    var tierCol=['#8a8a8a','#ffd76b','#ff9a4a','#ff4a4a'][tier];
    var btnEl=document.getElementById({q:'sQ',w:'sW',e:'sE',r:'sR'}[chargeState.slot]);
    if(btnEl){ var br2=btnEl.getBoundingClientRect(); var bcx=br2.left+br2.width/2, bcy=br2.top+br2.height/2;
      var prog=Math.min(1,held/1200);
      ctx.save();ctx.strokeStyle=tierCol;ctx.lineWidth=4;ctx.globalAlpha=.9;
      ctx.beginPath();ctx.arc(bcx,bcy,br2.width/2+6,-Math.PI/2,-Math.PI/2+prog*Math.PI*2);ctx.stroke();
      ctx.restore();
    }
  }
 }catch(e){}
  requestAnimationFrame(frame);
}
function updateBtns(){
  var me=players[myId];
  var map=[['sB','b'],['sQ','q'],['sW','w'],['sE','e'],['sR','r']];
  for(var i=0;i<map.length;i++){var el=document.getElementById(map[i][0]),k=map[i][1];
    el.querySelector('.cd').style.setProperty('--d',(cd[k]/SKdur[k]*360)+'deg');
    el.classList.toggle('nomana', me && SKmp[k]>0 && me.mp<SKmp[k]);
    el.classList.toggle('comboReady', comboPrompt.active && comboPrompt.slot===k);}
  if(comboPrompt.active && performance.now()>comboPrompt.until){ comboPrompt.active=false; }
}
requestAnimationFrame(frame);
['soc','guild','npc','shop','q','chr','inv','pet'].forEach(function(p){
  var xb=document.getElementById(p+'X'); var cb=document.getElementById(p+'Close');
  if(xb&&cb)xb.addEventListener('pointerdown',function(ev){ev.preventDefault();
    cb.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}));});
});
</script></body></html>`;

// ------------------------------------------------------------
// SERVER
// ------------------------------------------------------------
// ---- KHIÊN CHỐNG SẬP: 1 kết nối lỗi (mất mạng, khung dữ liệu hỏng...) KHÔNG được kéo sập cả server ----
process.on('uncaughtException', (err) => { console.error('⚠️ Lỗi không bắt được (đã chặn, server vẫn sống):', err && err.message); });
process.on('unhandledRejection', (err) => { console.error('⚠️ Promise lỗi (đã chặn, server vẫn sống):', err); });

const server = http.createServer((req,res)=>{
  res.writeHead(200, {
    'Content-Type':'text/html; charset=utf-8',
    'Cache-Control':'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma':'no-cache',
    'Expires':'0',
  });
  res.end(CLIENT);
});
const wss = new WebSocketServer({ server });
wss.on('error', (err) => { console.error('⚠️ Lỗi WebSocketServer (đã chặn):', err && err.message); });

// ==================== LƯU TRỮ THẬT (Postgres/Supabase qua DATABASE_URL) ====================
// Tài khoản (username+password) → tối đa 3 ô nhân vật/tài khoản, đúng chuẩn MMORPG thật.
const crypto = require('crypto');
const SAVE_FIELDS = ['charDisplayName','cls','lv','xp','xpNext','gold','stones','STR','VIT','AGI','INT','statPts','skillPts',
  'skRank','loadout','inv','equip','zone','x','y','qk','qc','dailyDate','checkinStreak','checkedToday',
  'npcAccepted','npcClaimed','cum','dungeonEntries','dungeonDate','mounts','mounted','pet','guild','pkScore',
  'gemCount','baseMaxhp','baseMaxmp'];
function hashPass(pass,salt){ return crypto.scryptSync(pass,salt,64).toString('hex'); }
async function dbInit(){
  if(!dbPool)return console.log('⚠️ Chưa có DATABASE_URL — chạy KHÔNG LƯU TRỮ (dữ liệu mất khi restart, chỉ dùng để test tạm).');
  try{
    await dbPool.query(`CREATE TABLE IF NOT EXISTS accounts (
      username TEXT PRIMARY KEY, salt TEXT NOT NULL, pass_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
    await dbPool.query(`CREATE TABLE IF NOT EXISTS characters (
      username TEXT NOT NULL REFERENCES accounts(username), slot INT NOT NULL, data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY(username,slot))`);
    console.log('✅ Database sẵn sàng (bảng accounts + characters).');
  }catch(err){
    console.error('⚠️ Lỗi kết nối database lúc khởi động:', err && err.message);
    if(err && err.message && err.message.includes('ENETUNREACH') && err.message.includes('::')){
      console.error('👉 Đây là lỗi IPv6 — DATABASE_URL đang dùng "Direct connection" của Supabase (db.xxx.supabase.co). Đổi sang chuỗi "Transaction pooler" (dạng aws-0-xxx.pooler.supabase.com:6543) trong Supabase → Connect, rồi cập nhật lại DATABASE_URL trên Render.');
    }
  }
}
// Trả về: {ok, reason} — reason: 'wrongpass' | 'dberror'. Tự tạo tài khoản mới nếu username chưa tồn tại (đăng ký ngay lúc đăng nhập lần đầu).
async function dbAuth(username,password){
  if(!dbPool)return {ok:false,reason:'nodb'};
  try{
    const r=await dbPool.query('SELECT salt,pass_hash FROM accounts WHERE username=$1',[username]);
    if(r.rows.length===0){
      const salt=crypto.randomBytes(16).toString('hex'); const hash=hashPass(password,salt);
      await dbPool.query('INSERT INTO accounts(username,salt,pass_hash) VALUES($1,$2,$3)',[username,salt,hash]);
      return {ok:true,isNew:true};
    }
    const row=r.rows[0]; const hash=hashPass(password,row.salt);
    if(hash!==row.pass_hash) return {ok:false,reason:'wrongpass'};
    return {ok:true,isNew:false};
  }catch(err){ console.error('⚠️ Lỗi đăng nhập "'+username+'":', err && err.message); return {ok:false,reason:'dberror'}; }
}
async function dbLoadSlots(username){
  if(!dbPool)return [null,null,null];
  try{
    const r=await dbPool.query('SELECT slot,data FROM characters WHERE username=$1',[username]);
    const slots=[null,null,null];
    for(const row of r.rows){ if(row.slot>=1&&row.slot<=3) slots[row.slot-1]=row.data; }
    return slots;
  }catch(err){ console.error('⚠️ Lỗi tải danh sách nhân vật "'+username+'":', err && err.message); return [null,null,null]; }
}
async function dbSaveChar(username,slot,p){
  if(!dbPool||!username||!slot||!p.chosen)return;
  try{
    const data={}; for(const f of SAVE_FIELDS) data[f]=p[f];
    await dbPool.query(`INSERT INTO characters(username,slot,data,updated_at) VALUES($1,$2,$3,NOW())
      ON CONFLICT(username,slot) DO UPDATE SET data=$3, updated_at=NOW()`,[username,slot,JSON.stringify(data)]);
  }catch(err){ console.error('⚠️ Lỗi lưu nhân vật "'+username+'" ô '+slot+':', err && err.message); }
}

const players = {};
const enemies = {};
let bolts = [];
let loot = [];
let traps = [];
let crystals = [];
let wells = [];
let illusions = [];
let banners = [];
let dotZones = [];
const sockets = {};
let nextP = 1, nextE = 1, nextL = 1;

const MOB_TYPES = {
  forest: [
    {id:'wolf', name:'Ác Thú Rừng', hue:22, hpMul:0.8, spdMul:1.35, dmgMul:0.9, shape:'wolf'},
    {id:'spider', name:'Nhện Độc', hue:280, hpMul:1.0, spdMul:1.0, dmgMul:1.1, shape:'spider'},
    {id:'goblin', name:'Yêu Tinh Lá', hue:100, hpMul:1.3, spdMul:0.8, dmgMul:1.0, shape:'goblin'},
    {id:'fmush', name:'Nấm Rừng', hue:0, hpMul:1.0, spdMul:0.7, dmgMul:1.0, shape:'mushroom'},
    {id:'fslime', name:'Nhớt Xanh', hue:100, hpMul:1.3, spdMul:0.55, dmgMul:0.85, shape:'slime'},
  ],
  cave: [
    {id:'bat', name:'Trùng Băng', hue:200, hpMul:0.7, spdMul:1.5, dmgMul:0.85, shape:'bat'},
    {id:'beetle', name:'Bọ Đá', hue:40, hpMul:1.6, spdMul:0.6, dmgMul:1.0, shape:'beetle'},
    {id:'wraith', name:'Ma Sương', hue:220, hpMul:1.0, spdMul:1.0, dmgMul:1.2, shape:'ghost'},
    {id:'cserpent', name:'Rắn Băng', hue:200, hpMul:1.1, spdMul:1.05, dmgMul:1.1, shape:'snake'},
    {id:'cimp', name:'Quỷ Băng', hue:200, hpMul:0.9, spdMul:1.2, dmgMul:1.15, shape:'imp'},
  ],
  dungeon: [
    {id:'skeleton', name:'Xương Cổ', hue:48, hpMul:1.2, spdMul:0.9, dmgMul:1.1, shape:'skeleton'},
    {id:'shade', name:'Bóng Đêm', hue:265, hpMul:0.9, spdMul:1.2, dmgMul:1.05, shape:'shade'},
    {id:'dwraith', name:'Oán Linh', hue:280, hpMul:1.1, spdMul:1.0, dmgMul:1.25, shape:'ghost'},
    {id:'deye', name:'Mắt Quỷ', hue:330, hpMul:0.9, spdMul:1.1, dmgMul:1.25, shape:'eyeball'},
    {id:'dworm', name:'Giòi Cổ', hue:20, hpMul:1.4, spdMul:0.7, dmgMul:1.1, shape:'worm'},
  ],
  swamp: [
    {id:'mushroom', name:'Nấm Độc', hue:0, hpMul:1.1, spdMul:0.7, dmgMul:1.1, shape:'mushroom'},
    {id:'imp', name:'Tiểu Quỷ', hue:0, hpMul:1.0, spdMul:1.15, dmgMul:1.15, shape:'imp'},
    {id:'sgoblin', name:'Yêu Tinh Xanh', hue:120, hpMul:1.2, spdMul:1.0, dmgMul:1.0, shape:'goblin'},
    {id:'slime', name:'Nhớt Độc', hue:90, hpMul:1.5, spdMul:0.55, dmgMul:0.9, shape:'slime'},
    {id:'sskel', name:'Xương Khô', hue:48, hpMul:1.15, spdMul:1.0, dmgMul:1.2, shape:'skeleton'},
    {id:'turtle', name:'Rùa Đá', hue:140, hpMul:1.8, spdMul:0.5, dmgMul:1.0, shape:'turtle'},
  ],
};
function spawnEnemy(zone){
  const id = nextE++; const z=ZONES[zone];
  const edge = Math.floor(Math.random()*4), m=40; let x,y;
  if(edge===0){x=Math.random()*z.w;y=m;} else if(edge===1){x=z.w-m;y=Math.random()*z.h;}
  else if(edge===2){x=Math.random()*z.w;y=z.h-m;} else {x=m;y=Math.random()*z.h;}
  const tier=z.tier||1;
  const pool=MOB_TYPES[zone]||MOB_TYPES.forest; const mt=pool[Math.floor(Math.random()*pool.length)];
  const hp=Math.round(70*tier*mt.hpMul);
  enemies[id]={x,y,zone,hp,maxhp:hp,spd:Math.round(52*mt.spdMul),atk:0,dead:false,respawnT:0,xp:24*tier,gold:6*tier,r:14,boss:false,
    dmg:Math.round(6*tier*mt.dmgMul),mtype:mt.id,mname:mt.name,mhue:mt.hue,mshape:mt.shape};
}
function spawnBoss(zone){
  const id=nextE++; const z=ZONES[zone]; const tier=z.tier||1;
  let lx,ly;
  if(zone==='forest'){ lx=z.w-180; ly=180; }          // hang sâu góc xa cổng vào
  else if(zone==='cave'){ lx=180; ly=z.h-180; }
  else if(zone==='swamp'){ lx=z.w-200; ly=z.h-200; }
  else { lx=z.w/2; ly=140; }                            // dungeon & khác
  enemies[id]={x:lx,y:ly,zone,hp:1800*tier,maxhp:1800*tier,spd:40,atk:0,dead:false,respawnT:0,xp:600*tier,gold:200*tier,r:34,boss:true,dmg:30*tier,lairX:lx,lairY:ly,leash:380};
}
for(let i=0;i<4;i++) spawnEnemy('forest');
for(let i=0;i<5;i++) spawnEnemy('cave');
for(let i=0;i<6;i++) spawnEnemy('dungeon');
for(let i=0;i<8;i++) spawnEnemy('swamp');
spawnBoss('dungeon'); // Mật Thất: boss luôn chờ sẵn, vé vào mới là cửa ải (kiểu Blood Castle)

// ---- BOSS THẾ GIỚI: xuất hiện tại HANG SÂU của map, giữ hang (không lòng vòng), timer dài ----
const BOSS_CFG = { forest:{interval:900, active:3600}, cave:{interval:1200, active:3600}, swamp:{interval:1500, active:3600} };
const zoneBoss = { forest:{phase:'countdown', t:BOSS_CFG.forest.interval}, cave:{phase:'countdown', t:BOSS_CFG.cave.interval}, swamp:{phase:'countdown', t:BOSS_CFG.swamp.interval} };
function despawnZoneBoss(zone){
  for(const eid in enemies){ const e=enemies[eid]; if(e.zone===zone&&e.boss&&!e.dead){ delete enemies[eid]; break; } }
}
function tickBossSchedule(dt){
  for(const zone in zoneBoss){
    const st=zoneBoss[zone], cfg=BOSS_CFG[zone];
    st.t-=dt;
    if(st.phase==='countdown' && st.t<=0){
      spawnBoss(zone); st.phase='active'; st.t=cfg.active;
      bcast({t:'toast',text:'⚔️ BOSS đã xuất hiện tại '+ZONES[zone].name+'!'});
    } else if(st.phase==='active' && st.t<=0){
      despawnZoneBoss(zone); st.phase='countdown'; st.t=cfg.interval;
      bcast({t:'toast',text:'Boss '+ZONES[zone].name+' đã rút lui...'});
    }
  }
}

wss.on('connection',(ws)=>{
  ws.on('error', (err) => { console.error('⚠️ Lỗi 1 kết nối (đã chặn, không ảnh hưởng người khác):', err && err.message); });
  const id = nextP++;
  players[id]={x:400+Math.random()*100,y:300+Math.random()*100,zone:'town',ix:0,iy:0,fx:0,fy:1,chosen:false,cls:null,
    hp:100,maxhp:100,mp:100,maxmp:100,spd:250,hue:(id*67)%360,dead:false,respawnT:0,iframe:0,hurtT:9,
    lv:1,xp:0,xpNext:100,gold:0,stones:0,atkPow:0,baseMaxhp:100,gearAtk:0,gearHp:0,inv:[],equip:emptyEquip(),
    buffT:0,buffAtk:0,buffSpdMul:1,
    STR:0,VIT:0,AGI:0,INT:0,statPts:0,skillPts:0,skRank:{},loadout:null,
    shieldHP:0,shieldT:0,slowT:0,slowMul:1,
    passT:0,comboN:0,comboTgt:null,spellBladeT:0,party:null,pendingInvite:null,guild:null,fervor:0,focus:0,momentum:0,arcane:0,authority:0,counterT:0,counterDmg:0,momT:0,
    warcryDefT:0,warcryDefMul:1,debtT:0,debtAmount:0,debtTargetObj:null,debtIsEnemy:false,debtBankPct:0.3,lastStandT:0,momGenBonus:0,
    duelT:0,duelTargetObj:null,duelIsEnemy:false,duelElapsed:0,duelGrowth:0.15,duelTickT:0,duelBaseDmg:10,
    chargeStart:{},chargeMul:1,chargeTier:0,comboState:null,channelState:null,echoPos:null,echoExpire:0,bladeStance:'blade',stanceSwapCd:0,
    huntTargetObj:null,huntStack:0,windguardT:0,windguardArc:0.9,windguardMul:1,windguardFx:0,windguardFy:1,
    wildHuntT:0,wildHuntTargetObj:null,aspdBonusWH:0,rhythmFx:0,rhythmFy:1,rhythmT:0,rhythmReady:false,
    cum:{killForest:0,killCave:0,bossForest:0,bossCave:0},npcAccepted:{},npcClaimed:{},nearNpc:null,
    dungeonDate:null,dungeonEntries:3,pet:null,mounts:[],mounted:null,fusedT:0,fusionCd:0,hspet:null,hspetApplied:null,
    gemCount:{hoa:0,thuy:0,moc:0,tho:0,kim:0},gemBonus:null,pkScore:0,jailed:0,summon:null,
    basicType:'melee',basicRange:90,basicDmg:18,basicCd:0.45,basicSpd:0,basicR:6,basicKind:'melee',
    cd:{b:0,q:0,w:0,e:0,r:0},charUser:null,charSlot:null};
  ws.pid=id; sockets[id]=ws;
  ws.send(JSON.stringify({t:'welcome',id,obstacles:ZOBS}));
  ws.send(JSON.stringify({t:'zones',zones:ZONES}));
  ws.send(JSON.stringify({t:'npcs',npcs:NPCS}));
  ws.send(JSON.stringify({t:'pettypes',types:PET_TYPES}));
  ws.send(JSON.stringify({t:'mounttypes',types:MOUNTS}));
  ws.send(JSON.stringify({t:'gemtypes',types:GEM_TYPES}));

  ws.on('message',(buf)=>{
    let m; try{m=JSON.parse(buf.toString());}catch(e){return;}
    const p=players[id]; if(!p)return;
    if(m.t==='authlogin'){
      const user=(''+(m.user||'')).trim().slice(0,20);
      const pass=''+(m.pass||'');
      if(!user||pass.length<3){ sendTo(id,{t:'authresult',ok:false,reason:'invalid'}); return; }
      dbAuth(user,pass).then(r=>{
        if(!r.ok){ sendTo(id,{t:'authresult',ok:false,reason:r.reason}); return; }
        p.charUser=user;
        dbLoadSlots(user).then(slots=>{
          const summary=slots.map(s=>s?{cls:s.cls,lv:s.lv||1}:null);
          sendTo(id,{t:'authresult',ok:true,isNew:r.isNew,slots:summary});
        });
      });
      return;
    }
    if(m.t==='selectslot'){
      const slot=m.slot|0; if(!p.charUser||slot<1||slot>3)return;
      dbLoadSlots(p.charUser).then(slots=>{
        const saved=slots[slot-1];
        p.charSlot=slot;
        if(saved && saved.cls && CLASSES[saved.cls]){
          const c=CLASSES[saved.cls];
          Object.assign(p,saved);
          if(!p.baseMaxmp) p.baseMaxmp=c.mp; // tự vá nhân vật đã lỡ lưu thiếu field này trước bản sửa lỗi mana
          p.chosen=true; p.hue=c.hue; p.spd=c.spd;
          p.basicType=c.basic.type; p.basicRange=c.basic.range; p.basicDmg=c.basic.dmg; p.basicCd=c.basic.cd;
          p.basicSpd=c.basic.spd||0; p.basicR=c.basic.r||6; p.basicKind=c.basic.kind||'melee';
          p.iframe=2; recompute(p); p.hp=p.maxhp; p.mp=p.maxmp;
          sendInv(p,id); sendTo(id,{t:'skills',meta:skillMeta(p),passive:PASSIVES[p.cls],full:fullSkillList(p),loadout:p.loadout}); sendQuests(p,id); sendGuildData(id);
          sendTo(id,{t:'mounts',owned:p.mounts,mounted:p.mounted});
          ensureDungeon(p); sendTo(id,{t:'dungeon',entries:p.dungeonEntries,max:DUNGEON_MAX_ENTRIES});
          sendTo(id,{t:'slotresult',ok:true,returning:true,name:p.charDisplayName});
          console.log('👤 "'+p.charUser+'" ô '+slot+' — khôi phục nhân vật '+saved.cls+' Lv'+(saved.lv||1));
        } else {
          sendTo(id,{t:'slotresult',ok:true,returning:false});
        }
      });
      return;
    }
    if(m.t==='pick'){
      const c=CLASSES[m.c]; if(!c||p.chosen)return;
      try{
        p.charDisplayName=(''+(m.name||'')).trim().slice(0,16)||('#'+id);
        p.cls=m.c; p.chosen=true; p.hue=c.hue; p.spd=c.spd;
        p.baseMaxhp=c.hp; p.baseMaxmp=c.mp; p.gearAtk=0; p.gearHp=0; p.inv=[]; p.equip=emptyEquip();
        p.maxhp=c.hp; p.hp=c.hp; p.maxmp=c.mp; p.mp=c.mp;
        p.basicType=c.basic.type; p.basicRange=c.basic.range; p.basicDmg=c.basic.dmg; p.basicCd=c.basic.cd;
        p.basicSpd=c.basic.spd||0; p.basicR=c.basic.r||6; p.basicKind=c.basic.kind||'melee';
        p.zone='town'; p.x=400+Math.random()*100; p.y=300+Math.random()*100; p.iframe=2;
        p.buffT=0; p.STR=0;p.VIT=0;p.AGI=0;p.INT=0;p.statPts=0;p.skillPts=0;p.skRank={};
        p.loadout={q:null,w:null,e:null,r:null}; // bắt đầu trống — chỉ đánh thường, skill mở khóa dần theo cấp
        p.shieldHP=0;p.shieldT=0;p.slowT=0;p.slowMul=1;
        p.passT=0;p.comboN=0;p.comboTgt=null;p.spellBladeT=0;p.resonanceT=0;p.dualityT=0;p.dualityStacks=0; recompute(p);
        sendInv(p,id); sendTo(id,{t:'skills',meta:skillMeta(p),passive:PASSIVES[p.cls],full:fullSkillList(p),loadout:p.loadout}); sendQuests(p,id); sendGuildData(id);
        sendTo(id,{t:'mounts',owned:p.mounts,mounted:p.mounted});
        ensureDungeon(p); sendTo(id,{t:'dungeon',entries:p.dungeonEntries,max:DUNGEON_MAX_ENTRIES});
        if(p.charUser&&p.charSlot) dbSaveChar(p.charUser,p.charSlot,p);
      }catch(err){
        console.error('⚠️ Lỗi khi #'+id+' chọn class '+m.c+':', err && err.message);
        p.chosen=false; // cho phép thử chọn lại thay vì kẹt màn hình trống
        sendTo(id,{t:'toast',text:'Lỗi khi vào game, thử chọn lại class.'});
      }
      return;
    }
    if(!p.chosen||p.dead)return;
    if(m.t==='input'){
      p.ix=clamp(m.x); p.iy=clamp(m.y);
      const d=Math.hypot(p.ix,p.iy); if(d>0.2){p.fx=p.ix/d;p.fy=p.iy/d;}
    } else if(m.t==='skill'){ doSkill(id,m.k,m.aim); }
    else if(m.t==='chargestart'){
      const p=players[id]; if(!p||p.dead)return;
      const sid=p.loadout&&p.loadout[m.k]; const sk=findSkill(p.cls,sid);
      if(!sk||!sk.chargeable)return;
      if(!p.chargeStart)p.chargeStart={};
      p.chargeStart[m.k]=Date.now();
    }
    else if(m.t==='channelstart'){
      const p=players[id]; if(!p||p.dead)return;
      const sid=p.loadout&&p.loadout[m.k]; const sk=findSkill(p.cls,sid);
      if(!sk||!sk.channelable||p.channelState)return;
      if(p.cd[m.k]>0||p.mp<sk.mp)return;
      p.mp-=sk.mp;
      p.channelState={skillId:sid,slot:m.k,elapsed:0,tickT:0,maxDur:sk.channelDur||2.0};
    }
    else if(m.t==='channelaim'){
      const p=players[id]; if(!p||!p.channelState)return;
      const d=Math.hypot(m.dx||0,m.dy||0); if(d>0.1){ p.fx=m.dx/d; p.fy=m.dy/d; }
    }
    else if(m.t==='channelend'){
      const p=players[id]; if(!p||!p.channelState||p.channelState.slot!==m.k)return;
      const sk=findSkill(p.cls,p.channelState.skillId);
      if(sk){ p.cd[m.k]=Math.max(0.3,sk.cd-(p.INT||0)*0.02); sendTo(id,{t:'skillcd',slot:m.k,dur:p.cd[m.k]}); }
      p.channelState=null;
    }
    else if(m.t==='swapstance'){
      const p=players[id]; if(!p||p.dead||p.cls!=='blade')return;
      const inDuality=(p.dualityT||0)>0;
      if(!inDuality && (p.stanceSwapCd||0)>0)return;
      p.bladeStance=(p.bladeStance==='arcane')?'blade':'arcane';
      p.stanceSwapCd=inDuality?0.1:0.6;
      if(p.bladeStance==='blade'){ p.x+=p.fx*18; p.y+=p.fy*18; } else { p.x-=p.fx*14; p.y-=p.fy*14; }
      clampPos(p);
      if(inDuality) p.dualityStacks=Math.min(5,(p.dualityStacks||0)+1);
      fxEv(p.bladeStance==='arcane'?'swaparcane':'swapblade',p.x,p.y,p.bladeStance==='arcane'?270:15,0,0,inDuality?30:40);
      sendTo(id,{t:'stance',stance:p.bladeStance});
    }
    else if(m.t==='equip'){ doEquip(p,id,m.itemId); }
    else if(m.t==='unequip'){ doUnequip(p,id,m.slot); }
    else if(m.t==='enchant'){ doEnchant(p,id,m.itemId); }
    else if(m.t==='allocstat'){ allocStat(p,id,m.stat); }
    else if(m.t==='rankskill'){ rankSkill(p,id,m.skillId); }
    else if(m.t==='setloadout'){ doSetLoadout(p,id,m.slot,m.skillId); }
    else if(m.t==='claimquest'){ doClaimQuest(p,id,m.qid); }
    else if(m.t==='checkin'){ doCheckin(p,id); }
    else if(m.t==='getquests'){ sendQuests(p,id); }
    else if(m.t==='invite'){ doInvite(p,id,m.targetId); }
    else if(m.t==='acceptinvite'){ doAcceptInvite(p,id); }
    else if(m.t==='declineinvite'){ doDeclineInvite(p,id); }
    else if(m.t==='leaveparty'){ doLeaveParty(p,id); }
    else if(m.t==='chat'){ doChat(p,id,m.text); }
    else if(m.t==='createguild'){ doCreateGuild(p,id,m.name); }
    else if(m.t==='guildlist'){ doGuildList(id); }
    else if(m.t==='requestjoin'){ doRequestJoin(p,id,m.gid); }
    else if(m.t==='approvejoin'){ doApproveJoin(p,id,m.targetId); }
    else if(m.t==='rejectjoin'){ doRejectJoin(p,id,m.targetId); }
    else if(m.t==='donate'){ doDonate(p,id,m.amount); }
    else if(m.t==='promote'){ doPromote(p,id,m.targetId); }
    else if(m.t==='demote'){ doDemote(p,id,m.targetId); }
    else if(m.t==='kickguild'){ doKickGuild(p,id,m.targetId); }
    else if(m.t==='leaveguild'){ doLeaveGuild(p,id); }
    else if(m.t==='disbandguild'){ doDisbandGuild(p,id); }
    else if(m.t==='setmotd'){ doSetMotd(p,id,m.text); }
    else if(m.t==='guildchat'){ doGuildChat(p,id,m.text); }
    else if(m.t==='talknpc'){ sendNpcData(p,id,m.npcId); }
    else if(m.t==='acceptnpcq'){ doAcceptNpcQ(p,id,m.npcId,m.qid); }
    else if(m.t==='claimnpcq'){ doClaimNpcQ(p,id,m.npcId,m.qid); }
    else if(m.t==='shopopen'){ sendShopData(p,id); }
    else if(m.t==='buypotion'){ doBuyPotion(p,id,m.kind); }
    else if(m.t==='buymount'){ doBuyMount(p,id,m.mountId); }
    else if(m.t==='togglemount'){ doToggleMount(p,id,m.mountId); }
    else if(m.t==='sellitem'){ doSellItem(p,id,m.itemId); }
    else if(m.t==='feedpet'){ doFeedPet(p,id); }
    else if(m.t==='fusion'){ doFusion(p,id); }
    else if(m.t==='permfusion'){ doPermFusion(p,id); }
    else if(m.t==='buyhspet'){ doBuyHsPetEgg(p,id); }
    else if(m.t==='feedhspet'){ doFeedHsPet(p,id,m.itemId); }
    else if(m.t==='socketgem'){ doSocketGem(p,id,m.slot,m.gemType); }
    else if(m.t==='tuthu'){
      if((p.pkScore||0)<=0){ sendTo(id,{t:'toast',text:'Bạn không có điểm PK để tự thú.'}); }
      else { p.jailed=60; sendTo(id,{t:'toast',text:'🔒 Đã tự thú, giam 60s, điểm PK giảm nhanh trong lúc này.'}); }
    }
  });
  ws.on('close',()=>{ const p=players[id]; if(p&&p.party&&parties[p.party]){ const pt=parties[p.party];
      pt.members=pt.members.filter(m=>m!==id);
      if(pt.members.length===0)delete parties[p.party]; else { if(pt.leader===id)pt.leader=pt.members[0]; sendPartyUpdate(p.party); } }
    if(p&&p.charUser&&p.charSlot&&p.chosen) dbSaveChar(p.charUser,p.charSlot,p);
    delete players[id]; delete sockets[id]; });
});

function clamp(v){v=Number(v)||0;return Math.max(-1,Math.min(1,v));}
function bcast(o){const s=JSON.stringify(o);wss.clients.forEach(c=>{if(c.readyState===1)c.send(s);});}
function sendTo(id,o){const ws=sockets[id];if(ws&&ws.readyState===1)ws.send(JSON.stringify(o));}
function fxEv(kind,x,y,hue,fx,fy,R){bcast({t:'fx',kind,x,y,hue,fx,fy,R});}
function hitEv(x,y,val,foe){bcast({t:'hit',x,y,val:(typeof val==='number'?Math.round(val):val),foe});}

// ---- BỘ SKILL RIÊNG TỪNG CLASS (Q/W/E/R) ----
const SKILLS = {
  war: [
    {id:'w1',name:'Bước Săn Mồi',icon:'👣',type:'predstep',mp:12,cd:5,   unlockLv:2,  dist:150,
      desc:'Lao ngắn về hướng chỉ định. Nếu tới gần mục tiêu đang dính Wound (Chảy Máu), reset ngay hồi chiêu đánh thường.'},
    {id:'w2',name:'Cuồng Phong Trảm',icon:'🌀',type:'warcleave',mp:16,cd:2.5, unlockLv:3,  rangeIn:75,rangeOut:135,arc:1.05,dmgIn:34,dmgOut:20,scaleKey:'dmgIn',comboNext:true,comboMaxStep:3,comboWindow:2000,dashDist:110,
      desc:'CHUỖI 3 ĐÒN (như Riven Q) — mỗi đòn đều LAO TỚI theo hướng đang ngắm (mặc định theo hướng di chuyển, giữ+kéo để tự chọn hướng) rồi chém hình quạt phía trước, trong 2s sau mỗi đòn có thể bấm tiếp để lên đòn kế (không tốn thêm mana). Đòn 3 lao xa hơn + quạt rộng hơn + sát thương mạnh nhất. Chỉ vào hồi chiêu thật sau khi dứt cả chuỗi.'},
    {id:'w3',name:'Phản Đòn Sắt',icon:'🛡️',type:'wcounter',mp:20,cd:8,   unlockLv:5,  dur:1.0,counterDmg:36,scaleKey:'counterDmg',
      desc:'Vào thế thủ 1 giây. Bị đánh trúng trong lúc này: giảm 80% sát thương nhận + phản ngược 1 đòn mạnh + tích lớn Chiến Ý (Momentum). Không bị đánh thì kết thúc không có gì.'},
    {id:'w4',name:'Chém Kết Liễu',icon:'💀',type:'wexecute',mp:35,cd:11, unlockLv:7,  range:110,baseDmg:30,scaleKey:'baseDmg',
      desc:'Đánh 1 đòn dứt điểm — dame tăng theo %máu mục tiêu đã mất + số Wound đang dính + tầng Chiến Ý hiện tại. Kết liễu thành công: hồi lớn Chiến Ý + giảm hồi chiêu mọi skill khác 3s.'},
    {id:'w5',name:'Gầm Chiến',  icon:'📢',type:'warcry', mp:26,cd:12, unlockLv:10, radius:170,atkDebuff:0.25,debuffDur:3,defBuff:0.2,buffDur:4, reqStat:'VIT',reqVal:15,
      desc:'Gầm lên quanh mình: quái địch trong tầm giảm 25% sát thương gây ra trong 3s (boss chỉ nhận nửa hiệu quả). Đồng đội trong TỔ ĐỘI gần đó được giảm 20% sát thương nhận trong 4s.'},
    {id:'w6',name:'Xuyên Giáp', icon:'🗡️',type:'rupture',mp:20,cd:6,  unlockLv:13, range:105,throwRange:320,dmg:32,throwDmg:20,shredMul:1.5,shredDur:3, reqStat:'STR',reqVal:15,scaleKey:'dmg',
      desc:'GIỮ rồi kéo: nhắm GẦN (trong tầm cận chiến) → chém thẳng như cũ, dame đầy đủ. Nhắm XA (tới 320) → NÉM VŨ KHÍ bay tới đích (dame thấp hơn nhưng đây là công cụ TẦM XA DUY NHẤT của Chiến Binh — dùng để bắt kịp/trừng phạt kẻ đang chạy trốn). Cả 2 cách đều: có khiên thì phá khiên trước, không khiên thì gây Suy Yếu +50% dame nhận 3s.'},
    {id:'w7',name:'Nợ Máu',     icon:'📌',type:'blooddebt',mp:24,cd:10,unlockLv:16, range:220,dur:5,bankPct:0.3,
      desc:'GIỮ rồi kéo tới đúng mục tiêu muốn đánh dấu (nhắm hụt sẽ không trúng ai). Trong 5s, 30% sát thương mục tiêu này gây cho bạn được "ngân hàng hoá" — hết giờ trả lại toàn bộ thành 1 đòn dồn (hoặc hồi máu nếu mục tiêu chết trước).'},
    {id:'w8',name:'Tử Chiến',   icon:'💢',type:'laststand',mp:30,cd:22,unlockLv:20, dur:4,hpReq:0.3,momGen:3,
      desc:'CHỈ dùng được khi máu dưới 30%. Trong 4s tiếp theo: không thể bị 1 đòn đánh gục xuống dưới 1 máu. Cơ hội lật kèo khi sắp chết.'},
    {id:'w9',name:'Địa Chấn Trường',icon:'🪓',type:'groundbreak',mp:32,cd:10,unlockLv:23,len:180,width:70,dmg:42,slowMul:0.4,slowDur:2,scaleKey:'dmg',
      desc:'Đập vũ khí tạo 1 VÙNG DÀI-HẸP phía trước (không phải vòng tròn) — ai trúng bị sát thương + làm chậm 2s. Vùng chữ nhật nên cần ngắm đúng hướng, không tự động trúng người đứng cạnh.'},
    {id:'w10',name:'Phán Quyết Lãnh Chúa',icon:'⚔️',type:'warlordverdict',mp:50,cd:30,unlockLv:26,range:150,dur:5,dmgGrowth:0.15,
      desc:'GIỮ rồi kéo tới đúng mục tiêu muốn khóa (nhắm hụt sẽ không khóa được ai — quan trọng, khóa nhầm người trong PK là thảm họa). Khóa 1v1 với mục tiêu đó trong 5s — mỗi giây cả 2 bên đều dính 1 đợt sát thương, tăng dần theo thời gian giao chiến. Ultimate tất tay.'},
  ],
  mage:[
    {id:'m1',name:'Dịch Chuyển',icon:'✨',type:'dash', mp:14,cd:3,   unlockLv:2,  dist:180,
      desc:'Dịch chuyển ngắn tức thời tới vị trí chỉ định.'},
    {id:'m2',name:'Thương Lửa', icon:'🔥',type:'emberlance', mp:16,cd:1.2, unlockLv:3,  dmg:38,speed:560,r:8,burnDmg:6,burnTicks:3,elem:'fire',scaleKey:'dmg',chargeable:true,
      desc:'GIỮ để tích lực trước khi thả (thả sớm = đòn nhanh yếu, giữ đủ lâu = mạnh hơn hẳn). Gây Bỏng. Nếu mục tiêu đang dính Băng (từ Lăng Kính Băng) → Bỏng biến thành nổ bùng ngay lập tức. Đổi hệ từ Băng/Huyền Bí sang Lửa sẽ kích phản ứng Nguyên Tố.'},
    {id:'m3',name:'Lăng Kính Băng',icon:'🔷',type:'frostprism', mp:22,cd:7,   unlockLv:5,  range:280,radius:110,dur:6,elem:'frost',
      desc:'Đặt 1 lăng kính băng tại vị trí xa — mọi kẻ địch trong vùng bị đánh dấu Băng, các đòn Lửa của bạn đánh trúng chúng sẽ bùng nổ mạnh hơn. Đổi hệ sang Băng kích phản ứng Nguyên Tố.'},
    {id:'m4',name:'Dây Huyền Bí',icon:'🧵',type:'arcanethread', mp:28,cd:8,  unlockLv:7,  len:260,width:36,dmg:30,slowMul:0.5,slowDur:2,manaBurn:15,elem:'arcane',scaleKey:'dmg',
      desc:'Tạo 1 đường năng lượng thẳng phía trước — kẻ địch trúng bị sát thương + làm chậm + mất Mana (chỉ người chơi). Đổi hệ sang Huyền Bí kích phản ứng Nguyên Tố.'},
    {id:'m5',name:'Tia Diệt Vong',icon:'☄️',type:'cataclysm', mp:55,cd:13,  unlockLv:10, len:420,width:50,dmg:26,elem:'arcane',scaleKey:'dmg',channelable:true,channelDur:2.0,channelTick:0.2,
      desc:'GIỮ để bắn tia liên tục (2s) — trong lúc giữ, KÉO để XOAY tia theo hướng mới liên tục, không cần thả ra bắn lại. Mỗi 0.2s gây 1 đợt sát thương dọc tia. Thả sớm = tia ngắn hơn nhưng vẫn tính hồi chiêu đủ. Sát thương tăng nếu mục tiêu vừa trúng phản ứng Nguyên Tố.'},
    {id:'m6',name:'Bước Ảnh',   icon:'🪞',type:'mirrorstep', mp:22,cd:9,   unlockLv:13, dist:170,tauntR:130,confuseDur:3.5,
      desc:'Dịch chuyển ngắn tới hướng chỉ định, để lại 1 ẢO ẢNH có hình dạng bạn tại vị trí cũ (tồn tại 3.5s) — quái gần đó ưu tiên lao vào đánh ảo ảnh thay vì bạn. Dùng để thoát hiểm hoặc đánh lạc hướng khi bị vây.'},
    {id:'m7',name:'Lá Chắn Phép',icon:'🔷',type:'shield',mp:24,cd:10,unlockLv:16, amount:70,dur:5, reqStat:'VIT',reqVal:15,scaleKey:'amount',
      desc:'Tạo khiên chắn hấp thụ sát thương trong 5s. Nhánh Sinh Tồn (cần Sinh Lực).'},
    {id:'m8',name:'Hút Hồn',    icon:'💜',type:'lifesteal',mp:20,cd:4,unlockLv:20,range:380,dmg:34,lsPct:0.55, reqStat:'INT',reqVal:20,scaleKey:'dmg',
      desc:'Đòn phép tầm xa, hồi máu bằng 55% sát thương gây ra. Nhánh Hút Máu (cần Trí Tuệ cao).'},
    {id:'m9',name:'Vọng Thời Gian',icon:'⏳',type:'timeecho', mp:18,cd:16,  unlockLv:23, dur:5,comboNext:true,comboMaxStep:2,comboWindow:5000,maxDist:500,aoeDmg:22,aoeR:70,scaleKey:'aoeDmg',
      desc:'Lần 1: ghi lại vị trí hiện tại (tự cast tại chỗ, không cần ngắm). Trong 5s đó bạn VẪN dùng được các skill khác bình thường (vd Bước Ảnh để cơ động ra xa) — bấm lại Vọng Thời Gian bất cứ lúc nào trong 5s (còn cách chỗ ghi tối đa 500): DỊCH CHUYỂN NGAY VỀ + gây 1 đợt sát thương nhỏ quanh mình (dư chấn thời gian).'},
    {id:'m10',name:'Vực Hút Trọng Lực',icon:'🌀',type:'gravitywell', mp:30,cd:12, unlockLv:26, range:300,radius:130,life:2.5,pullSpd:40,dmg:8,
      desc:'Tạo 1 vùng hút tại vị trí ngắm, tồn tại 2.5s — kẻ địch trong vùng bị kéo dần vào tâm + chịu sát thương nhỏ liên tục. Không mạnh nhưng GOM địch lại để tận dụng Tia Diệt Vong/Dây Huyền Bí ngay sau đó.'},
    {id:'m11',name:'Phong Ấn Huyền Bí',icon:'🔮',type:'arcanedet', mp:20,cd:8, unlockLv:29, range:400,dur:6,bonusPct:0.5,
      desc:'GIỮ để hiện hồng tâm riêng tư, KÉO TỰ DO trong tầm ngắm tới đúng mục tiêu (sáng vàng khi đã khóa đúng) rồi thả tay — không gây sát thương ngay. Đòn phép TIẾP THEO đánh trúng mục tiêu đã đóng dấu sẽ +50% sát thương và tiêu luôn dấu. Chọn chuẩn xác tuyệt đối — quan trọng cho PK.'},
    {id:'m12',name:'Chuyển Hệ',  icon:'♻️',type:'elemshift', mp:20,cd:8, unlockLv:32,
      desc:'Chủ động đổi hệ Nguyên Tố hiện tại sang hệ TIẾP THEO trong vòng Lửa→Băng→Huyền Bí→Lửa — dùng để tự tạo phản ứng combo mà không cần đổi skill.'},
  ],
  arc: [
    {id:'a1',name:'Bước Ma',    icon:'💨',type:'dash', mp:10,cd:2.0, unlockLv:2,  dist:150,
      desc:'Lộn/lao ngắn về hướng chỉ định, né đòn hoặc tạo khoảng cách.'},
    {id:'a2',name:'Xuyên Giáp Trường',icon:'🏹',type:'pierce',mp:16,cd:2, unlockLv:3, dmg:32,speed:760,r:6,maxHits:4,falloff:0.8,scaleKey:'dmg',
      desc:'Bắn 1 mũi tên XUYÊN QUA tối đa 4 mục tiêu thẳng hàng — mỗi mục tiêu sau nhận 80% dame mục tiêu trước (giảm dần). Rất mạnh khi địch đứng thành hàng.'},
    {id:'a3',name:'Dấu Ấn Thợ Săn',icon:'🎯',type:'huntmark',mp:14,cd:6, unlockLv:5, range:400,dur:6,bonusPct:0.25,
      desc:'GIỮ rồi kéo tới đúng mục tiêu muốn đánh dấu (nhả tay sẽ nhắm đúng kẻ gần điểm ngắm nhất — nhắm hụt sẽ không trúng ai!). Bấm nhanh không kéo = tự nhắm gần nhất cho tiện. Đánh dấu 6s — MỌI đòn đánh của bạn lên nó +25% sát thương.'},
    {id:'a4',name:'Bẫy Rừng Xanh',icon:'🕸️',type:'trap',   mp:20,cd:9, unlockLv:7, range:120,triggerR:26,rootDur:1.8,life:14,
      desc:'Đặt 1 bẫy vô hình phía trước (tồn tại 14s). Kẻ địch đầu tiên bước vào bị Trói cứng 1.8s + tự động dính Dấu Ấn Thợ Săn.'},
    {id:'a5',name:'Tên Sao Rơi', icon:'🌠',type:'starfall',mp:30,cd:11, unlockLv:10,range:480,dmg:46,stunDur:1.0,scaleKey:'dmg',chargeable:true,
      desc:'GIỮ để kéo căng cung trước khi bắn — giữ càng lâu, tầm bắn + vùng ảnh hưởng + sát thương càng tăng. Bắn lên trời rồi rơi thành nhiều mũi tên xuống CẢ 1 VÙNG tại điểm ngắm (trúng nhiều mục tiêu đứng gần nhau) — không phải chỉ 1 mục tiêu. Gây sát thương + Choáng 1s + gắn Dấu Ấn Thợ Săn cho tất cả trúng đòn.'},
    {id:'a6',name:'Hồi Phục Thần Linh',icon:'💚',type:'spiritheal',mp:32,cd:9,unlockLv:13,range:260,heal:50,castTime:0.8, reqStat:'INT',reqVal:12,scaleKey:'heal',
      desc:'Hồi máu cho đồng minh gần nhất trong tầm (hoặc tự hồi nếu không có ai) — hồi CÀNG NHIỀU nếu mục tiêu càng ít máu. Nhánh Hộ Vệ (cần Trí Tuệ).'},
    {id:'a7',name:'Phù Hộ Hộ Vệ',icon:'🌿',type:'allybuff',mp:26,cd:12,unlockLv:16,dur:5,radius:170,defBuff:0.2, reqStat:'INT',reqVal:15,
      desc:'Ban phước cho tổ đội quanh mình (hoặc tự thân nếu đi solo) — giảm 20% sát thương nhận trong 5s. Nhánh Hộ Vệ (cần Trí Tuệ).'},
    {id:'a8',name:'Song Tiễn',   icon:'🏹',type:'twinshot',mp:20,cd:3, unlockLv:20, dmg:26,speed:700,r:6,scaleKey:'dmg',
      desc:'Bắn 2 mũi tên cùng lúc vào 2 mục tiêu gần nhất khác nhau. Nếu quanh chỉ có 1 mục tiêu, cả 2 mũi đều trúng nó nhưng dame giảm còn 60%.'},
    {id:'a9',name:'Phong Vệ Trận',icon:'🍃',type:'windguard',mp:24,cd:14,unlockLv:23, dur:4,arc:0.9,reduceMul:0.35,
      desc:'Dựng lá chắn CÓ HƯỚNG theo mặt bạn đang quay, 4s — chỉ chặn giảm 65% sát thương từ ĐÚNG hướng đó, không chặn được đòn đánh từ sau lưng/bên hông.'},
    {id:'a10',name:'Cuộc Săn Hoang Dã',icon:'🐾',type:'wildhunt',mp:45,cd:26,unlockLv:26, range:420,dur:8,aspdBonus:0.3,
      desc:'Chọn 1 mục tiêu làm "con mồi" trong 8s — tăng 30% tốc độ đánh của bạn suốt thời gian này + gắn Dấu Ấn Thợ Săn dài hạn lên nó. Ultimate tăng DPS toàn diện.'},
  ],
  blade:[
    {id:'b1',name:'Chớp Cắt', nameArcane:'Hư Không Bộ',  icon:'💨',type:'blinkcut', mp:10,cd:2.0, unlockLv:2,  distBlade:110,distArcane:190,dmgBlade:22,
      desc:'Hành vi đổi theo VŨ KHÍ đang cầm (bấm nút ⇄ để đổi): KIẾM → lao ngắn XUYÊN QUA địch trên đường (vệt chém dày, có động tác thật), gây dame. PHÉP → BIẾN MẤT tức thời rồi HIỆN LẠI ở xa hơn hẳn (không có vệt di chuyển, đúng cảm giác dịch chuyển thật, không phải chạy nhanh), không gây dame nhưng né đòn tốt hơn.'},
    {id:'b2',name:'Chém Cung', nameArcane:'Ma Đạn Xuyên',  icon:'⚔️',type:'arcslash', mp:16,cd:1.2, unlockLv:3,  range:115,arc:0.95,dmgBlade:26,rangeArcane:340,dmgArcane:22,piercArcane:3,
      desc:'KIẾM → LAO NGƯỜI THẬT về trước như kiếm sĩ lao đâm (vệt chém dài theo cả quãng đường lao) rồi chém cận chiến hình quạt. PHÉP → LÙI NHẸ ra sau trong lúc phóng 1 LƯỠI KIẾM NĂNG LƯỢNG LỚN (hình dạng riêng, không phải đạn tròn) bay xa, XUYÊN QUA tối đa 3 mục tiêu, dame cao hẳn so với đánh thường — đây là đòn kỹ năng thật, không phải bắn thêm 1 phát. Đòn Kiếm nuôi Momentum, đòn Phép nuôi Arcane.'},
    {id:'b3',name:'Sóng Kiếm', nameArcane:'Huyền Đạn Vũ',  icon:'🌊',type:'swordwave', mp:24,cd:3,   unlockLv:5,  dmgBlade:27,dmgArcane:22,
      desc:'Kiếm: XOAY NGƯỜI lao THẲNG VỀ TRƯỚC (không đứng 1 chỗ), đánh trúng địch dọc cả quãng đường lao lẫn điểm dừng — khác hẳn Băng Kiếm (đứng yên tại chỗ), nuôi Momentum mạnh. Phép: LÙI HẲN 1 bước trong lúc bắn 3 tia xuyên xa (kite thật, không đứng ì), nuôi Arcane.'},
    {id:'b4',name:'Vũ Bão', nameArcane:'Đại Pháp Trận',    icon:'🌀',type:'stormblade', mp:55,cd:12,  unlockLv:7,  dmgBlade:82,dmgArcane:60,radius:185,
      desc:'ULTIMATE — 2 động tác hoàn toàn khác nhau. Kiếm: NHẢY LÊN KHÔNG TRUNG rồi ĐẬP XUỐNG (bất tử trong lúc bay), nova cực lớn + hút 15% dame thành máu, rung màn hình mạnh. Phép: NHẤC BỔNG NGƯỜI LÊN lơ lửng, nova nhỏ hơn + hồi 25% mana tối đa + làm chậm mọi mục tiêu trúng.'},
    {id:'b5',name:'Kiếm Hút Sinh', nameArcane:'Linh Hồn Thực',icon:'🩸',type:'bloodsword',mp:18,cd:3.5,unlockLv:10,rangeBlade:105,dmgBlade:28,lsBlade:0.55,rangeArcane:220,dmgArcane:22,lsArcane:0.3, reqStat:'STR',reqVal:12,
      desc:'Nhánh STR (Kiếm mạnh hơn hẳn ở đây). Kiếm: LAO THẲNG TỚI mục tiêu rồi đâm (gap-closer thật), tầm ngắn, hút máu 55%. Phép: ĐỨNG XA tạo 1 SỢI DÂY HÚT MÁU thấy rõ nối tới mục tiêu (không lao tới), tầm xa gấp đôi nhưng hút máu chỉ 30%, bù lại gây thêm Bỏng nhẹ theo thời gian.'},
    {id:'b6',name:'Hộ Thể Quyết', nameArcane:'Ma Lực Hộ Thuẫn',icon:'🛡️',type:'bodyward', mp:22,cd:9, unlockLv:13, amountBlade:65,reflectPct:0.2,amountArcane:50,manaShieldPct:0.5,dur:5, reqStat:'INT',reqVal:15,
      desc:'Nhánh INT (Phép mạnh hơn hẳn ở đây). Kiếm: VÀO THẾ THỦ thật (khiên nhỏ giơ trước người suốt 5s), khiên hấp thụ + phản 20% dame về kẻ đánh. Phép: NGƯỜI LƠ LỬNG NHẸ khỏi mặt đất suốt khi còn khiên, khiên yếu hơn nhưng vỡ ra chuyển 50% phần dư thành Mana ngay.'},
    {id:'b7',name:'Băng Kiếm', nameArcane:'Băng Phong Ấn',  icon:'❄️',type:'iceblade', mp:24,cd:8,   unlockLv:16, radius:120,dmgBlade:22,dmgArcane:18,slowMul:0.5,slowDur:2.5,
      desc:'Kiếm: DẬM CHÂN THẬT (hơi nhảy lên rồi đập chân xuống) tạo sốc băng quanh mình, làm chậm + gây Wound. Phép: NGƯỜI LƠ LỬNG NGẮN đúc pha lê từ trên xuống, làm chậm + đóng dấu Frostmark riêng của Phép.'},
    {id:'b8',name:'Kiếm Phá Không', nameArcane:'Dị Không Chuyển',icon:'⚡',type:'voidsword',mp:30,cd:10,unlockLv:20, distBlade:210,dmgBlade:48,impactR:95,distArcane:260,dmgArcane:30,zoneDur:3,
      desc:'Kiếm: nhảy bổ xuống, va chạm gây nổ lớn tức thì. Phép: dịch chuyển xa hơn, va chạm nhẹ hơn nhưng để lại 1 VÙNG DAME liên tục 3s tại điểm đáp.'},
    {id:'b9',name:'Cộng Hưởng Song Kiếm',icon:'✨',type:'dualresonance',mp:20,cd:14,unlockLv:24,dur:4,
      desc:'KHÔNG gây dame — mở 4s "Cộng Hưởng": MỌI đòn đánh (kể cả đánh thường) tự động gây thêm 25% dame LOẠI KIA (đang cầm Kiếm thì thêm dame Phép, đang cầm Phép thì thêm dame Kiếm) + nuôi CẢ 2 thanh Momentum/Arcane cùng lúc gấp đôi tốc độ bình thường. Đây là công cụ DUY NHẤT trong bộ kỹ năng không thuộc phe nào — dùng để dồn tài nguyên trước khi tung Song Trùng Đoạn Tuyệt.'},
    {id:'b10',name:'Song Trùng Đoạn Tuyệt',icon:'☯️',type:'dualitycollapse',mp:50,cd:40,unlockLv:28,dur:4,
      desc:'ULTIMATE THỨ 2 — mở 4s "Vô Cực": đổi vũ khí gần như không hồi chiêu (0.1s) + MỖI LẦN đổi cộng dồn thêm 1 tầng sức mạnh (tối đa 5 tầng, mỗi tầng +8% dame mọi skill = tối đa +40%). Càng đổi nhiều, dồn càng cao — thấy rõ số tầng trên HUD. Hết 4s tầng mất sạch. Giá trị thật: chuỗi combo cả 2 phiên bản mọi skill liên tiếp (b1 Kiếm→đổi→b1 Phép→đổi→b8 Kiếm...) mà bình thường phải đợi hồi chiêu đổi mới làm được, VỪA dồn tầng sức mạnh trong lúc combo.'},
  ],
  // Thống Lĩnh — "Chỉ Huy" lai giữa Dark Lord (xích, áp chế) và support (1 skill hồi máu duy nhất, không phải class heal chính)
  cmd: [
    {id:'c1',name:'Lướt',       icon:'💨',type:'dash', mp:10,cd:2.2, unlockLv:2,  dist:150},
    {id:'c2',name:'Dấu Quạ',    icon:'🐦‍⬛',type:'ravenmark', mp:14,cd:8,   unlockLv:3,  range:260,dur:8,bonusPct:0.15,
      desc:'GIỮ rồi kéo tới đúng mục tiêu muốn đánh dấu (nhắm hụt không trúng ai). 1 con quạ thật bay từ bạn tới đích rồi đáp xuống đóng dấu. Cấm Vệ Quân/pet ƯU TIÊN tuyệt đối tấn công mục tiêu này, đòn của chúng lên nó +25% dame. Đòn của chính bạn lên nó cũng +15%.'},
    {id:'c3',name:'Mắt Quạ',    icon:'👁️',type:'ravenseye', mp:20,cd:12,  unlockLv:5,  radius:280,dur:4,rangeBuf:0.2,
      desc:'Thả bầy quạ trinh sát bay vòng quanh 1 vùng lớn (không cần ngắm, tự kích quanh mình) — MỌI địch trong vùng lộ rõ % máu chính xác trong 4s. Đồng đội trong vùng được +20% tầm đánh thường tạm thời — "biết trước địch ở đâu, ra tay trước".'},
    {id:'c4',name:'Uy Lệnh',    icon:'👑',type:'summon', mp:55,cd:20,  unlockLv:7,  dur:20,atk:18,spdmul:1.2,radius:170,dmg:32, authGain:18},
    {id:'c5',name:'Triệu Hồi Hoàng Gia',icon:'✨',type:'royalsummons', mp:18,cd:14, unlockLv:10, reqStat:'VIT',reqVal:12,
      desc:'Dịch chuyển NGAY LẬP TỨC Cấm Vệ Quân về sát bên bạn, bất kể nó đang ở đâu (kể cả đang lao/đứng tăng cường giữa chừng — hủy lệnh cũ). Cứu lính khi nó bị bỏ lại quá xa hoặc mắc kẹt.'},
    {id:'c6',name:'Triệu Hồi Chiến Thuật',icon:'🧲',type:'tacticalrecall', mp:26,cd:15, unlockLv:13, range:300,pullDist:180,delay:0.9,
      desc:'GIỮ rồi kéo tới đúng ĐỒNG ĐỘI (cùng tổ đội) muốn kéo về — có độ trễ 0.9s trước khi kéo thật (đồng đội kịp thấy dấu hiệu, không bị giật bất ngờ). Chỉ tác dụng lên đồng đội, không dùng được lên địch trong PK.'},
    {id:'c7',name:'Kỵ Binh Xung Phong',icon:'🐴',type:'horsecharge', mp:32,cd:13, unlockLv:16, len:280,width:70,dmg:34,pushDist:90, reqStat:'STR',reqVal:18,
      desc:'GIỮ rồi kéo hướng lao — CHÍNH BẠN cưỡi ngựa xông thẳng theo 1 đường (không phải hình tròn), mọi địch trên đường bị hủy + đẩy dạt sang 2 BÊN đường đi (không đẩy lùi). Nhánh Battle Lord — chỉ huy tự mình xông trận.'},
    {id:'c8',name:'Hy Sinh Chỉ Huy',icon:'💔',type:'cmdsacrifice', mp:15,cd:20, unlockLv:20, durCost:6,atkBuf:0.35,healBurst:70,dur:5,
      desc:'Cần đã có Cấm Vệ Quân. Rút ngắn 6s thời gian tồn tại của nó (hi sinh thời gian phục vụ) để đổi lấy: cả tổ đội hồi máu ngay + trong 5s +35% sát thương. Đánh đổi thật — cân nhắc trước khi dùng.'},
    {id:'c9',name:'Sổ Linh Hồn', icon:'📖',type:'soulledger', mp:20,cd:10, unlockLv:12, fragCap:10,healPerFrag:14,buffPerFrag:0.02,
      desc:'Thụ động: mỗi khi có địch chết gần bạn (bất kỳ ai hạ), bạn nhặt được 1 "mảnh hồn" (tối đa 10). Chủ động bấm skill này: TIÊU TOÀN BỘ mảnh đã gom để hồi máu lớn + tăng sát thương ngắn hạn — gom càng nhiều, nổ càng mạnh.'},
    {id:'c10',name:'Ý Chí Hoàng Đế',icon:'👑',type:'emperorswill',mp:70,cd:45, unlockLv:35, dur:8,summonBuf:0.5,bannerBuf:0.5,auraBuf:0.5,authCost:40,
      desc:'ULTIMATE nhánh Beast Commander (build dồn Cấm Vệ Quân/Cờ Hiệu, đầu tư nặng c2/c4/c11/c12) — mở Trạng Thái Chỉ Huy Tối Cao 8s: Cấm Vệ Quân +50% sát thương/tốc đánh, mọi Cờ Hiệu đang tồn tại +50% hiệu quả buff, hào quang Command +50%. Không tự đánh mạnh hơn — chọn ultimate này nếu lối chơi của bạn xoay quanh điều khiển, không phải tự combat.'},
    {id:'c11',name:'Lệnh: Xung Phong',icon:'🐎',type:'cmdadvance', mp:20,cd:11, unlockLv:23, range:320,orderRange:320,orderHoldDur:2.5,authCost:20,sweepDmg:14,sweepR:55,
      desc:'GIỮ rồi kéo tới điểm muốn ra lệnh (giới hạn theo khoảng cách TỪ CHÍNH Cấm Vệ Quân, không phải từ bạn) — nhắm TRÚNG 1 kẻ địch thì Cấm Vệ Quân sẽ ĐUỔI THEO nó dù nó di chuyển, nhắm vị trí trống thì lao thẳng tới đó. Trên đường lao đi gây sát thương mọi địch chạm phải. Tới nơi: đứng lại 2.5s với giáo DÀI HƠN + đánh nhanh hơn hẳn. Hết giờ: LAO VỀ lại phía bạn — trên đường về TIẾP TỤC gây sát thương.'},
    {id:'c12',name:'Cờ Hiệu Đế Vương',icon:'🚩',type:'banner', mp:38,cd:18, unlockLv:29, range:260,radius:150,life:8,atkBuf:0.15,defBuf:0.12,authCost:15,
      desc:'GIỮ rồi kéo tới vị trí đặt cờ — cờ hạ xuống từ trên trời, cắm đất có bụi bay (khác hẳn nhịp nhanh của Xung Phong). Tồn tại 8s — đồng đội (kể cả Cấm Vệ Quân/pet) đứng trong vùng được +15% sát thương, +12% giảm dame nhận.'},
    {id:'c13',name:'Sắc Lệnh Quân Đoàn',icon:'📣',type:'legiondecree', mp:60,cd:35, unlockLv:32, radius:220,dur:5,atkBuf:0.25,defBuf:0.15,enemyDebuf:0.2,authCost:45,
      desc:'ULTIMATE nhánh Overlord (build combat trực tiếp + team fight, đầu tư nặng c7/aura Chỉ Huy) — rúc tù và triệu tập, KHÔNG cần ngắm (tự kích hoạt quanh mình ngay). Bán kính 220 quanh bạn, 5s: đồng đội +25% sát thương/+15% giảm dame nhận, ĐỊCH bị -20% sát thương gây ra. Chọn ultimate này nếu bạn muốn đứng giữa trận đánh trực tiếp, khác hẳn lối chơi thuần điều khiển của Ý Chí Hoàng Đế.'},
  ],
};
// ---- PASSIVE nội tại riêng từng class (LOL-signature style) ----
const PASSIVES = {
  war:  {name:'Huyết Chiến (Momentum)', desc:'Đánh/chịu dame tích Chiến Ý — Battle Ready (40+): +7% dame, Blood Frenzy (80+): +15% dame, +tốc đánh, -10% dame nhận. Giảm dần nếu ngừng combat 3s. (Ý Chí Sắt: máu <30% → -20% dame nhận 3s, hồi sau 15s)'},
  mage: {name:'Chuỗi Nguyên Tố',desc:'3 skill mang hệ Lửa/Băng/Huyền Bí riêng biệt. Dùng skill khác hệ với lần trước → kích phản ứng +35% sát thương. Dùng liên tiếp cùng hệ thì KHÔNG có bonus — phải xoay vòng nguyên tố để tối ưu.'},
  arc:  {name:'Nhịp Điệu Thợ Săn', desc:'Sát Thủ: đánh mục tiêu <30% máu → x1.5 dmg. Nhịp Điệu: bắn xong di chuyển đúng hướng → phát tiếp +25% dmg. Săn Bạc: đánh liên tục cùng 1 mục tiêu, đủ 5 lần → dmg thêm theo %máu tối đa mục tiêu'},
  blade:{name:'Song Tu (Dual Mastery)', desc:'CHỦ ĐỘNG đổi vũ khí qua nút ⇄ riêng (không tự động) — đang cầm Kiếm hay Phép quyết định cách MỌI skill Q/W/E hoạt động, kể cả ĐỘNG TÁC VẬT LÝ khi cast (Kiếm: xoay/nhảy/lao mạnh; Phép: lùi/bay/dịch chuyển tức thời). Đánh thường bằng Kiếm nuôi Momentum, bằng Phép nuôi Arcane. Cả 2 trạng thái đều +15% sát thương NHƯ NHAU — khác biệt ở BẢN CHẤT: cầm KIẾM → hút 10% sát thương thành máu; cầm PHÉP → +15% tốc độ di chuyển. Skill trúng địch → đòn thường tiếp theo +50% sát thương. Bộ kỹ năng đầy đủ 10 skill: 8 skill đổi hành vi theo stance + Cộng Hưởng Song Kiếm (buff trung lập không thuộc phe nào) + Song Trùng Đoạn Tuyệt (ultimate thứ 2 — thưởng cho KỸ NĂNG bấm đổi liên tục, khác hẳn Vũ Bão là 1 nút nổ to).'},
  cmd:  {name:'Chỉ Huy',    desc:'Đồng đội trong 150px quanh bạn được +8% sát thương'},
};
function findSkill(cls,id){ return (SKILLS[cls]||[]).find(s=>s.id===id); }
function skillMeta(p){
  const map={ b:{icon:(p.basicType==='melee'?'⚔️':'✦'),name:'Đánh thường',mp:0,cd:p.basicCd,rank:1} };
  for(const k of ['q','w','e','r']){ const sid=p.loadout&&p.loadout[k]; const s=findSkill(p.cls,sid);
    map[k]= s ? {icon:s.icon,name:s.name,nameArcane:s.nameArcane||null,mp:s.mp,cd:s.cd,rank:(p.skRank&&p.skRank[sid])||1} : {icon:'?',name:'',mp:0,cd:1,rank:0}; }
  return map;
}
function meetsReq(p,s){ return p.lv>=s.unlockLv && (!s.reqStat || (p[s.reqStat]||0)>=s.reqVal); }
function fullSkillList(p){
  return (SKILLS[p.cls]||[]).map(s=>({id:s.id,name:s.name,nameArcane:s.nameArcane||null,icon:s.icon,mp:s.mp,cd:s.cd,unlockLv:s.unlockLv,
    reqStat:s.reqStat||null,reqVal:s.reqVal||0,desc:s.desc||'',scaleKey:s.scaleKey||null,type:s.type,
    range:s.throwRange||s.range||s.dist||s.rangeOut||s.dashDist||0,radius:s.radius||s.triggerR||0,len:s.len||0,width:s.width||0,arc:s.arc||0,chargeable:!!s.chargeable,comboNext:!!s.comboNext,channelable:!!s.channelable,
    unlocked:meetsReq(p,s), rank:(p.skRank&&p.skRank[s.id])||1}));
}
function inCone(p,t,range,arc){ const dx=t.x-p.x,dy=t.y-p.y,d=Math.hypot(dx,dy); if(d>range)return false;
  const ang=Math.atan2(dy,dx),fa=Math.atan2(p.fy,p.fx); let df=Math.abs(ang-fa); if(df>Math.PI)df=2*Math.PI-df; return df<=arc; }
function doSkill(id,k,aim){
  const p=players[id]; if(!p||p.dead)return;
  if(k==='b'){ if(p.cd.b>0)return; let bcd=Math.max(0.15,p.basicCd-(p.AGI||0)*0.01);
    if(p.cls==='war' && (p.fervor||0)>=80) bcd*=0.75; // Blood Frenzy: đánh nhanh hơn
    if(p.cls==='arc' && p.wildHuntT>0) bcd*=(1-(p.aspdBonusWH||0.3));
    p.cd.b=bcd; doBasic(p,id); return; }
  const sid=p.loadout&&p.loadout[k]; const sk=findSkill(p.cls,sid); if(!sk||!meetsReq(p,sk))return;
  const isRecast = !!(sk.comboNext && p.comboState && p.comboState.skillId===sid && p.comboState.expireAt>Date.now());
  if(!isRecast){
    if(p.cd[k]>0)return; // client đã chặn từ trước + rung nút, đây chỉ là an toàn dự phòng
    if(p.mp<sk.mp){ sendTo(id,{t:'toast',text:'Không đủ Mana ('+Math.floor(p.mp)+'/'+sk.mp+')',flashSlot:k}); return; }
    if(sk.authCost && (p.authority||0)<sk.authCost){ sendTo(id,{t:'toast',text:'Không đủ Uy Quyền ('+Math.floor(p.authority||0)+'/'+sk.authCost+')',flashSlot:k}); return; }
    if(sk.hpReq && (p.hp/p.maxhp)>sk.hpReq){ sendTo(id,{t:'toast',text:'Chỉ dùng được khi máu dưới '+Math.round(sk.hpReq*100)+'%',flashSlot:k}); return; }
  }
  if(aim && typeof aim.dx==='number' && typeof aim.dy==='number'){
    const d=Math.hypot(aim.dx,aim.dy);
    if(d>0.1){ p.fx=aim.dx/d; p.fy=aim.dy/d; p.aimMag=Math.max(0.25,Math.min(1,aim.mag!==undefined?aim.mag:1)); p.wasAimed=true; }
    else { p.aimMag=1; p.wasAimed=false; }
  } else { p.aimMag=1; p.wasAimed=false; }
  if(sk.chargeable){
    const startT=(p.chargeStart&&p.chargeStart[k])||null;
    const heldMs=startT?Math.min(1500,Math.max(0,Date.now()-startT)):0; // server tự đo, KHÔNG nhận thời gian giữ từ client
    p.chargeMul = heldMs<200?0.6 : heldMs<700?1.0 : heldMs<1200?1.35 : 1.7;
    p.chargeTier = heldMs<200?0 : heldMs<700?1 : heldMs<1200?2 : 3;
    if(p.chargeStart)p.chargeStart[k]=null;
  } else { p.chargeMul=1; p.chargeTier=0; }
  const curStep = isRecast ? (p.comboState.step+1) : 1;
  if(!isRecast){
    let mpCost=sk.mp;
    // (đã bỏ giảm Mana ở Phép — thay bằng tốc độ di chuyển, xem chỗ tính spd trong tick loop)
    p.mp-=mpCost;
  }
  const maxStep = sk.comboMaxStep||2;
  const isFinalStep = !sk.comboNext || curStep>=maxStep;
  if(sk.comboNext && !isFinalStep){
    p.comboState={skillId:sid,slot:k,step:curStep,expireAt:Date.now()+(sk.comboWindow||600)};
    sendTo(id,{t:'combo',active:true,slot:k,windowMs:sk.comboWindow||600});
  } else {
    if(p.comboState && p.comboState.skillId===sid) p.comboState=null; // chỉ xóa combo CỦA CHÍNH skill này, không đụng combo skill khác đang chờ
    p.cd[k]=Math.max(0.3,sk.cd-(p.INT||0)*0.02);
    sendTo(id,{t:'skillcd',slot:k,dur:p.cd[k]});
  }
  execSkill(p,id,sk,(p.skRank&&p.skRank[sid])||1,curStep);
}
function rankMul(rank){ return 1+(rank-1)*0.22; } // rank 1..5 → tới +88% dmg
function getStance(p){ // Ma Kiếm Sĩ: CHỦ ĐỘNG chọn qua nút đổi vũ khí — nhị phân thật, không còn "lai/hybrid" mập mờ
  return p.bladeStance==='arcane' ? 'arcane' : 'blade'; // mặc định Kiếm
}
function auraBonus(p){ // Chỉ Huy: đồng minh gần được +8% dmg từ chính người đó khi tính damage của HỌ
  if(p.cls==='cmd')return 0; // bản thân không tự buff mình qua aura
  for(const pid in players){ const o=players[pid]; if(o===p||!o.chosen||o.dead||o.cls!=='cmd')continue;
    if(Math.hypot(o.x-p.x,o.y-p.y)<150) return 0.08*(1+((o.commandStateT>0)?(o.commandStateAuraBuf||0):0)); }
  return 0;
}
function markBonus(ent){ const s=getStatus(ent,'huntmark'); return s?(1+(s.data.bonus||0)):1; }
function arcMarkBonus(ent){ const s=getStatus(ent,'arcmark'); if(!s)return 1; clearStatus(ent,'arcmark'); return 1+(s.data.bonus||0); }
function mageReaction(p,sk){
  if(!sk.elem)return 1;
  let bonus=1;
  if(p.arcaneState && p.arcaneState!==sk.elem && (p.arcaneStateT||0)>0){ bonus=1.35; }
  p.arcaneState=sk.elem; p.arcaneStateT=4;
  return bonus;
}
function applyPassiveOnHit(p,id,target,dmg){
  let mul=1+auraBonus(p);
  if(p.cls==='blade' && p.spellBladeT>0){ mul*=1.5; p.spellBladeT=0; }
  if(p.cls==='blade'){
    const stance=getStance(p);
    mul*=1.15; // cả 3 trạng thái đều +15% dame như nhau — khác biệt nằm ở TIỆN ÍCH đi kèm, không phải ai mạnh hơn ai
    const lsPct=(stance==='blade')?0.10:0;
    if(lsPct>0) p.hp=Math.min(p.maxhp,p.hp+dmg*mul*lsPct);
    if(p.resonanceT>0) mul*=1.25;
    if(p.dualityT>0) mul*=(1+(p.dualityStacks||0)*0.08);
  }
  if(p.bannerAtkBuf) mul*=(1+p.bannerAtkBuf);
  if(p.decreeAtkBuf) mul*=(1+p.decreeAtkBuf);
  if(p.decreeDebuffT>0) mul*=(p.decreeDebuffMul||1);
  if(p.sacrificeAtkBufT>0) mul*=(1+(p.sacrificeAtkBuf||0));
  if(p.soulBufT>0) mul*=(1+(p.soulBuf||0));
  return dmg*mul;
}
function doBasic(p,id){
  const bladeArcaneMode = (p.cls==='blade' && getStance(p)==='arcane');
  const rng = bladeArcaneMode ? 260 : p.basicRange;
  const hit=nearestHostile(p,id,rng);
  let dmg=(p.basicDmg+POW(p))*(1+((p.gemBonus&&p.gemBonus.kim)||0)*0.08);
  if(p.cls==='arc' && hit && hit.ent.hp!==undefined && hit.ent.maxhp && (hit.ent.hp/hit.ent.maxhp)<0.3) dmg*=1.5; // Sát Thủ
  const useMelee = (p.basicType==='melee') && !bladeArcaneMode;
  if(useMelee){
    if(hit){const a=Math.atan2(hit.ent.y-p.y,hit.ent.x-p.x);p.fx=Math.cos(a);p.fy=Math.sin(a);
      if(p.cls==='blade'){ const d=Math.hypot(hit.ent.x-p.x,hit.ent.y-p.y); if(d>34){ p.x+=Math.cos(a)*Math.min(24,d-30); p.y+=Math.sin(a)*Math.min(24,d-30); clampPos(p); } }
      const fd=applyPassiveOnHit(p,id,hit.ent,dmg);
      if(hit.tp==='e')hurtEnemy(hit.ent,fd,id);else hurtPlayer(hit.ent,fd*PVP,id);
      if(p.cls==='war'){ p.fervor=Math.min(100,(p.fervor||0)+8); p.momT=0; }
      if(p.cls==='blade') p.momentum=Math.min(100,(p.momentum||0)+6);
    }
    fxEv('swing',p.x,p.y,p.hue,p.fx,p.fy,0);
  } else {
    let a; if(hit){a=Math.atan2(hit.ent.y-p.y,hit.ent.x-p.x);p.fx=Math.cos(a);p.fy=Math.sin(a);} else {a=Math.atan2(p.fy,p.fx);}
    let shotDmg=dmg; if(p.cls==='arc' && p.rhythmReady){ shotDmg*=1.25; p.rhythmReady=false; }
    const bSpd=bladeArcaneMode?540:p.basicSpd, bKind=bladeArcaneMode?'bolt':p.basicKind, bR=bladeArcaneMode?6:p.basicR, bHue=bladeArcaneMode?270:p.hue;
    bolts.push({x:p.x,y:p.y,zone:p.zone,vx:Math.cos(a)*bSpd,vy:Math.sin(a)*bSpd,life:1.0,dmg:applyPassiveOnHit(p,id,null,shotDmg),owner:id,hue:bHue,kind:bKind,r:bR});
    if(bladeArcaneMode && hit){ p.x-=Math.cos(a)*14; p.y-=Math.sin(a)*14; clampPos(p); } // Phép: lùi nhẹ mỗi phát — client giờ TỰ DỰ ĐOÁN đúng cú lùi này (xem hàm cast()), không còn xung đột nữa
    if(p.cls==='arc' && hit){ p.focus=Math.min(100,(p.focus||0)+10); p.rhythmFx=p.fx; p.rhythmFy=p.fy; p.rhythmT=0.6; }
    if(p.cls==='blade') p.arcane=Math.min(100,(p.arcane||0)+6);
  }
}
function execSkill(p,id,sk,rank,step){
  step=step||1;
  const mul=rankMul(rank||1);
  if(sk.type==='dash'){ p.x+=p.fx*sk.dist;p.y+=p.fy*sk.dist;clampPos(p);p.iframe=0.4;fxEv('dash',p.x,p.y,p.hue,p.fx,p.fy,0); }
  else if(sk.type==='predstep'){
    p.x+=p.fx*sk.dist; p.y+=p.fy*sk.dist; clampPos(p); p.iframe=0.3;
    fxEv('dash',p.x,p.y,p.hue,p.fx,p.fy,0);
    const near=nearestHostile(p,id,90);
    if(near && statusStacks(near.ent,'wound')>0){ p.cd.b=0; }
  }
  else if(sk.type==='warcleave'){
    const dashMul=(step===3)?1.3:1;
    p.x+=p.fx*(sk.dashDist||110)*dashMul; p.y+=p.fy*(sk.dashDist||110)*dashMul; clampPos(p); p.iframe=Math.max(p.iframe||0,0.25);
    const facingA=Math.atan2(p.fy,p.fx);
    const arcUse=(step===3)?sk.arc*1.2:sk.arc;
    const dmgMul=(step===3)?1.6:(step===2?1.3:1);
    const woundMul=(step===3)?1.7:(step===2?1.5:1.25);
    const healAmt=(step===3)?18:(step===2?14:8);
    const woundStacks=(step===3)?3:(step===2?2:1);
    const dmgInBase=applyPassiveOnHit(p,id,null,(sk.dmgIn+POW(p))*mul*dmgMul);
    const dmgOutBase=applyPassiveOnHit(p,id,null,(sk.dmgOut+POW(p)*0.6)*mul*dmgMul);
    const hitOne=(ent,isEnemy)=>{
      const dx=ent.x-p.x,dy=ent.y-p.y,d=Math.hypot(dx,dy); if(d>sk.rangeOut)return;
      const ang=Math.atan2(dy,dx); let df=Math.abs(ang-facingA); if(df>Math.PI)df=2*Math.PI-df; if(df>arcUse)return;
      const wounded=statusStacks(ent,'wound')>0;
      if(d<=sk.rangeIn){ let dm=dmgInBase; if(wounded){dm*=woundMul; p.hp=Math.min(p.maxhp,p.hp+healAmt);}
        if(isEnemy)hurtEnemy(ent,dm,id); else hurtPlayer(ent,dm*PVP,id);
      } else { let dm=dmgOutBase; if(wounded)dm*=woundMul;
        if(isEnemy)hurtEnemy(ent,dm,id); else hurtPlayer(ent,dm*PVP,id);
        addStatus(ent,'wound',{stacks:woundStacks,dur:6,maxStacks:5});
      }
    };
    for(const eid in enemies){const e=enemies[eid]; if(!e.dead) hitOne(e,true);}
    for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(o.chosen&&!o.dead&&o.iframe<=0) hitOne(o,false);}
    p.fervor=(step===3)?100:Math.min(100,(p.fervor||0)+(step===2?10:6)); p.momT=0;
    fxEv('dash',p.x,p.y,(step===3)?0:15,p.fx,p.fy,0);
    fxEv('bigswing',p.x,p.y,(step===3)?5:(step===2?12:35),p.fx,p.fy,(step===3)?210:(step===2?170:130));
  }
  else if(sk.type==='wcounter'){
    p.counterT=sk.dur; p.counterDmg=(sk.counterDmg+POW(p))*mul;
    fxEv('ring',p.x,p.y,p.hue,0,0,50);
  }
  else if(sk.type==='wexecute'){
    const hit=nearestHostile(p,id,sk.range);
    if(hit){
      const ent=hit.ent;
      const missingPct = ent.maxhp ? Math.max(0,1-(ent.hp/ent.maxhp)) : 0;
      const woundStacks = statusStacks(ent,'wound');
      const tierBonus = (p.fervor||0)>=80?1.4:((p.fervor||0)>=40?1.15:1);
      const dmg = applyPassiveOnHit(p,id,ent,(sk.baseDmg+POW(p)*0.8)*mul*(1+missingPct*1.5+woundStacks*0.15)*tierBonus);
      const willKill = ent.hp<=dmg;
      if(hit.tp==='e') hurtEnemy(ent,dmg,id); else hurtPlayer(ent,dmg*PVP,id);
      if(willKill){ p.fervor=Math.min(100,(p.fervor||0)+30); p.momT=0;
        for(const kk of ['q','w','e','r']) if(p.cd[kk]>0) p.cd[kk]=Math.max(0,p.cd[kk]-3); }
      fxEv('nova',ent.x,ent.y,0,0,0,60);
    }
    fxEv('swing',p.x,p.y,p.hue,p.fx,p.fy,0);
  }
  else if(sk.type==='warcry'){
    for(const eid in enemies){const e=enemies[eid]; if(e.dead)continue;
      if(Math.hypot(e.x-p.x,e.y-p.y)<sk.radius){ const amt=sk.atkDebuff*(e.boss?0.5:1); e.atkDebuffT=sk.debuffDur; e.atkDebuffMul=1-amt; } }
    if(p.party && parties[p.party]){
      for(const mid of parties[p.party].members){ const o=players[mid]; if(!o||!o.chosen||o.dead)continue;
        if(Math.hypot(o.x-p.x,o.y-p.y)<sk.radius){ o.warcryDefT=sk.buffDur; o.warcryDefMul=1-sk.defBuff; } }
    }
    fxEv('ring',p.x,p.y,p.hue,0,0,sk.radius);
  }
  else if(sk.type==='rupture'){
    const wantThrow = p.wasAimed && (p.aimMag*sk.throwRange > sk.range+20);
    if(wantThrow){
      const ax=p.x+p.fx*sk.throwRange*p.aimMag, ay=p.y+p.fy*sk.throwRange*p.aimMag;
      let best=45,bestEnt=null,bestTp=null;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; const d=Math.hypot(e.x-ax,e.y-ay); if(d<best){best=d;bestEnt=e;bestTp='e';}}
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone||zoneOf(o).safe)continue; const d=Math.hypot(o.x-ax,o.y-ay); if(d<best){best=d;bestEnt=o;bestTp='p';}}
      if(bestEnt){
        const a=Math.atan2(bestEnt.y-p.y,bestEnt.x-p.x);
        const dmg=applyPassiveOnHit(p,id,bestEnt,(sk.throwDmg+POW(p)*0.6)*mul);
        bolts.push({x:p.x,y:p.y,zone:p.zone,vx:Math.cos(a)*640,vy:Math.sin(a)*640,life:1.0,dmg,curDmg:dmg,owner:id,hue:p.hue,kind:'arrow',r:7,isThrownRupture:true,shredMul:sk.shredMul,shredDur:sk.shredDur});
      }
      fxEv('swing',p.x,p.y,p.hue,p.fx,p.fy,0);
    } else {
    const hit=nearestHostile(p,id,sk.range);
    if(hit){
      const ent=hit.ent;
      const dmg=applyPassiveOnHit(p,id,ent,(sk.dmg+POW(p))*mul);
      if(hit.tp==='p' && ent.shieldHP>0){
        const absorb=Math.min(ent.shieldHP,dmg*1.5); ent.shieldHP-=absorb;
        const rem=Math.max(0,dmg-absorb); if(rem>0)hurtPlayer(ent,rem*PVP,id);
      } else {
        addStatus(ent,'shred',{dur:sk.shredDur,data:{mul:sk.shredMul}});
        if(hit.tp==='e')hurtEnemy(ent,dmg,id); else hurtPlayer(ent,dmg*PVP,id);
      }
    }
    fxEv('swing',p.x,p.y,p.hue,p.fx,p.fy,0);
    }
  }
  else if(sk.type==='blooddebt'){
    let hit=null;
    if(p.wasAimed){
      const ax=p.x+p.fx*sk.range*p.aimMag, ay=p.y+p.fy*sk.range*p.aimMag;
      let best=40,bestEnt=null,bestTp=null;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; const d=Math.hypot(e.x-ax,e.y-ay); if(d<best){best=d;bestEnt=e;bestTp='e';}}
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone||zoneOf(o).safe)continue; const d=Math.hypot(o.x-ax,o.y-ay); if(d<best){best=d;bestEnt=o;bestTp='p';}}
      if(bestEnt) hit={ent:bestEnt,tp:bestTp};
    } else hit=nearestHostile(p,id,sk.range);
    if(hit){ p.debtTargetObj=hit.ent; p.debtIsEnemy=(hit.tp==='e'); p.debtAmount=0; p.debtT=sk.dur; p.debtBankPct=sk.bankPct;
      fxEv('ring',hit.ent.x,hit.ent.y,p.hue,0,0,40); }
  }
  else if(sk.type==='laststand'){
    p.lastStandT=sk.dur; p.momGenBonus=sk.momGen;
    fxEv('ring',p.x,p.y,48,0,0,60);
  }
  else if(sk.type==='groundbreak'){
    const fa=Math.atan2(p.fy,p.fx);
    const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul);
    const hitRect=(ent)=>{ const dx=ent.x-p.x,dy=ent.y-p.y;
      const fwd=dx*Math.cos(fa)+dy*Math.sin(fa), side=-dx*Math.sin(fa)+dy*Math.cos(fa);
      return fwd>=0 && fwd<=sk.len && Math.abs(side)<=sk.width/2; };
    for(const eid in enemies){const e=enemies[eid]; if(!e.dead && hitRect(e)){ hurtEnemy(e,dmg,id); e.slowT=sk.slowDur; e.slowMul=sk.slowMul; } }
    for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(o.chosen&&!o.dead&&o.iframe<=0&&hitRect(o)){ hurtPlayer(o,dmg*PVP,id); o.slowT=sk.slowDur; o.slowMul=sk.slowMul; } }
    fxEv('swing',p.x,p.y,p.hue,p.fx,p.fy,0); fxEv('dash',p.x+p.fx*sk.len*0.5,p.y+p.fy*sk.len*0.5,p.hue,p.fx,p.fy,0);
  }
  else if(sk.type==='warlordverdict'){
    let hit=null;
    if(p.wasAimed){
      const ax=p.x+p.fx*sk.range*p.aimMag, ay=p.y+p.fy*sk.range*p.aimMag;
      let best=40,bestEnt=null,bestTp=null;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; const d=Math.hypot(e.x-ax,e.y-ay); if(d<best){best=d;bestEnt=e;bestTp='e';}}
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone||zoneOf(o).safe)continue; const d=Math.hypot(o.x-ax,o.y-ay); if(d<best){best=d;bestEnt=o;bestTp='p';}}
      if(bestEnt) hit={ent:bestEnt,tp:bestTp};
    } else hit=nearestHostile(p,id,sk.range);
    if(hit){ p.duelTargetObj=hit.ent; p.duelIsEnemy=(hit.tp==='e'); p.duelT=sk.dur; p.duelElapsed=0; p.duelGrowth=sk.dmgGrowth; p.duelTickT=0; p.duelBaseDmg=POW(p)*0.3;
      fxEv('ring',p.x,p.y,0,0,0,sk.range); }
  }
  else if(sk.type==='pierce'){
    let a;
    if(p.wasAimed){ a=Math.atan2(p.fy,p.fx); }
    else { const hit=nearestHostile(p,id,500); if(hit){a=Math.atan2(hit.ent.y-p.y,hit.ent.x-p.x);p.fx=Math.cos(a);p.fy=Math.sin(a);} else a=Math.atan2(p.fy,p.fx); }
    const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul);
    bolts.push({x:p.x,y:p.y,zone:p.zone,vx:Math.cos(a)*sk.speed,vy:Math.sin(a)*sk.speed,life:1.0,dmg,curDmg:dmg,pierce:sk.maxHits,falloff:sk.falloff,owner:id,hue:p.hue,kind:'arrow',r:sk.r});
    fxEv('swing',p.x,p.y,p.hue,p.fx,p.fy,0);
  }
  else if(sk.type==='huntmark'){
    let hit=null;
    if(p.wasAimed){
      const ax=p.x+p.fx*sk.range*p.aimMag, ay=p.y+p.fy*sk.range*p.aimMag;
      let best=60,bestEnt=null,bestTp=null;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; const d=Math.hypot(e.x-ax,e.y-ay); if(d<best){best=d;bestEnt=e;bestTp='e';}}
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone||zoneOf(o).safe)continue; const d=Math.hypot(o.x-ax,o.y-ay); if(d<best){best=d;bestEnt=o;bestTp='p';}}
      if(bestEnt) hit={ent:bestEnt,tp:bestTp};
      if(!hit){ fxEv('ring',ax,ay,0,0,0,20); } // ngắm hụt — không trúng ai, vẫn hiện vòng báo hụt tại điểm ngắm
    }
    if(!hit && !p.wasAimed) hit=nearestHostile(p,id,sk.range); // bấm nhanh không ngắm = tiện tự nhắm gần nhất
    if(hit){ addStatus(hit.ent,'huntmark',{dur:sk.dur,data:{bonus:sk.bonusPct}}); fxEv('ring',hit.ent.x,hit.ent.y,120,0,0,30); }
  }
  else if(sk.type==='trap'){
    const rng=sk.range*(p.aimMag||1); const tx=p.x+p.fx*rng, ty=p.y+p.fy*rng;
    traps.push({x:tx,y:ty,zone:p.zone,owner:id,triggerR:sk.triggerR,rootDur:sk.rootDur,life:sk.life});
    fxEv('ring',tx,ty,90,0,0,sk.triggerR);
  }
  else if(sk.type==='starfall'){
    const rangeMul=[0.4,0.65,0.85,1.0][p.chargeTier||0];
    const searchR=sk.range*rangeMul;
    const impactR=34+14*(p.chargeTier||0);
    let lx,ly;
    if(p.wasAimed){ lx=p.x+p.fx*searchR*p.aimMag; ly=p.y+p.fy*searchR*p.aimMag; }
    else { const h=nearestHostile(p,id,searchR); if(h){lx=h.ent.x;ly=h.ent.y;} else {lx=p.x+p.fx*searchR;ly=p.y+p.fy*searchR;} }
    const baseDmg=(sk.dmg+POW(p))*mul*(p.chargeMul||1);
    for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; if(Math.hypot(e.x-lx,e.y-ly)<impactR){
      hurtEnemy(e,applyPassiveOnHit(p,id,e,baseDmg*markBonus(e)),id); e.slowT=sk.stunDur*(0.6+0.4*(p.chargeMul||1)); e.slowMul=0.03; addStatus(e,'huntmark',{dur:4,data:{bonus:0.2}}); }}
    for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone||zoneOf(o).safe)continue; if(Math.hypot(o.x-lx,o.y-ly)<impactR){
      hurtPlayer(o,applyPassiveOnHit(p,id,o,baseDmg*markBonus(o))*PVP,id); o.slowT=sk.stunDur*(0.6+0.4*(p.chargeMul||1)); o.slowMul=0.03; addStatus(o,'huntmark',{dur:4,data:{bonus:0.2}}); }}
    fxEv('starfall',lx,ly,120,p.x,p.y,impactR);
  }
  else if(sk.type==='spiritheal'){
    let target=p, bd=sk.range;
    for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead)continue;
      const d=Math.hypot(o.x-p.x,o.y-p.y); if(d<bd){bd=d; target=o;} }
    const missingPct=1-(target.hp/target.maxhp);
    const healAmt=(sk.heal+POW(p)*0.4)*mul*(1+missingPct*0.8);
    target.hp=Math.min(target.maxhp,target.hp+healAmt);
    fxEv('ring',target.x,target.y,140,0,0,40);
  }
  else if(sk.type==='allybuff'){
    if(p.party && parties[p.party]){
      for(const mid of parties[p.party].members){ const o=players[mid]; if(!o||!o.chosen||o.dead)continue;
        if(Math.hypot(o.x-p.x,o.y-p.y)<sk.radius){ o.warcryDefT=Math.max(o.warcryDefT||0,sk.dur); o.warcryDefMul=1-sk.defBuff; } }
    } else { p.warcryDefT=sk.dur; p.warcryDefMul=1-sk.defBuff; }
    fxEv('ring',p.x,p.y,140,0,0,sk.radius);
  }
  else if(sk.type==='twinshot'){
    const near=[];
    for(const eid in enemies){const e=enemies[eid]; if(!e.dead && e.zone===p.zone) near.push({ent:e,tp:'e',d:Math.hypot(e.x-p.x,e.y-p.y)});}
    for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(o.chosen&&!o.dead&&o.iframe<=0&&o.zone===p.zone&&!zoneOf(o).safe) near.push({ent:o,tp:'p',d:Math.hypot(o.x-p.x,o.y-p.y)});}
    near.sort((x,y)=>x.d-y.d);
    const targets=near.slice(0,2);
    const base=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul);
    const dmgFinal = targets.length<2 ? base*0.6 : base;
    targets.forEach(t=>{ if(t.tp==='e')hurtEnemy(t.ent,dmgFinal*markBonus(t.ent),id); else hurtPlayer(t.ent,dmgFinal*markBonus(t.ent)*PVP,id); });
    fxEv('swing',p.x,p.y,p.hue,p.fx,p.fy,0);
  }
  else if(sk.type==='windguard'){
    p.windguardT=sk.dur; p.windguardArc=sk.arc; p.windguardMul=sk.reduceMul; p.windguardFx=p.fx; p.windguardFy=p.fy;
    fxEv('ring',p.x,p.y,150,0,0,50);
  }
  else if(sk.type==='wildhunt'){
    let hit=null;
    if(p.wasAimed){
      const ax=p.x+p.fx*sk.range*p.aimMag, ay=p.y+p.fy*sk.range*p.aimMag;
      let best=40,bestEnt=null,bestTp=null;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; const d=Math.hypot(e.x-ax,e.y-ay); if(d<best){best=d;bestEnt=e;bestTp='e';}}
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone||zoneOf(o).safe)continue; const d=Math.hypot(o.x-ax,o.y-ay); if(d<best){best=d;bestEnt=o;bestTp='p';}}
      if(bestEnt) hit={ent:bestEnt,tp:bestTp};
    } else hit=nearestHostile(p,id,sk.range);
    if(hit){ p.wildHuntTargetObj=hit.ent; p.wildHuntT=sk.dur; p.aspdBonusWH=sk.aspdBonus;
      addStatus(hit.ent,'huntmark',{dur:sk.dur,data:{bonus:0.3}});
      fxEv('nova',hit.ent.x,hit.ent.y,120,0,0,60); }
  }
  else if(sk.type==='emberlance'){
    let a;
    if(p.wasAimed){ a=Math.atan2(p.fy,p.fx); }
    else { const hit=nearestHostile(p,id,500); if(hit){a=Math.atan2(hit.ent.y-p.y,hit.ent.x-p.x);p.fx=Math.cos(a);p.fy=Math.sin(a);} else a=Math.atan2(p.fy,p.fx); }
    const reactBonus=mageReaction(p,sk);
    const chM=p.chargeMul||1;
    const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul*reactBonus*chM);
    bolts.push({x:p.x,y:p.y,zone:p.zone,vx:Math.cos(a)*sk.speed,vy:Math.sin(a)*sk.speed,life:1.0,dmg,curDmg:dmg,owner:id,hue:20,kind:'bolt',r:sk.r*(0.8+0.3*chM),isFire:true,burnDmg:sk.burnDmg*chM});
    fxEv('swing',p.x,p.y,20,p.fx,p.fy,0);
  }
  else if(sk.type==='frostprism'){
    const rng2=sk.range*(p.aimMag||1); const cx=p.x+p.fx*rng2, cy=p.y+p.fy*rng2;
    mageReaction(p,sk);
    crystals.push({x:cx,y:cy,zone:p.zone,radius:sk.radius,life:sk.dur,owner:id});
    fxEv('ring',cx,cy,200,0,0,sk.radius);
  }
  else if(sk.type==='arcanethread'){
    const reactBonus=mageReaction(p,sk);
    const fa=Math.atan2(p.fy,p.fx);
    const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul*reactBonus);
    const hitRect=(ent)=>{ const dx=ent.x-p.x,dy=ent.y-p.y;
      const fwd=dx*Math.cos(fa)+dy*Math.sin(fa), side=-dx*Math.sin(fa)+dy*Math.cos(fa);
      return fwd>=0 && fwd<=sk.len && Math.abs(side)<=sk.width/2; };
    for(const eid in enemies){const e=enemies[eid]; if(!e.dead && e.zone===p.zone && hitRect(e)){ hurtEnemy(e,dmg,id); e.slowT=sk.slowDur; e.slowMul=sk.slowMul; } }
    for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(o.chosen&&!o.dead&&o.iframe<=0&&o.zone===p.zone&&!zoneOf(o).safe&&hitRect(o)){ hurtPlayer(o,dmg*PVP,id); o.slowT=sk.slowDur; o.slowMul=sk.slowMul; o.mp=Math.max(0,o.mp-sk.manaBurn); } }
    fxEv('swing',p.x,p.y,280,p.fx,p.fy,0);
  }
  else if(sk.type==='cataclysm'){
    const reactBonus=mageReaction(p,sk);
    const fa=Math.atan2(p.fy,p.fx);
    const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul*reactBonus);
    const hitRect=(ent)=>{ const dx=ent.x-p.x,dy=ent.y-p.y;
      const fwd=dx*Math.cos(fa)+dy*Math.sin(fa), side=-dx*Math.sin(fa)+dy*Math.cos(fa);
      return fwd>=0 && fwd<=sk.len && Math.abs(side)<=sk.width/2; };
    for(const eid in enemies){const e=enemies[eid]; if(!e.dead && e.zone===p.zone && hitRect(e)) hurtEnemy(e,dmg,id); }
    for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(o.chosen&&!o.dead&&o.iframe<=0&&o.zone===p.zone&&!zoneOf(o).safe&&hitRect(o)) hurtPlayer(o,dmg*PVP,id); }
    fxEv('ring',p.x+p.fx*sk.len*0.5,p.y+p.fy*sk.len*0.5,280,0,0,sk.width);
  }
  else if(sk.type==='mirrorstep'){
    const oldX=p.x, oldY=p.y;
    p.x+=p.fx*sk.dist; p.y+=p.fy*sk.dist; clampPos(p); p.iframe=Math.max(p.iframe||0,0.3);
    illusions.push({x:oldX,y:oldY,zone:p.zone,life:sk.confuseDur||3,cls:p.cls,hue:p.hue});
    fxEv('ring',oldX,oldY,280,0,0,40);
    fxEv('dash',p.x,p.y,280,p.fx,p.fy,0);
  }
  else if(sk.type==='timeecho'){
    if(step===2 && p.echoPos){
      const dist=Math.hypot(p.x-p.echoPos.x,p.y-p.echoPos.y);
      if(dist<=(sk.maxDist||500)){
        p.x=p.echoPos.x; p.y=p.echoPos.y; clampPos(p);
        const dmg=applyPassiveOnHit(p,id,null,(sk.aoeDmg+POW(p))*mul);
        for(const eid in enemies){const e=enemies[eid]; if(!e.dead && e.zone===p.zone && Math.hypot(e.x-p.x,e.y-p.y)<=(sk.aoeR||70)) hurtEnemy(e,dmg,id);}
        for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(o.chosen&&!o.dead&&o.iframe<=0&&o.zone===p.zone&&!zoneOf(o).safe&&Math.hypot(o.x-p.x,o.y-p.y)<=(sk.aoeR||70)) hurtPlayer(o,dmg*PVP,id); }
        fxEv('nova',p.x,p.y,280,0,0,sk.aoeR||70);
      } else { fxEv('ring',p.x,p.y,0,0,0,20); } // quá xa điểm ghi — không quay được, chỉ báo hụt
      p.echoPos=null;
      sendTo(id,{t:'echomark',active:false});
    } else {
      p.echoPos={x:p.x,y:p.y};
      fxEv('ring',p.x,p.y,280,0,0,30);
      sendTo(id,{t:'echomark',active:true,x:p.x,y:p.y,zone:p.zone,maxDist:sk.maxDist||500,windowMs:sk.comboWindow||5000});
    }
  }
  else if(sk.type==='gravitywell'){
    const rng=sk.range*(p.aimMag||1);
    const wx=p.x+p.fx*rng, wy=p.y+p.fy*rng;
    wells.push({x:wx,y:wy,zone:p.zone,radius:sk.radius,life:sk.life,pullSpd:sk.pullSpd,dmg:sk.dmg,owner:id,tickT:0});
    fxEv('ring',wx,wy,280,0,0,sk.radius);
  }
  else if(sk.type==='arcanedet'){
    let hit=null;
    if(p.wasAimed){
      const ax=p.x+p.fx*sk.range*p.aimMag, ay=p.y+p.fy*sk.range*p.aimMag;
      let best=32,bestEnt=null,bestTp=null;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; const d=Math.hypot(e.x-ax,e.y-ay); if(d<best){best=d;bestEnt=e;bestTp='e';}}
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone||zoneOf(o).safe)continue; const d=Math.hypot(o.x-ax,o.y-ay); if(d<best){best=d;bestEnt=o;bestTp='p';}}
      if(bestEnt) hit={ent:bestEnt,tp:bestTp};
      if(!hit) fxEv('ring',ax,ay,0,0,0,20); // ngắm hụt — không đóng dấu ai cả
    } else hit=nearestHostile(p,id,sk.range);
    if(hit){ addStatus(hit.ent,'arcmark',{dur:sk.dur,data:{bonus:sk.bonusPct}}); fxEv('ring',hit.ent.x,hit.ent.y,280,0,0,30); }
  }
  else if(sk.type==='elemshift'){
    const cyc={fire:'frost',frost:'arcane',arcane:'fire'};
    const nx=cyc[p.arcaneState]||'fire';
    p.arcaneState=nx; p.arcaneStateT=4;
    fxEv('ring',p.x,p.y,nx==='fire'?20:(nx==='frost'?200:280),0,0,25);
  }
  else if(sk.type==='ravenmark'){
    let hit=null;
    if(p.wasAimed){
      const ax=p.x+p.fx*sk.range*p.aimMag, ay=p.y+p.fy*sk.range*p.aimMag;
      let best=40,bestEnt=null,bestTp=null;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; const d=Math.hypot(e.x-ax,e.y-ay); if(d<best){best=d;bestEnt=e;bestTp='e';}}
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone||zoneOf(o).safe)continue; const d=Math.hypot(o.x-ax,o.y-ay); if(d<best){best=d;bestEnt=o;bestTp='p';}}
      if(bestEnt) hit={ent:bestEnt,tp:bestTp};
    } else hit=nearestHostile(p,id,sk.range);
    if(hit){ addStatus(hit.ent,'ravenmark',{dur:sk.dur,data:{bonus:sk.bonusPct}}); fxEv('raven',hit.ent.x,hit.ent.y,45,p.x,p.y,0); }
  }
  else if(sk.type==='cmdadvance'){
    if(!p.summon){ sendTo(id,{t:'toast',text:'Cần triệu hồi Cấm Vệ Quân (Uy Lệnh) trước khi ra lệnh xung phong'}); return; }
    if((p.authority||0)<sk.authCost){ sendTo(id,{t:'toast',text:'Không đủ Uy Quyền ('+Math.floor(p.authority||0)+'/'+sk.authCost+')'}); return; }
    p.authority-=sk.authCost;
    const rng=sk.range*(p.aimMag||1);
    let ox=p.x+p.fx*rng, oy=p.y+p.fy*rng;
    const sox=p.summon.x, soy=p.summon.y;
    const distFromSummon=Math.hypot(ox-sox,oy-soy);
    const orderRange=sk.orderRange||sk.range;
    if(distFromSummon>orderRange){ const sc=orderRange/distFromSummon; ox=sox+(ox-sox)*sc; oy=soy+(oy-soy)*sc; }
    let lockId=null,best=50;
    for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; const d=Math.hypot(e.x-ox,e.y-oy); if(d<best){best=d;lockId=eid;}}
    if(lockId){ ox=enemies[lockId].x; oy=enemies[lockId].y; }
    p.summon.orderX=ox; p.summon.orderY=oy; p.summon.orderPhase='charge'; p.summon.orderTargetId=lockId;
    p.summon.orderHoldDurV=sk.orderHoldDur||2.5; p.summon.sweepDmgV=(sk.sweepDmg+POW(p)*0.3); p.summon.sweepRV=sk.sweepR||55;
    p.summon.sweepHit=null;
    fxEv('orderflag',ox,oy,45,sox,soy,0);
  }
  else if(sk.type==='banner'){
    if((p.authority||0)<sk.authCost)return; p.authority-=sk.authCost;
    const rng=sk.range*(p.aimMag||1);
    const bx=p.x+p.fx*rng, by=p.y+p.fy*rng;
    banners.push({x:bx,y:by,zone:p.zone,radius:sk.radius,life:sk.life,atkBuf:sk.atkBuf,defBuf:sk.defBuf,owner:id});
    fxEv('plantflag',bx,by,45,0,0,sk.radius);
  }
  else if(sk.type==='legiondecree'){
    if((p.authority||0)<sk.authCost)return; p.authority-=sk.authCost;
    for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue;
      if(Math.hypot(e.x-p.x,e.y-p.y)<sk.radius){ e.atkDebuffT=sk.dur; e.atkDebuffMul=1-sk.enemyDebuf; } }
    for(const pid2 in players){const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone)continue;
      if(Math.hypot(o.x-p.x,o.y-p.y)>sk.radius)continue;
      const isAlly=(pid2===id)||(o.party && p.party && o.party===p.party);
      if(isAlly){ o.decreeAtkBuf=sk.atkBuf; o.decreeDefBuf=sk.defBuf; o.decreeBuffT=sk.dur; }
      else if(!zoneOf(o).safe){ o.decreeDebuffMul=1-sk.enemyDebuf; o.decreeDebuffT=sk.dur; }
    }
    fxEv('rally',p.x,p.y,45,0,0,sk.radius);
  }
  else if(sk.type==='ravenseye'){
    for(const pid2 in players){const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone)continue;
      const isAlly=(pid2===id)||(o.party && p.party && o.party===p.party);
      if(isAlly && Math.hypot(o.x-p.x,o.y-p.y)<sk.radius){ o.buffT=Math.max(o.buffT||0,sk.dur); o.buffSpdMul=Math.max(o.buffSpdMul||1,1+sk.rangeBuf); o.buffAtk=o.buffAtk||0; } }
    fxEv('ravenscout',p.x,p.y,45,0,0,sk.radius);
  }
  else if(sk.type==='royalsummons'){
    if(!p.summon){ sendTo(id,{t:'toast',text:'Chưa có Cấm Vệ Quân để triệu hồi về'}); return; }
    p.summon.x=p.x+p.fx*30; p.summon.y=p.y+p.fy*30; p.summon.zone=p.zone;
    p.summon.orderPhase=null; p.summon.orderTargetId=null; p.summon.chargeT=0;
    fxEv('ring',p.summon.x,p.summon.y,45,0,0,30);
  }
  else if(sk.type==='tacticalrecall'){
    let targetId=null;
    if(p.wasAimed){
      const ax=p.x+p.fx*sk.range*p.aimMag, ay=p.y+p.fy*sk.range*p.aimMag;
      let best=45;
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone)continue;
        if(!o.party||!p.party||o.party!==p.party)continue;
        const d=Math.hypot(o.x-ax,o.y-ay); if(d<best){best=d;targetId=pid2;} }
    }
    if(!targetId){ sendTo(id,{t:'toast',text:'Cần nhắm trúng 1 đồng đội cùng tổ đội'}); return; }
    p.tacticalPullT=sk.delay; p.tacticalPullTargetId=targetId; p.tacticalPullDist=sk.pullDist;
    fxEv('ring',players[targetId].x,players[targetId].y,45,0,0,25);
  }
  else if(sk.type==='horsecharge'){
    const fa=Math.atan2(p.fy,p.fx);
    const startX=p.x, startY=p.y;
    p.x+=p.fx*sk.len; p.y+=p.fy*sk.len; clampPos(p); p.iframe=Math.max(p.iframe||0,0.3);
    const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul);
    for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue;
      const dx=e.x-startX,dy=e.y-startY;
      const fwd=dx*Math.cos(fa)+dy*Math.sin(fa), side=-dx*Math.sin(fa)+dy*Math.cos(fa);
      if(fwd<0||fwd>sk.len||Math.abs(side)>sk.width/2)continue;
      hurtEnemy(e,dmg,id);
      const pushSign=side>=0?1:-1;
      e.x+=(-Math.sin(fa)*pushSign)*sk.pushDist; e.y+=(Math.cos(fa)*pushSign)*sk.pushDist; clampEnemyPos(e);
    }
    for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.iframe>0||o.zone!==p.zone||zoneOf(o).safe)continue;
      const dx=o.x-startX,dy=o.y-startY;
      const fwd=dx*Math.cos(fa)+dy*Math.sin(fa), side=-dx*Math.sin(fa)+dy*Math.cos(fa);
      if(fwd<0||fwd>sk.len||Math.abs(side)>sk.width/2)continue;
      hurtPlayer(o,dmg*PVP,id);
      const pushSign=side>=0?1:-1;
      o.x+=(-Math.sin(fa)*pushSign)*sk.pushDist; o.y+=(Math.cos(fa)*pushSign)*sk.pushDist; clampPos(o);
    }
    fxEv('horsecharge',p.x,p.y,45,startX,startY,sk.width);
  }
  else if(sk.type==='cmdsacrifice'){
    if(!p.summon){ sendTo(id,{t:'toast',text:'Cần triệu hồi Cấm Vệ Quân trước khi hi sinh'}); return; }
    p.summon.expireT=Math.max(1,p.summon.expireT-sk.durCost);
    for(const pid2 in players){const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone)continue;
      if(pid2!==id && (!o.party||!p.party||o.party!==p.party))continue;
      o.hp=Math.min(o.maxhp,o.hp+sk.healBurst); o.sacrificeAtkBuf=sk.atkBuf; o.sacrificeAtkBufT=sk.dur;
    }
    fxEv('sacrifice',p.x,p.y,45,0,0,60);
  }
  else if(sk.type==='soulledger'){
    const frags=p.soulFrags||0;
    if(frags<=0){ sendTo(id,{t:'toast',text:'Chưa có mảnh hồn — hạ địch gần đó để thu thập trước'}); return; }
    p.soulFrags=0;
    p.hp=Math.min(p.maxhp,p.hp+frags*sk.healPerFrag);
    p.soulBuf=frags*sk.buffPerFrag; p.soulBufT=6;
    fxEv('soulburst',p.x,p.y,280,0,0,40+frags*4);
  }
  else if(sk.type==='emperorswill'){
    if((p.authority||0)<sk.authCost)return; p.authority-=sk.authCost;
    p.commandStateT=sk.dur; p.commandStateSummonBuf=sk.summonBuf; p.commandStateBannerBuf=sk.bannerBuf; p.commandStateAuraBuf=sk.auraBuf;
    fxEv('rally',p.x,p.y,280,0,0,180);
  }
  else if(sk.type==='blinkcut'){
    const stance=getStance(p);
    if(stance==='arcane'){
      const oldX=p.x,oldY=p.y;
      p.x+=p.fx*sk.distArcane; p.y+=p.fy*sk.distArcane; clampPos(p); p.iframe=Math.max(p.iframe||0,0.25);
      p.arcane=Math.min(100,(p.arcane||0)+6);
      fxEv('arcblink',oldX,oldY,270,p.x,p.y,0);
    } else {
      const dist=sk.distBlade;
      const startX=p.x,startY=p.y;
      p.x+=p.fx*dist; p.y+=p.fy*dist; clampPos(p); p.iframe=Math.max(p.iframe||0,0.25);
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgBlade+POW(p))*mul);
      const fa=Math.atan2(p.fy,p.fx);
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue;
        const dx=e.x-startX,dy=e.y-startY;
        const fwd=dx*Math.cos(fa)+dy*Math.sin(fa), side=-dx*Math.sin(fa)+dy*Math.cos(fa);
        if(fwd>=0&&fwd<=dist&&Math.abs(side)<=30) hurtEnemy(e,dmg,id);
      }
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.iframe>0||o.zone!==p.zone||zoneOf(o).safe)continue;
        const dx=o.x-startX,dy=o.y-startY;
        const fwd=dx*Math.cos(fa)+dy*Math.sin(fa), side=-dx*Math.sin(fa)+dy*Math.cos(fa);
        if(fwd>=0&&fwd<=dist&&Math.abs(side)<=30) hurtPlayer(o,dmg*PVP,id);
      }
      p.momentum=Math.min(100,(p.momentum||0)+6);
      p.spellBladeT=3;
      fxEv('phaseslash',startX,startY,15,p.x,p.y,0);
    }
  }
  else if(sk.type==='arcslash'){
    const stance=getStance(p);
    if(stance==='arcane'){
      const a=Math.atan2(p.fy,p.fx);
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgArcane+POW(p))*mul);
      bolts.push({x:p.x,y:p.y,zone:p.zone,vx:Math.cos(a)*640,vy:Math.sin(a)*640,life:sk.rangeArcane/640,dmg,curDmg:dmg,pierce:sk.piercArcane,falloff:0.85,owner:id,hue:270,kind:'blade',r:14});
      p.x-=p.fx*22; p.y-=p.fy*22; clampPos(p);
      p.arcane=Math.min(100,(p.arcane||0)+8);
      p.spellBladeT=3;
      fxEv('backstep',p.x,p.y,270,p.fx,p.fy,0);
    } else {
      const startX=p.x,startY=p.y;
      p.x+=p.fx*38; p.y+=p.fy*38; clampPos(p);
      const fa=Math.atan2(p.fy,p.fx);
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgBlade+POW(p))*mul);
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue;
        const dx=e.x-p.x,dy=e.y-p.y,d=Math.hypot(dx,dy); if(d>sk.range)continue;
        const ang=Math.atan2(dy,dx); let df=Math.abs(ang-fa); if(df>Math.PI)df=2*Math.PI-df; if(df>sk.arc)continue;
        hurtEnemy(e,dmg,id);
      }
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.iframe>0||o.zone!==p.zone||zoneOf(o).safe)continue;
        const dx=o.x-p.x,dy=o.y-p.y,d=Math.hypot(dx,dy); if(d>sk.range)continue;
        const ang=Math.atan2(dy,dx); let df=Math.abs(ang-fa); if(df>Math.PI)df=2*Math.PI-df; if(df>sk.arc)continue;
        hurtPlayer(o,dmg*PVP,id);
      }
      p.momentum=Math.min(100,(p.momentum||0)+8);
      p.spellBladeT=3;
      fxEv('phaseslash',startX,startY,15,p.x,p.y,0);
    }
  }
  else if(sk.type==='swordwave'){
    const stance=getStance(p);
    const fa=Math.atan2(p.fy,p.fx);
    if(stance==='arcane'){
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgArcane+POW(p))*mul);
      for(let i=0;i<3;i++){ const a=fa+(i-1)*0.22;
        bolts.push({x:p.x,y:p.y,zone:p.zone,vx:Math.cos(a)*580,vy:Math.sin(a)*580,life:1.1,dmg,curDmg:dmg,pierce:2,falloff:0.75,owner:id,hue:270,kind:'bolt',r:6}); }
      p.x-=p.fx*30; p.y-=p.fy*30; clampPos(p); // lùi hẳn 1 bước trong lúc bắn — kite thật, không đứng ì
      p.arcane=Math.min(100,(p.arcane||0)+9);
      p.spellBladeT=3;
      fxEv('backstep',p.x,p.y,270,p.fx,p.fy,0);
    } else {
      const swStartX=p.x,swStartY=p.y;
      p.x+=p.fx*70; p.y+=p.fy*70; clampPos(p);
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgBlade+POW(p))*mul*0.85);
      let swHit=0;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone||swHit>=6)continue;
        const dm=Math.hypot(e.x-swStartX,e.y-swStartY),de=Math.hypot(e.x-p.x,e.y-p.y);
        if(Math.min(dm,de)<=90){ hurtEnemy(e,dmg,id); swHit++; } }
      for(const pid2 in players){ if(pid2==id||swHit>=6)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.iframe>0||o.zone!==p.zone||zoneOf(o).safe)continue;
        const dm=Math.hypot(o.x-swStartX,o.y-swStartY),de=Math.hypot(o.x-p.x,o.y-p.y);
        if(Math.min(dm,de)<=90){ hurtPlayer(o,dmg*PVP,id); swHit++; } }
      p.momentum=Math.min(100,(p.momentum||0)+9);
      p.spellBladeT=3;
      fxEv('spinattack',p.x,p.y,15,swStartX,swStartY,90);
    }
  }
  else if(sk.type==='stormblade'){
    const stance=getStance(p);
    if(stance==='arcane'){
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgArcane+POW(p))*mul);
      aoe(p,sk.radius*0.75,dmg,id,0.5,2.5);
      p.mp=Math.min(p.maxmp,p.mp+p.maxmp*0.25);
      p.arcane=Math.min(100,(p.arcane||0)+15);
      p.levitateT=1.2;
      p.spellBladeT=3;
      fxEv('levitatenova',p.x,p.y,270,0,0,sk.radius*0.75);
    } else {
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgBlade+POW(p))*mul);
      p.iframe=Math.max(p.iframe||0,0.4); p.jumpT=0.4; p.jumpScale=1;
      aoe(p,sk.radius,dmg,id);
      p.hp=Math.min(p.maxhp,p.hp+dmg*0.15);
      p.momentum=Math.min(100,(p.momentum||0)+15);
      p.spellBladeT=3;
      fxEv('jumpslam',p.x,p.y,15,0,0,sk.radius);
    }
  }
  else if(sk.type==='bloodsword'){
    const stance=getStance(p);
    let h=null; const rng=(stance==='arcane')?sk.rangeArcane:sk.rangeBlade;
    if(p.wasAimed){
      const ax=p.x+p.fx*rng*p.aimMag, ay=p.y+p.fy*rng*p.aimMag;
      let best=40,bestEnt=null,bestTp=null;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; const d=Math.hypot(e.x-ax,e.y-ay); if(d<best){best=d;bestEnt=e;bestTp='e';}}
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone||zoneOf(o).safe)continue; const d=Math.hypot(o.x-ax,o.y-ay); if(d<best){best=d;bestEnt=o;bestTp='p';}}
      if(bestEnt) h={ent:bestEnt,tp:bestTp};
    } else h=nearestHostile(p,id,rng);
    if(h){
      const a=Math.atan2(h.ent.y-p.y,h.ent.x-p.x);p.fx=Math.cos(a);p.fy=Math.sin(a);
      if(stance==='arcane'){
        const dmg=applyPassiveOnHit(p,id,null,(sk.dmgArcane+POW(p))*mul);
        if(h.tp==='e')hurtEnemy(h.ent,dmg,id); else hurtPlayer(h.ent,dmg*PVP,id);
        const heal=Math.round(dmg*sk.lsArcane); p.hp=Math.min(p.maxhp,p.hp+heal); hitEv(p.x,p.y-20,heal,true);
        addStatus(h.ent,'burn',{dur:3,data:{dmgPerTick:dmg*0.08,tickInt:1,ownerId:id}});
        p.arcane=Math.min(100,(p.arcane||0)+8);
        p.spellBladeT=3;
        fxEv('drainbeam',p.x,p.y,270,h.ent.x,h.ent.y,0);
      } else {
        const dToH=Math.hypot(h.ent.x-p.x,h.ent.y-p.y);
        if(dToH>40){ p.x+=Math.cos(a)*Math.min(50,dToH-36); p.y+=Math.sin(a)*Math.min(50,dToH-36); clampPos(p); }
        const dmg=applyPassiveOnHit(p,id,null,(sk.dmgBlade+POW(p))*mul);
        if(h.tp==='e')hurtEnemy(h.ent,dmg,id); else hurtPlayer(h.ent,dmg*PVP,id);
        const heal=Math.round(dmg*sk.lsBlade); p.hp=Math.min(p.maxhp,p.hp+heal); hitEv(p.x,p.y-20,heal,true);
        p.momentum=Math.min(100,(p.momentum||0)+8);
        p.spellBladeT=3;
        fxEv('swing',p.x,p.y,340,p.fx,p.fy,0);
      }
    }
  }
  else if(sk.type==='bodyward'){
    const stance=getStance(p);
    if(stance==='arcane'){
      p.shieldHP=sk.amountArcane*mul; p.shieldT=sk.dur; p.shieldManaMode=true; p.shieldOrigAmount=p.shieldHP; p.shieldReflect=0;
      p.arcane=Math.min(100,(p.arcane||0)+6);
      p.levitateT=Math.min(1.5,sk.dur);
    } else {
      p.shieldHP=sk.amountBlade*mul; p.shieldT=sk.dur; p.shieldReflect=sk.reflectPct; p.shieldManaMode=false;
      p.momentum=Math.min(100,(p.momentum||0)+6);
      p.braceT=sk.dur;
    }
    fxEv(stance==='arcane'?'levitatenova':'braceward',p.x,p.y,stance==='arcane'?270:15,0,0,50);
  }
  else if(sk.type==='iceblade'){
    const stance=getStance(p);
    if(stance==='arcane') p.levitateT=0.6; else { p.jumpT=0.4; p.jumpScale=0.4; p.iframe=Math.max(p.iframe||0,0.1); }
    const dmg=applyPassiveOnHit(p,id,null,((stance==='arcane'?sk.dmgArcane:sk.dmgBlade)+POW(p))*mul);
    for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; if(Math.hypot(e.x-p.x,e.y-p.y)>sk.radius)continue;
      hurtEnemy(e,dmg,id); e.slowT=sk.slowDur; e.slowMul=sk.slowMul;
      if(stance==='arcane') addStatus(e,'bladefrost',{dur:3,data:{bonus:0.2}}); else addStatus(e,'wound',{stacks:1,dur:6,maxStacks:5}); }
    for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.iframe>0||o.zone!==p.zone||zoneOf(o).safe)continue; if(Math.hypot(o.x-p.x,o.y-p.y)>sk.radius)continue;
      hurtPlayer(o,dmg*PVP,id); o.slowT=sk.slowDur; o.slowMul=sk.slowMul;
      if(stance==='arcane') addStatus(o,'bladefrost',{dur:3,data:{bonus:0.2}}); else addStatus(o,'wound',{stacks:1,dur:6,maxStacks:5}); }
    if(stance==='arcane') p.arcane=Math.min(100,(p.arcane||0)+8); else p.momentum=Math.min(100,(p.momentum||0)+8);
    p.spellBladeT=3;
    fxEv(stance==='arcane'?'levitatenova':'jumpslam',p.x,p.y,stance==='arcane'?270:15,0,0,sk.radius);
  }
  else if(sk.type==='voidsword'){
    const stance=getStance(p);
    const dist=(stance==='arcane')?sk.distArcane:sk.distBlade;
    p.x+=p.fx*dist; p.y+=p.fy*dist; clampPos(p); p.iframe=Math.max(p.iframe||0,0.3);
    if(stance==='arcane'){
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgArcane+POW(p))*mul);
      aoe(p,60,dmg,id);
      dotZones.push({x:p.x,y:p.y,zone:p.zone,radius:60,life:sk.zoneDur,dmg:dmg*0.25,owner:id,tickT:0});
      p.arcane=Math.min(100,(p.arcane||0)+10);
      p.spellBladeT=3;
      fxEv('ring',p.x,p.y,270,0,0,sk.impactR);
    } else {
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgBlade+POW(p))*mul);
      aoe(p,sk.impactR,dmg,id);
      p.momentum=Math.min(100,(p.momentum||0)+10);
      p.spellBladeT=3;
      fxEv('nova',p.x,p.y,15,0,0,sk.impactR);
    }
  }
  else if(sk.type==='dualresonance'){
    p.resonanceT=sk.dur;
    fxEv('resonance',p.x,p.y,190,0,0,40);
  }
  else if(sk.type==='dualitycollapse'){
    p.dualityT=sk.dur;
    p.dualityStacks=0;
    fxEv('resonance',p.x,p.y,190,0,0,60);
  }
  else if(sk.type==='cone'){
    let fbonus=1;
    if(p.cls==='war'){fbonus=1+((p.fervor||0)*0.005); p.fervor=0;}
    if(p.cls==='blade'){ p.momentum=Math.min(100,(p.momentum||0)+12);
      if((p.arcane||0)>=50){ fbonus=1.6; p.arcane-=50; } }
    const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul*fbonus);
    for(const eid in enemies){const e=enemies[eid];if(e.dead)continue;if(inCone(p,e,sk.range,sk.arc)){hurtEnemy(e,dmg,id);if(p.cls==='blade')p.spellBladeT=3;}}
    for(const pid in players){if(pid==id)continue;const o=players[pid];if(!o.chosen||o.dead||o.iframe>0)continue;if(inCone(p,o,sk.range,sk.arc))hurtPlayer(o,dmg*PVP,id);}
    fxEv('swing',p.x,p.y,p.hue,p.fx,p.fy,0);
  }
  else if(sk.type==='nova'){
    let fbonus=1;
    if(p.cls==='war'){fbonus=1+((p.fervor||0)*0.005); p.fervor=0;}
    if(p.cls==='blade'){ p.arcane=Math.min(100,(p.arcane||0)+12);
      if((p.momentum||0)>=50){ fbonus=1.6; p.momentum-=50; } }
    const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+skDmgPow(p,sk))*mul*fbonus);
    aoe(p,sk.radius,dmg,id); fxEv(sk.radius>175?'ring':'nova',p.x,p.y,p.hue,0,0,sk.radius);
    if(p.cls==='blade')p.spellBladeT=3; }
  else if(sk.type==='proj'){
    const n=sk.count||1, spread=sk.spread||0; let base=Math.atan2(p.fy,p.fx);
    if(n===1 && !p.wasAimed){const h=nearestHostile(p,id,600); if(h){base=Math.atan2(h.ent.y-p.y,h.ent.x-p.x);p.fx=Math.cos(base);p.fy=Math.sin(base);}}
    let fbonus=1; if(p.cls==='arc' && n>1){ fbonus=1+((p.focus||0)*0.005); p.focus=0; }
    const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+skDmgPow(p,sk))*mul*fbonus);
    for(let i=0;i<n;i++){ const a=base+(n>1?spread*(i/(n-1)-0.5):0);
      bolts.push({x:p.x,y:p.y,zone:p.zone,vx:Math.cos(a)*sk.speed,vy:Math.sin(a)*sk.speed,life:1.1,dmg,owner:id,hue:p.hue,kind:sk.kind||'orb',r:sk.r||6,
        slowMul:sk.slowMul,slowDur:sk.slowDur}); }
    if(p.cls==='mage'){ p.comboN=(p.comboN||0)+1; if(p.comboN>=3){ p.comboN=0;
      setTimeout(()=>{ if(players[id]) aoe(p,90,dmg*0.4,id); },260); } }
    if(p.cls==='blade'){ p.spellBladeT=3; p.arcane=Math.min(100,(p.arcane||0)+10); }
    if(p.cls==='cmd' && sk.authGain) p.authority=Math.min(100,(p.authority||0)+sk.authGain);
  }
  else if(sk.type==='heal'){
    const amt=sk.heal*mul;
    for(const pid in players){const o=players[pid];if(!o.chosen||o.dead)continue;
      if(o===p||Math.hypot(o.x-p.x,o.y-p.y)<sk.radius){o.hp=Math.min(o.maxhp,o.hp+amt);hitEv(o.x,o.y-16,amt,true);}}
    if(p.cls==='cmd' && sk.authGain) p.authority=Math.min(100,(p.authority||0)+sk.authGain);
    fxEv('heal',p.x,p.y,140,0,0,sk.radius);
  }
  else if(sk.type==='buff'){ p.buffT=sk.dur;p.buffAtk=(sk.atk||0)*mul;p.buffSpdMul=sk.spdmul||1;
    if(sk.dmg)aoe(p,sk.radius||150,(sk.dmg+POW(p))*mul,id);
    if(p.cls==='cmd' && sk.authGain) p.authority=Math.min(100,(p.authority||0)+sk.authGain);
    fxEv('ring',p.x,p.y,p.hue,0,0,sk.radius||150); }
  else if(sk.type==='summon'){
    p.summon={x:p.x,y:p.y,zone:p.zone,atk:Math.round((sk.atk+POW(p))*mul*0.6),expireT:sk.dur,atkT:0};
    for(const pid in players){const o=players[pid];if(!o.chosen||o.dead)continue;
      if(Math.hypot(o.x-p.x,o.y-p.y)<sk.radius){ o.buffT=Math.max(o.buffT||0,sk.dur*0.4); o.buffAtk=(o.buffAtk||0)+Math.round(POW(p)*0.2); }}
    if(p.cls==='cmd' && sk.authGain) p.authority=Math.min(100,(p.authority||0)+sk.authGain);
    fxEv('ring',p.x,p.y,p.hue,0,0,sk.radius||150); }
  else if(sk.type==='shield'){
    p.shieldHP=(sk.amount+skDmgPow(p,sk)*0.4)*mul; p.shieldT=sk.dur;
    if(sk.radius){ for(const pid in players){const o=players[pid];if(o===p||!o.chosen||o.dead)continue;
      if(Math.hypot(o.x-p.x,o.y-p.y)<sk.radius){o.shieldHP=p.shieldHP;o.shieldT=sk.dur;} } }
    if(p.cls==='blade') p.arcane=Math.min(100,(p.arcane||0)+10);
    if(p.cls==='cmd' && sk.authGain) p.authority=Math.min(100,(p.authority||0)+sk.authGain);
    fxEv('shield',p.x,p.y,195,0,0,sk.radius||70);
  }
  else if(sk.type==='lifesteal'){
    let h=null;
    if(p.wasAimed){
      const ax=p.x+p.fx*sk.range*p.aimMag, ay=p.y+p.fy*sk.range*p.aimMag;
      let best=40,bestEnt=null,bestTp=null;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; const d=Math.hypot(e.x-ax,e.y-ay); if(d<best){best=d;bestEnt=e;bestTp='e';}}
      for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.zone!==p.zone||zoneOf(o).safe)continue; const d=Math.hypot(o.x-ax,o.y-ay); if(d<best){best=d;bestEnt=o;bestTp='p';}}
      if(bestEnt) h={ent:bestEnt,tp:bestTp};
    } else h=nearestHostile(p,id,sk.range);
    if(h){ const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul);
      const a=Math.atan2(h.ent.y-p.y,h.ent.x-p.x);p.fx=Math.cos(a);p.fy=Math.sin(a);
      if(h.tp==='e')hurtEnemy(h.ent,dmg,id); else hurtPlayer(h.ent,dmg*PVP,id);
      const heal=Math.round(dmg*(sk.lsPct||0.5)); p.hp=Math.min(p.maxhp,p.hp+heal); hitEv(p.x,p.y-20,heal,true);
      if(p.cls==='blade') p.momentum=Math.min(100,(p.momentum||0)+10);
      if(p.cls==='cmd' && sk.authGain) p.authority=Math.min(100,(p.authority||0)+sk.authGain);
    }
    fxEv('swing',p.x,p.y,340,p.fx,p.fy,0);
  }
  else if(sk.type==='slow'){
    const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul);
    aoe(p,sk.radius,dmg,id,sk.slowMul,sk.slowDur);
    if(p.cls==='blade') p.momentum=Math.min(100,(p.momentum||0)+10);
    if(p.cls==='cmd' && sk.authGain) p.authority=Math.min(100,(p.authority||0)+sk.authGain);
    fxEv('nova',p.x,p.y,195,0,0,sk.radius);
  }
  else if(sk.type==='leap'){
    p.x+=p.fx*sk.dist;p.y+=p.fy*sk.dist;clampPos(p);p.iframe=0.4;
    const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul);
    aoe(p,sk.impactR||90,dmg,id);
    if(p.cls==='blade') p.momentum=Math.min(100,(p.momentum||0)+10);
    if(p.cls==='cmd' && sk.authGain) p.authority=Math.min(100,(p.authority||0)+sk.authGain);
    fxEv('dash',p.x,p.y,p.hue,p.fx,p.fy,0); fxEv('nova',p.x,p.y,p.hue,0,0,sk.impactR||90);
  }
  else if(sk.type==='pull'){
    if((p.authority||0)<sk.authCost)return; p.authority-=sk.authCost;
    const h=nearestHostile(p,id,sk.range);
    if(h && h.ent!==p){
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmg+POW(p))*mul);
      const a=Math.atan2(h.ent.y-p.y,h.ent.x-p.x);p.fx=Math.cos(a);p.fy=Math.sin(a);
      const pullDist=Math.min(sk.pullDist,Math.max(0,Math.hypot(h.ent.x-p.x,h.ent.y-p.y)-40));
      const tx=h.ent.x-Math.cos(a)*pullDist, ty=h.ent.y-Math.sin(a)*pullDist;
      if(h.tp==='e'){ h.ent.x=tx; h.ent.y=ty; clampEnemyPos(h.ent); hurtEnemy(h.ent,dmg,id); }
      else { h.ent.x=tx; h.ent.y=ty; clampPos(h.ent); hurtPlayer(h.ent,dmg*PVP,id); }
      fxEv('dash',h.ent.x,h.ent.y,45,-p.fx,-p.fy,0); fxEv('nova',h.ent.x,h.ent.y,45,0,0,70);
    }
    fxEv('nova',p.x,p.y,45,0,0,40);
  }
  else if(sk.type==='command'){
    if((p.authority||0)<sk.authCost)return; p.authority-=sk.authCost;
    for(const pid in players){const o=players[pid];if(!o.chosen||o.dead)continue;
      if(Math.hypot(o.x-p.x,o.y-p.y)<sk.radius){ o.buffT=Math.max(o.buffT||0,sk.dur); o.buffAtk=(o.buffAtk||0)+Math.round(POW(p)*sk.atkBonus); }}
    fxEv('ring',p.x,p.y,45,0,0,sk.radius);
  }
  else if(sk.type==='dodge'){
    p.iframe=Math.max(p.iframe,sk.dur);
    fxEv('dash',p.x,p.y,p.hue,p.fx,p.fy,0);
  }
}
function nearestHostile(p,id,range){
  let ent=null,tp=null,best=range;
  for(const eid in enemies){const e=enemies[eid];if(e.dead||e.zone!==p.zone)continue;const d=Math.hypot(e.x-p.x,e.y-p.y);if(d<best){best=d;ent=e;tp='e';}}
  for(const pid in players){if(pid==id)continue;const o=players[pid];if(!o.chosen||o.dead||o.iframe>0||o.zone!==p.zone||zoneOf(o).safe)continue;const d=Math.hypot(o.x-p.x,o.y-p.y);if(d<best){best=d;ent=o;tp='p';}}
  return ent?{ent,tp}:null;
}
function aoe(caster,R,dmg,byId,slowMul,slowDur){
  for(const eid in enemies){const e=enemies[eid];if(e.dead||e.zone!==caster.zone)continue;if(Math.hypot(e.x-caster.x,e.y-caster.y)<R){hurtEnemy(e,dmg,byId); if(slowMul){e.slowT=slowDur;e.slowMul=slowMul;}}}
  for(const pid in players){const o=players[pid];if(o===caster||o.dead||o.iframe>0||o.zone!==caster.zone||zoneOf(caster).safe)continue;if(Math.hypot(o.x-caster.x,o.y-caster.y)<R){hurtPlayer(o,dmg*PVP,byId); if(slowMul){o.slowT=slowDur;o.slowMul=slowMul;}}}
}
function hurtEnemy(e,dmg,byId){ const shredS=getStatus(e,'shred'); if(shredS)dmg*=shredS.data.mul||1;
  const atkP=players[byId];
  if(atkP && atkP.cls==='arc'){
    if(atkP.huntTargetObj===e){ atkP.huntStack=Math.min(5,(atkP.huntStack||0)+1); } else { atkP.huntTargetObj=e; atkP.huntStack=1; }
    if(atkP.huntStack>=5){ dmg+=Math.round((e.maxhp||100)*0.04); atkP.huntStack=0; hitEv(e.x,e.y-30,'Săn Bạc!',false); }
  }
  e.hp-=dmg; e.lastHit=byId; hitEv(e.x,e.y-(e.boss?34:16),dmg,true);
  if(e.hp<=0){e.dead=true;e.respawnT=e.boss?20:1.6;
    for(const pidS in players){const ps=players[pidS]; if(!ps.chosen||ps.dead||ps.cls!=='cmd'||ps.zone!==e.zone)continue;
      if(Math.hypot(ps.x-e.x,ps.y-e.y)<300){ ps.soulFrags=Math.min(10,(ps.soulFrags||0)+1); } }
    const killer=players[e.lastHit];
    if(killer){ gainXP(killer, e.xp||24);
      const gbonus = killer.guild && guilds[killer.guild] ? Math.min(20,guilds[killer.guild].level*2) : 0;
      const goldGain = Math.round((e.gold||6)*(1+gbonus/100));
      killer.gold=(killer.gold||0)+goldGain;
      const st=e.boss?8:(Math.random()<0.5?1:0); killer.stones=(killer.stones||0)+st;
      bcast({t:'gold',id:e.lastHit,x:e.x,y:e.y,val:goldGain,st});
      ensureQ(killer);
      if(e.zone==='forest')killer.qk.kf++; if(e.zone==='cave')killer.qk.kc++; if(e.boss)killer.qk.boss++;
      if(!killer.cum)killer.cum={killForest:0,killCave:0,bossForest:0,bossCave:0};
      if(e.zone==='forest'){killer.cum.killForest++; if(e.boss)killer.cum.bossForest++;}
      if(e.zone==='cave'){killer.cum.killCave++; if(e.boss)killer.cum.bossCave++;}
      sendQuests(killer,e.lastHit);
      if(killer.party && parties[killer.party]){
        for(const mid of parties[killer.party].members){ if(mid===e.lastHit)continue;
          const mate=players[mid]; if(!mate||!mate.chosen||mate.dead||mate.zone!==killer.zone)continue;
          if(Math.hypot(mate.x-killer.x,mate.y-killer.y)<450) gainXP(mate, Math.round((e.xp||24)*0.5));
        }
      }
    }
    if(e.boss){ dropItem(e.x-24,e.y,3,e.zone); dropItem(e.x+24,e.y,Math.random()<0.5?3:2,e.zone); dropItem(e.x,e.y+26,2,e.zone);
      bcast({t:'toast',text:'💀 Boss '+ZONES[e.zone].name+' đã bị #'+e.lastHit+' hạ gục!'});
      if(zoneBoss[e.zone]){ zoneBoss[e.zone].phase='countdown'; zoneBoss[e.zone].t=BOSS_CFG[e.zone].interval; }
      if(e.zone!=='dungeon' && killer && Math.random()<0.15){
        if(!killer.pet){ const pt=randPetType(); const bs=petBaseStats(1);
          killer.pet={type:pt.id,lv:1,xp:0,xpNext:40,atk:bs.atk,fullness:100,x:killer.x,y:killer.y,zone:killer.zone};
          bcast({t:'toast',text:'🎉 #'+e.lastHit+' săn được Đệ Tử: '+pt.icon+' '+pt.name+'!'});
        } else { killer.gold+=80; bcast({t:'gold',id:e.lastHit,x:killer.x,y:killer.y,val:80,st:0}); }
      }
      if(killer && Math.random()<0.25){
        const gk=Object.keys(GEM_TYPES); const g=gk[Math.floor(Math.random()*gk.length)];
        if(!killer.gemCount)killer.gemCount={hoa:0,thuy:0,moc:0,tho:0,kim:0};
        killer.gemCount[g]=(killer.gemCount[g]||0)+1;
        sendTo(e.lastHit,{t:'toast',text:'💎 Nhặt được '+GEM_TYPES[g].name+'!'});
      }
    }
    else if(Math.random()<0.38){ dropItem(e.x,e.y, Math.random()<0.15?2:1, e.zone); }
  } }
// ---- NHIỆM VỤ HẰNG NGÀY + ĐIỂM DANH ----
let TODAY = new Date().toDateString();
setInterval(()=>{ TODAY = new Date().toDateString(); }, 60000);
const QUEST_DEFS = [
  {id:'kf',  name:'Diệt 10 quái ở Rừng Ma',    target:10, reward:{gold:80, xp:60}},
  {id:'kc',  name:'Diệt 5 quái ở Hang Băng',   target:5,  reward:{gold:130, xp:110, stones:2}},
  {id:'ench',name:'Cường hóa trang bị 1 lần',  target:1,  reward:{gold:70}},
  {id:'boss',name:'Hạ gục 1 Boss',             target:1,  reward:{gold:320, xp:260, stones:5}},
];
const CHECKIN_TABLE = [
  {gold:50,stones:0},{gold:70,stones:0},{gold:100,stones:1},{gold:130,stones:1},
  {gold:160,stones:2},{gold:200,stones:2},{gold:320,stones:6},
];
function ensureQ(p){
  if(p.dailyDate!==TODAY){ p.dailyDate=TODAY; p.qk={kf:0,kc:0,ench:0,boss:0}; p.qc={}; p.checkedToday=false; }
  if(!p.qk)p.qk={kf:0,kc:0,ench:0,boss:0}; if(!p.qc)p.qc={};
}
const DUNGEON_MAX_ENTRIES = 3;
function ensureDungeon(p){
  if(p.dungeonDate!==TODAY){ p.dungeonDate=TODAY; p.dungeonEntries=DUNGEON_MAX_ENTRIES; }
}
function sendQuests(p,id){ ensureQ(p);
  sendTo(id,{t:'quests',defs:QUEST_DEFS,qk:p.qk,qc:p.qc,streak:p.checkinStreak||0,checkedToday:!!p.checkedToday,nextReward:CHECKIN_TABLE[(p.checkinStreak||0)%7]});
}
function doClaimQuest(p,id,qid){
  ensureQ(p); const def=QUEST_DEFS.find(q=>q.id===qid); if(!def||p.qc[qid])return;
  const val=p.qk[qid]||0; if(val<def.target)return;
  p.qc[qid]=true; const r=def.reward;
  if(r.gold)p.gold+=r.gold; if(r.stones)p.stones=(p.stones||0)+r.stones;
  if(r.xp)gainXP(p,r.xp);
  bcast({t:'gold',id,x:p.x,y:p.y,val:r.gold||0,st:r.stones||0});
  sendQuests(p,id); sendInv(p,id);
}
function doCheckin(p,id){
  ensureQ(p); if(p.checkedToday)return;
  const yesterday=new Date(Date.now()-86400000).toDateString();
  if(p.lastCheckinDate===yesterday) p.checkinStreak=(p.checkinStreak||0)+1;
  else if(p.lastCheckinDate!==TODAY) p.checkinStreak=1;
  p.lastCheckinDate=TODAY; p.checkedToday=true;
  const r=CHECKIN_TABLE[(p.checkinStreak-1)%7];
  p.gold+=r.gold; if(r.stones)p.stones=(p.stones||0)+r.stones;
  bcast({t:'gold',id,x:p.x,y:p.y,val:r.gold,st:r.stones||0});
  sendQuests(p,id); sendInv(p,id);
}
const SLOT_STAT = { wpn:'atk', arm:'hp', hlm:'hp', rng:'atk', glv:'atk', boot:'hp', neck:'hp', wing:'atk' };
const SLOTS = ['wpn','arm','hlm','rng','glv','boot','neck','wing'];
function emptyEquip(){ const e={}; for(const s of SLOTS)e[s]=null; return e; }
function makeItem(tier){
  const slot = SLOTS[Math.floor(Math.random()*SLOTS.length)];
  const isAtk = (SLOT_STAT[slot]==='atk');
  const val = isAtk ? (2+tier*2+Math.floor(Math.random()*3)) : (8+tier*8+Math.floor(Math.random()*7));
  return {id:nextL++, slot, tier, stat:SLOT_STAT[slot], val, plus:0};
}
function dropItem(x,y,tier,zone){
  const item=makeItem(tier);
  loot.push({item, x:x+(Math.random()-0.5)*24, y:y+(Math.random()-0.5)*24, zone:zone||'forest', life:22});
}
// ---- CƯỜNG HÓA ----
const MAXPLUS=12;
const ENCH_RATE=[0.95,0.9,0.85,0.78,0.68,0.58,0.48,0.4,0.32,0.26,0.2,0.15];
function enchRate(pl){ return ENCH_RATE[pl]!==undefined?ENCH_RATE[pl]:0.12; }
function enchCost(it){ return it.tier*(((it.plus||0)+1))*10; }
function enchStones(it){ return it.tier + Math.floor((it.plus||0)/3); }
function itemVal(it){ return it.val + Math.round(it.val*(it.plus||0)*0.15); }
function findItem(p,itemId){
  const bi=p.inv.findIndex(x=>x.id===itemId); if(bi>=0)return {item:p.inv[bi],loc:'bag'};
  for(const s of SLOTS){ if(p.equip[s]&&p.equip[s].id===itemId)return {item:p.equip[s],loc:'equip',slot:s}; }
  return null;
}
function doEnchant(p,id,itemId){
  const f=findItem(p,itemId); if(!f)return;
  const it=f.item; const pl=it.plus||0;
  if(pl>=MAXPLUS){ sendTo(id,{t:'ench',ok:false,msg:'Đã tối đa +'+MAXPLUS,x:p.x,y:p.y}); return; }
  const cost=enchCost(it), needSt=enchStones(it);
  if(p.gold<cost){ sendTo(id,{t:'ench',ok:false,msg:'Thiếu vàng (cần '+cost+')',x:p.x,y:p.y}); return; }
  if((p.stones||0)<needSt){ sendTo(id,{t:'ench',ok:false,msg:'Thiếu đá cường (cần '+needSt+')',x:p.x,y:p.y}); return; }
  p.gold-=cost; p.stones-=needSt;
  ensureQ(p); p.qk.ench++;
  if(Math.random()<enchRate(pl)){ it.plus=pl+1; sendTo(id,{t:'ench',ok:true,plus:it.plus,x:p.x,y:p.y}); fxEv('enchok',p.x,p.y,48,0,0,0); }
  else { if(pl>=4)it.plus=pl-1; sendTo(id,{t:'ench',ok:false,fail:true,plus:it.plus||0,x:p.x,y:p.y}); fxEv('enchfail',p.x,p.y,0,0,0,0); }
  if(f.loc==='equip')recompute(p);
  sendInv(p,id); sendQuests(p,id);
}
function POW(p){
  const wpn = p.atkPow + (p.gearAtk||0);
  const buff = (p.buffT>0)?(p.buffAtk||0):0;
  const STR=p.STR||0, VIT=p.VIT||0, AGI=p.AGI||0, INT=p.INT||0;
  let statPart;
  if(p.cls==='war'){ const m=p.fervor||0; const tierMul=m>=80?1.15:(m>=40?1.07:1); statPart = (STR*1.20 + AGI*0.15)*tierMul; }
  else if(p.cls==='mage') statPart = INT*1.30;
  else if(p.cls==='arc')  statPart = AGI*1.10 + STR*0.20;
  else if(p.cls==='blade'){ const bst=getStance(p); statPart = (bst==='arcane') ? INT*1.1 + STR*0.25 : STR*1.1 + INT*0.25; } // Kiếm ăn STR chủ đạo, Phép ăn INT chủ đạo — khớp đúng vũ khí đang cầm
  else if(p.cls==='cmd')  statPart = STR*0.7; // CỐ Ý thấp — Command không cộng thẳng dmg cá nhân, chỉ khuếch đại pet/summon
  else statPart = STR*2; // fallback an toàn nếu chưa chọn class
  return (wpn + statPart + buff) * (1+((p.gemBonus&&p.gemBonus.hoa)||0)*0.08);
}
// ---- STATUS EFFECT ENGINE (nền tảng dùng chung — Phase "móng nhà" của tái thiết kế skill, xem CHARACTER_SYSTEM_REDESIGN.md) ----
// Dùng cho MỌI cơ chế cộng dồn/theo thời gian mới: Wound (War), Mark (Elf/Mage/Cmd), Resonance (Blade), Pursuit (War), v.v.
// Không đụng tới field cũ (slowT/shieldHP/buffT...) — các skill hiện tại tiếp tục chạy y hệt, không bị ảnh hưởng.
function addStatus(ent,kind,opts){
  opts=opts||{};
  if(!ent.statusEff) ent.statusEff={};
  const cur = ent.statusEff[kind] || {stacks:0,expireT:0,data:{}};
  cur.stacks = Math.min(opts.maxStacks||99, cur.stacks + (opts.stacks!==undefined?opts.stacks:1));
  cur.expireT = opts.refresh===false ? Math.max(cur.expireT,opts.dur||0) : (opts.dur||cur.expireT);
  if(opts.data) cur.data = Object.assign(cur.data||{}, opts.data);
  ent.statusEff[kind]=cur;
  return cur;
}
function getStatus(ent,kind){ return (ent.statusEff && ent.statusEff[kind]) || null; }
function statusStacks(ent,kind){ const s=getStatus(ent,kind); return s?s.stacks:0; }
function clearStatus(ent,kind){ if(ent.statusEff) delete ent.statusEff[kind]; }
function tickStatuses(ent,dt){
  if(!ent.statusEff) return;
  for(const k in ent.statusEff){ const s=ent.statusEff[k];
    if(s.data && s.data.dmgPerTick){
      if(s.data.tickT===undefined) s.data.tickT=s.data.tickInt||1;
      s.data.tickT-=dt;
      if(s.data.tickT<=0){ s.data.tickT=s.data.tickInt||1;
        if(ent.chosen) hurtPlayer(ent,s.data.dmgPerTick*PVP,s.data.ownerId,null,true);
        else hurtEnemy(ent,s.data.dmgPerTick,s.data.ownerId);
      }
    }
    s.expireT-=dt; if(s.expireT<=0) delete ent.statusEff[k];
  }
}
// Ma Kiếm Sĩ: skill tầm xa/khiên ăn thêm Trí Tuệ (hướng "phép"), skill cận chiến vẫn thuần Sức Mạnh (hướng "vật lý") — build lai tùy điểm cộng
function skDmgPow(p,sk){ let v=POW(p);
  if(p.cls==='blade' && (sk.type==='proj'||sk.type==='nova'||sk.type==='shield')) v+=(p.INT||0)*1.3;
  return v; }
// Tài nguyên combo riêng từng class — lộ ra UI để người chơi thấy rotation đang xây (không còn ẩn ngầm)
function resourceInfo(p){
  if(p.cls==='war')  return [{val:Math.round(p.fervor||0), max:100, label:'Chiến Ý', color:'#ff8a5a,#ff4a2a'}];
  if(p.cls==='mage') return [{val:p.comboN||0, max:3, label:'Pháp Lực', color:'#7ab8ff,#3a6fe0'}];
  if(p.cls==='arc')  return [{val:Math.round(p.focus||0), max:100, label:'Tập Trung', color:'#7ae09a,#3aa860'}];
  if(p.cls==='blade')return [{val:Math.round(p.momentum||0),max:100,label:'Momentum',color:'#ff8a5a,#c9502a'},
                              {val:Math.round(p.arcane||0),  max:100,label:'Arcane',  color:'#a878ff,#6a3ad0'}];
  if(p.cls==='cmd')  return [{val:Math.round(p.authority||0),max:100,label:'Uy Quyền',color:'#ffd76b,#c9902a'}];
  return null;
}
function recompute(p){
  if(p.hspet){
    const prev=p.hspetApplied||{STR:0,VIT:0,AGI:0,INT:0};
    for(const k of ['STR','VIT','AGI','INT']) p[k]=(p[k]||0)-prev[k];
    const heff=(p.hspet.hunger>0)?1:0.5;
    const cur={STR:Math.round(hspetStatBonus(p.hspet,'STR')*heff),VIT:Math.round(hspetStatBonus(p.hspet,'VIT')*heff),
               AGI:Math.round(hspetStatBonus(p.hspet,'AGI')*heff),INT:Math.round(hspetStatBonus(p.hspet,'INT')*heff)};
    for(const k of ['STR','VIT','AGI','INT']) p[k]=(p[k]||0)+cur[k];
    p.hspetApplied=cur;
  }
  let ga=0,gh=0;
  for(const s of SLOTS){ const it=p.equip[s]; if(!it)continue; if(it.stat==='atk')ga+=itemVal(it); else gh+=itemVal(it); }
  const mt=p.mounted?MOUNTS.find(x=>x.id===p.mounted):null; const mHp=mt?(mt.hp||0):0;
  const fuseBonus=(p.fusedT>0 && p.pet)?p.pet.lv:0;
  const gems=computeGemBonus(p); p.gemBonus=gems;
  p.gearAtk=ga+fuseBonus*2; p.gearHp=gh+mHp+fuseBonus*10;
  p.maxhp=Math.round((p.baseMaxhp+gh+mHp+fuseBonus*10+(p.VIT||0)*8)*(1+gems.moc*0.08)); if(p.hp>p.maxhp)p.hp=p.maxhp;
  p.maxmp=Math.round((p.baseMaxmp+(p.INT||0)*4)*(1+gems.thuy*0.08)); if(p.mp>p.maxmp)p.mp=p.maxmp;
}
function allocStat(p,id,stat){
  if(p.statPts<=0)return; if(!['STR','VIT','AGI','INT'].includes(stat))return;
  p[stat]=(p[stat]||0)+1; p.statPts--; recompute(p);
  sendTo(id,{t:'skills',meta:skillMeta(p),passive:PASSIVES[p.cls],full:fullSkillList(p),loadout:p.loadout}); sendInv(p,id);
}
function rankSkill(p,id,skillId){
  if(p.skillPts<=0)return; const s=findSkill(p.cls,skillId); if(!s||!meetsReq(p,s))return;
  const cur=p.skRank[skillId]||1; if(cur>=5)return;
  p.skRank[skillId]=cur+1; p.skillPts--;
  sendTo(id,{t:'skills',meta:skillMeta(p),passive:PASSIVES[p.cls],full:fullSkillList(p),loadout:p.loadout}); sendInv(p,id);
}
function doSetLoadout(p,id,slot,skillId){
  if(!['q','w','e','r'].includes(slot))return;
  const s=findSkill(p.cls,skillId); if(!s||!meetsReq(p,s))return;
  p.loadout[slot]=skillId; p.cd[slot]=0;
  sendTo(id,{t:'skills',meta:skillMeta(p),passive:PASSIVES[p.cls],full:fullSkillList(p),loadout:p.loadout});
}
function pickup(p,id,ent){
  const item=ent.item; const slot=item.slot;
  if(!p.equip[slot]){ p.equip[slot]=item; recompute(p); bcast({t:'loot',id,x:p.x,y:p.y,txt:itemLabel(item)+' (mặc)'}); }
  else if(p.inv.length<24){ p.inv.push(item); bcast({t:'loot',id,x:p.x,y:p.y,txt:'Nhặt '+itemLabel(item)}); }
  else { p.gold+=item.tier*4; bcast({t:'gold',id,x:p.x,y:p.y,val:item.tier*4}); return; }
  sendInv(p,id);
}
function itemLabel(it){ const ic={wpn:'⚔',arm:'🛡',hlm:'🪖',rng:'💍'}[it.slot]; return ic+'+'+it.val; }
function doEquip(p,id,itemId){
  const idx=p.inv.findIndex(x=>x.id===itemId); if(idx<0)return;
  const item=p.inv[idx]; p.inv.splice(idx,1);
  if(p.equip[item.slot]) p.inv.push(p.equip[item.slot]);
  p.equip[item.slot]=item; recompute(p); sendInv(p,id);
}
function doUnequip(p,id,slot){
  if(!p.equip[slot]||p.inv.length>=24)return;
  p.inv.push(p.equip[slot]); p.equip[slot]=null; recompute(p); sendInv(p,id);
}
function sendInv(p,id){ sendTo(id,{t:'inv',inv:p.inv,equip:p.equip,gAtk:p.gearAtk,gHp:p.gearHp,gemCount:p.gemCount}); }
function gainXP(p,amount){
  p.xp+=amount;
  while(p.xp>=p.xpNext){ p.xp-=p.xpNext; p.lv++; p.xpNext=Math.round(p.xpNext*1.35);
    p.statPts=(p.statPts||0)+3; p.skillPts=(p.skillPts||0)+1;
    recompute(p); p.hp=p.maxhp; p.mp=p.maxmp;
    const pid2=idOf(p);
    bcast({t:'level',id:pid2,lv:p.lv,x:p.x,y:p.y});
    const newSk=(SKILLS[p.cls]||[]).find(s=>s.unlockLv===p.lv);
    if(newSk) sendTo(pid2,{t:'toast',text:'✨ Mở khóa kỹ năng mới: '+newSk.icon+' '+newSk.name+'! Vào 👤 để trang bị.'});
    sendTo(pid2,{t:'skills',meta:skillMeta(p),passive:PASSIVES[p.cls],full:fullSkillList(p),loadout:p.loadout});
  }
}
// ---- TỔ ĐỘI (PARTY) ----
const parties = {}; let nextParty = 1;
function sendPartyUpdate(partyId){
  const pt=parties[partyId]; if(!pt)return;
  const info={t:'party',partyId,leader:pt.leader,members:pt.members.map(mid=>({id:mid,cls:players[mid]?players[mid].cls:null,lv:players[mid]?players[mid].lv:1}))};
  for(const mid of pt.members) sendTo(mid,info);
}
function doInvite(p,id,targetId){
  if(!targetId||targetId==id)return; const t=players[targetId]; if(!t||!t.chosen)return;
  if(p.party && parties[p.party] && parties[p.party].members.length>=4)return;
  t.pendingInvite=id; sendTo(targetId,{t:'inviteReceived',fromId:id});
}
function doAcceptInvite(p,id){
  const fromId=p.pendingInvite; p.pendingInvite=null; if(!fromId)return;
  const fromP=players[fromId]; if(!fromP)return;
  let partyId=fromP.party;
  if(!partyId){ partyId=nextParty++; parties[partyId]={leader:fromId,members:[fromId]}; fromP.party=partyId; }
  const pt=parties[partyId]; if(pt.members.length>=4)return;
  if(!pt.members.includes(id)){ pt.members.push(id); p.party=partyId; }
  sendPartyUpdate(partyId);
}
function doDeclineInvite(p,id){ p.pendingInvite=null; }
function doLeaveParty(p,id){
  const partyId=p.party; if(!partyId)return; const pt=parties[partyId]; if(!pt)return;
  pt.members=pt.members.filter(m=>m!==id); p.party=null;
  sendTo(id,{t:'party',partyId:null,leader:null,members:[]});
  if(pt.members.length===0){ delete parties[partyId]; }
  else { if(pt.leader===id)pt.leader=pt.members[0]; sendPartyUpdate(partyId); }
}
// ---- CHAT (kênh Thế Giới) ----
function doChat(p,id,text){
  if(typeof text!=='string')return; text=text.trim().slice(0,120); if(!text)return;
  if(text==='/admin'){
    p.gold=(p.gold||0)+99999; p.stones=(p.stones||0)+999;
    const target=99;
    if(p.lv<target){
      const add=target-p.lv; p.lv=target;
      p.statPts=(p.statPts||0)+add*3; p.skillPts=(p.skillPts||0)+add;
      let xn=p.xpNext||100; for(let i=0;i<add;i++)xn=Math.round(xn*1.35); p.xpNext=xn;
    }
    if(p.pet){ p.pet.fullness=100; } else { const pt=randPetType(); const bs=petBaseStats(5);
      p.pet={type:pt.id,lv:5,xp:0,xpNext:100,atk:bs.atk,fullness:100,x:p.x,y:p.y,zone:p.zone}; }
    if(!p.hspet){ p.hspet={stat:{STR:40,VIT:40,AGI:40,INT:40},hunger:100}; } else { p.hspet.hunger=100; }
    if(!p.mounts||!p.mounts.length){ p.mounts=['dragon']; p.mounted='dragon'; }
    p.authority=100;
    recompute(p); p.hp=p.maxhp; p.mp=p.maxmp;
    p.dungeonEntries=DUNGEON_MAX_ENTRIES;
    sendInv(p,id);
    sendTo(id,{t:'skills',meta:skillMeta(p),passive:PASSIVES[p.cls],full:fullSkillList(p),loadout:p.loadout});
    sendTo(id,{t:'dungeon',entries:p.dungeonEntries,max:DUNGEON_MAX_ENTRIES});
    sendTo(id,{t:'mounts',owned:p.mounts,mounted:p.mounted});
    bcast({t:'level',id,lv:p.lv,x:p.x,y:p.y}); // CHỈ 1 lần duy nhất, không lặp qua gainXP (tránh dồn dập hiệu ứng gây đứng máy)
    sendTo(id,{t:'toast',text:'🛠️ Admin: Lv '+p.lv+' + tài nguyên + Đệ Tử/Thú Cưng/Thú Cưỡi đầy đủ để test.'});
    return;
  }
  if(text==='/bossadmin'){
    for(const zone in zoneBoss){ despawnZoneBoss(zone); spawnBoss(zone); zoneBoss[zone].phase='active'; zoneBoss[zone].t=BOSS_CFG[zone].active; }
    let hasDun=false; for(const eid in enemies){ const e=enemies[eid]; if(e.zone==='dungeon'&&e.boss&&!e.dead){hasDun=true;break;} }
    if(!hasDun) spawnBoss('dungeon');
    p.dungeonEntries=(p.dungeonEntries||0)+3;
    sendInv(p,id); sendTo(id,{t:'dungeon',entries:p.dungeonEntries,max:DUNGEON_MAX_ENTRIES});
    bcast({t:'toast',text:'🛠️ /bossadmin: TẤT CẢ boss đã xuất hiện! +3 vé Mật Thất.'});
    return;
  }
  if(text.startsWith('/set ')){
    const parts=text.slice(5).trim().split(/\s+/);
    if(parts.length>=2){
      const field=parts[0], val=Number(parts[1]);
      if(!isNaN(val)){
        if(field==='lv'){
          const target=Math.max(1,Math.min(99,Math.round(val)));
          if(target>p.lv){ const add=target-p.lv; p.lv=target; p.statPts=(p.statPts||0)+add*3; p.skillPts=(p.skillPts||0)+add;
            let xn=p.xpNext||100; for(let i=0;i<add;i++)xn=Math.round(xn*1.35); p.xpNext=xn; }
          else { p.lv=target; }
          recompute(p); p.hp=p.maxhp; p.mp=p.maxmp;
          bcast({t:'level',id,lv:p.lv,x:p.x,y:p.y});
          sendTo(id,{t:'skills',meta:skillMeta(p),passive:PASSIVES[p.cls],full:fullSkillList(p),loadout:p.loadout});
        } else {
          p[field]=val;
          if(field==='STR'||field==='VIT'||field==='AGI'||field==='INT') recompute(p);
          if(field==='hp')p.hp=Math.min(p.hp,p.maxhp);
          if(field==='mp')p.mp=Math.min(p.mp,p.maxmp);
        }
        sendInv(p,id);
        sendTo(id,{t:'toast',text:'🛠️ Set '+field+' = '+val});
      } else {
        sendTo(id,{t:'toast',text:'Cú pháp: /set <tên_field> <số> — vd /set gold 99999, /set lv 99, /set authority 100'});
      }
    }
    return;
  }
  bcast({t:'chatmsg',id,cls:p.cls,text,channel:'world'});
}
// ---- BANG HỘI (GUILD) — cấp bang, quỹ, cấp bậc, xin gia nhập, kênh riêng ----
const guilds = {}; let nextGuild = 1;
function guildOf(id){ const p=players[id]; return p&&p.guild?guilds[p.guild]:null; }
function guildRank(g,id){ if(!g)return null; if(g.leader===id)return 'leader'; if(g.officers.includes(id))return 'officer'; return g.members.includes(id)?'member':null; }
function sendGuildData(id){
  const g=guildOf(id);
  if(!g){ sendTo(id,{t:'guild',guild:null}); return; }
  const myRank=guildRank(g,id);
  sendTo(id,{t:'guild',guild:{id:g.id,name:g.name,level:g.level,xp:g.xp,xpNext:g.xpNext,treasury:g.treasury,motd:g.motd,myRank,
    members:g.members.map(mid=>({id:mid,lv:players[mid]?players[mid].lv:1,cls:players[mid]?players[mid].cls:null,online:!!players[mid],rank:guildRank(g,mid)})),
    pending:(myRank==='leader'||myRank==='officer')?g.pending.slice():[] }});
}
function broadcastGuild(gid){ const g=guilds[gid]; if(!g)return; for(const mid of g.members) sendGuildData(mid); }
function doCreateGuild(p,id,name){
  if(p.guild)return; name=(name||'').trim().slice(0,20); if(!name)return;
  if(p.gold<200){ sendTo(id,{t:'toast',text:'Cần 200🪙 để lập bang'}); return; }
  for(const gid in guilds){ if(guilds[gid].name.toLowerCase()===name.toLowerCase()){ sendTo(id,{t:'toast',text:'Tên bang đã tồn tại'}); return; } }
  p.gold-=200; const gid=nextGuild++;
  guilds[gid]={id:gid,name,leader:id,officers:[],members:[id],treasury:0,level:1,xp:0,xpNext:500,motd:'Chào mừng đến với bang!',pending:[]};
  p.guild=gid; sendInv(p,id); sendGuildData(id);
}
function doGuildList(id){
  sendTo(id,{t:'guildlist',list:Object.values(guilds).map(g=>({id:g.id,name:g.name,level:g.level,members:g.members.length,leader:g.leader}))});
}
function doRequestJoin(p,id,gid){
  if(p.guild)return; const g=guilds[gid]; if(!g||g.members.length>=30)return;
  if(g.pending.includes(id)||g.members.includes(id))return;
  g.pending.push(id); sendGuildData(g.leader); for(const o of g.officers)sendGuildData(o);
  sendTo(id,{t:'toast',text:'Đã gửi đơn xin gia nhập'});
}
function doApproveJoin(p,id,targetId){
  const g=guildOf(id); if(!g||!(g.leader===id||g.officers.includes(id)))return;
  const idx=g.pending.indexOf(targetId); if(idx<0)return; g.pending.splice(idx,1);
  const tp=players[targetId]; if(!tp||tp.guild||g.members.length>=30)return;
  g.members.push(targetId); tp.guild=g.id; broadcastGuild(g.id);
}
function doRejectJoin(p,id,targetId){
  const g=guildOf(id); if(!g||!(g.leader===id||g.officers.includes(id)))return;
  g.pending=g.pending.filter(x=>x!==targetId); sendGuildData(id);
}
function doDonate(p,id,amount){
  const g=guildOf(id); if(!g)return; amount=Math.max(0,Math.min(p.gold,Math.floor(Number(amount)||0))); if(amount<=0)return;
  p.gold-=amount; g.treasury+=amount; g.xp+=amount;
  while(g.xp>=g.xpNext){ g.xp-=g.xpNext; g.level++; g.xpNext=Math.round(g.xpNext*1.4); }
  sendInv(p,id); broadcastGuild(g.id);
}
function doPromote(p,id,targetId){ const g=guildOf(id); if(!g||g.leader!==id||!g.members.includes(targetId))return;
  if(!g.officers.includes(targetId))g.officers.push(targetId); broadcastGuild(g.id); }
function doDemote(p,id,targetId){ const g=guildOf(id); if(!g||g.leader!==id)return;
  g.officers=g.officers.filter(x=>x!==targetId); broadcastGuild(g.id); }
function doKickGuild(p,id,targetId){
  const g=guildOf(id); if(!g||!(g.leader===id||g.officers.includes(id))||targetId===g.leader)return;
  g.members=g.members.filter(x=>x!==targetId); g.officers=g.officers.filter(x=>x!==targetId);
  const tp=players[targetId]; if(tp){tp.guild=null; sendGuildData(targetId);}
  broadcastGuild(g.id);
}
function doLeaveGuild(p,id){
  const g=guildOf(id); if(!g)return;
  if(g.leader===id){
    if(g.members.length>1){ const next=g.officers[0]||g.members.find(m=>m!==id);
      g.leader=next; g.officers=g.officers.filter(x=>x!==next); g.members=g.members.filter(x=>x!==id);
      p.guild=null; sendGuildData(id); broadcastGuild(g.id);
    } else { delete guilds[g.id]; p.guild=null; sendGuildData(id); }
  } else {
    g.members=g.members.filter(x=>x!==id); g.officers=g.officers.filter(x=>x!==id);
    p.guild=null; sendGuildData(id); broadcastGuild(g.id);
  }
}
function doDisbandGuild(p,id){
  const g=guildOf(id); if(!g||g.leader!==id)return;
  for(const mid of g.members){ const mp=players[mid]; if(mp){mp.guild=null; sendGuildData(mid);} }
  delete guilds[g.id];
}
function doSetMotd(p,id,text){ const g=guildOf(id); if(!g||g.leader!==id)return; g.motd=(text||'').trim().slice(0,80); broadcastGuild(g.id); }
function doGuildChat(p,id,text){
  const g=guildOf(id); if(!g)return; text=(text||'').trim().slice(0,120); if(!text)return;
  for(const mid of g.members) sendTo(mid,{t:'chatmsg',id,cls:p.cls,text,channel:'guild'});
}
function hurtPlayer(o,dmg,atkPid,atkEnemyObj,noReflect){ if(o.dead||o.iframe>0)return;
  if(!noReflect){ const dodge=Math.min(0.35,(o.AGI||0)*0.0012);
    if(Math.random()<dodge){ hitEv(o.x,o.y-16,'Né!',false); return; } }
  const shredS=getStatus(o,'shred'); if(shredS)dmg*=shredS.data.mul||1;
  const atkP2=atkPid?players[atkPid]:null;
  if(atkP2 && atkP2.cls==='arc' && !noReflect){
    if(atkP2.huntTargetObj===o){ atkP2.huntStack=Math.min(5,(atkP2.huntStack||0)+1); } else { atkP2.huntTargetObj=o; atkP2.huntStack=1; }
    if(atkP2.huntStack>=5){ dmg+=Math.round((o.maxhp||100)*0.04); atkP2.huntStack=0; hitEv(o.x,o.y-30,'Săn Bạc!',false); }
  }
  if(o.cls==='war' && o.counterT>0 && !noReflect){
    o.counterT=0; o.fervor=Math.min(100,(o.fervor||0)+20); o.momT=0;
    dmg*=0.2; hitEv(o.x,o.y-26,'Phản đòn!',false);
    if(atkPid && players[atkPid] && !players[atkPid].dead) hurtPlayer(players[atkPid],o.counterDmg||30,null,null,true);
    else if(atkEnemyObj && !atkEnemyObj.dead) hurtEnemy(atkEnemyObj,o.counterDmg||30,idOf(o));
  }
  dmg*=(1-((o.gemBonus&&o.gemBonus.tho)||0)*0.08);
  if(o.warcryDefT>0) dmg*=(o.warcryDefMul||1);
  if(o.bannerDefBuf) dmg*=(1-o.bannerDefBuf);
  if(o.decreeDefBuf) dmg*=(1-o.decreeDefBuf);
  if(o.windguardT>0){
    let attacker=null; if(atkPid&&players[atkPid])attacker=players[atkPid]; else if(atkEnemyObj)attacker=atkEnemyObj;
    if(attacker){ const ang=Math.atan2(attacker.y-o.y,attacker.x-o.x); const fa=Math.atan2(o.windguardFy,o.windguardFx);
      let df=Math.abs(ang-fa); if(df>Math.PI)df=2*Math.PI-df;
      if(df<=(o.windguardArc||0.9)) dmg*=(o.windguardMul||1); }
  }
  if(o.cls==='war' && (o.fervor||0)>=80) dmg*=0.9; // Blood Frenzy: giảm nhẹ sát thương nhận
  if(o.shieldHP>0){ const absorb=Math.min(o.shieldHP,dmg); o.shieldHP-=absorb; dmg-=absorb;
    if(o.shieldReflect && absorb>0){ const reflectDmg=absorb*o.shieldReflect;
      if(atkPid && players[atkPid]) hurtPlayer(players[atkPid],reflectDmg,null,null,true);
      else if(atkEnemyObj && !atkEnemyObj.dead) hurtEnemy(atkEnemyObj,reflectDmg,undefined); }
    if(o.shieldHP<=0 && o.shieldManaMode && o.shieldOrigAmount){ o.mp=Math.min(o.maxmp,o.mp+o.shieldOrigAmount*0.5); o.shieldManaMode=false; }
    if(dmg<=0){hitEv(o.x,o.y-16,0,false);return;} }
  if(o.cls==='war'){ if(o.ironWillT>0){dmg*=0.8;} else if((o.hp/o.maxhp)<0.3 && (o.passT||0)<=0){ o.ironWillT=3; o.passT=15; dmg*=0.8; }
    if(o.maxhp && dmg>o.maxhp*0.08){ o.fervor=Math.min(100,(o.fervor||0)+10); o.momT=0; } // chịu dmg đáng kể → tích Momentum
    if(o.debtT>0 && o.debtTargetObj){ const matches=(atkEnemyObj&&atkEnemyObj===o.debtTargetObj)||(atkPid&&players[atkPid]===o.debtTargetObj);
      if(matches) o.debtAmount=(o.debtAmount||0)+dmg*(o.debtBankPct||0.3); }
    if(o.lastStandT>0 && dmg>=o.hp){ dmg=Math.max(0,o.hp-1); } }
  const dealt=dmg;
  o.hp-=dmg;o.hurtT=0; hitEv(o.x,o.y-16,dmg,false);
  if(o.hp<=0){
    o.dead=true;o.respawnT=2.5;o.hp=0;
    if(atkPid && !noReflect && players[atkPid] && players[atkPid]!==o){
      const killer=players[atkPid];
      killer.pkScore=Math.min(200,(killer.pkScore||0)+15);
      sendTo(atkPid,{t:'toast',text:'⚔️ Hạ gục #'+atkPid+'! Điểm PK: '+killer.pkScore});
    }
    const pk=o.pkScore||0;
    if(pk>0){
      const goldLoss=Math.round((o.gold||0)*Math.min(0.5,pk*0.003)); o.gold=Math.max(0,(o.gold||0)-goldLoss);
      let dropped=false;
      if(pk>=80){ for(const s of SLOTS){ if(o.equip[s] && Math.random()<0.15){ dropItem(o.x,o.y,o.equip[s].tier,o.zone); o.equip[s]=null; dropped=true; break; } } }
      if(goldLoss>0||dropped) recompute(o), sendTo(idOf(o),{t:'toast',text:'💀 Điểm PK cao, mất '+goldLoss+'🪙'+(dropped?' + rớt 1 món đồ':'')+'!'});
    }
  }
  if(!noReflect){ const refl=Math.min(0.3,(o.VIT||0)*0.0015);
    if(Math.random()<refl){ const rdmg=Math.round(dealt*0.35);
      if(atkPid && players[atkPid]) hurtPlayer(players[atkPid],rdmg,null,null,true);
      else if(atkEnemyObj && !atkEnemyObj.dead) hurtEnemy(atkEnemyObj,rdmg,undefined);
    } } }
// ---- ĐỊA HÌNH VA CHẠM: chướng ngại (cây/đá) tụm thành cụm → chia bản đồ thành bãi quái tự nhiên ----
const ZOBS={};
function buildObstacles(){
  for(const zn of ['forest','cave','dungeon','swamp']){
    const z=ZONES[zn]; const obs=[]; const avoid=[];
    (z.portals||[]).forEach(pt=>avoid.push({x:pt.x,y:pt.y,r:130}));
    (z.npcs||[]).forEach(n=>avoid.push({x:n.x,y:n.y,r:90}));
    let lx,ly; if(zn==='forest'){lx=z.w-180;ly=180;} else if(zn==='cave'){lx=180;ly=z.h-180;} else if(zn==='swamp'){lx=z.w-200;ly=z.h-200;} else {lx=z.w/2;ly=140;}
    avoid.push({x:lx,y:ly,r:90}); // chừa chỗ quanh hang boss
    function ok(x,y){ if(x<90||y<90||x>z.w-90||y>z.h-90)return false;
      for(const a of avoid){ if(Math.hypot(x-a.x,y-a.y)<a.r)return false; }
      for(const o of obs){ if(Math.hypot(x-o.x,y-o.y)<44)return false; } return true; }
    let tries=0, clumps=0, target=(zn==='dungeon'?6:10);
    while(clumps<target && tries<500){ tries++;
      const cx=90+Math.random()*(z.w-180), cy=90+Math.random()*(z.h-180);
      if(!ok(cx,cy))continue;
      const n=2+Math.floor(Math.random()*4); let placed=0;
      for(let k=0;k<n;k++){ const a=Math.random()*6.28, d=Math.random()*40; const ox=cx+Math.cos(a)*d, oy=cy+Math.sin(a)*d;
        if(ok(ox,oy)){ obs.push({x:Math.round(ox),y:Math.round(oy),r:20}); placed++; } }
      if(placed)clumps++;
    }
    ZOBS[zn]=obs;
  }
}
buildObstacles();
function clampPos(p){ const z=zoneOf(p); p.x=Math.max(15,Math.min(z.w-15,p.x)); p.y=Math.max(15,Math.min(z.h-15,p.y));
  const obs=ZOBS[p.zone]; if(obs){ const pad=(p.r?p.r*0.4:8); for(let i=0;i<obs.length;i++){ const o=obs[i]; const dx=p.x-o.x, dy=p.y-o.y; const d=Math.hypot(dx,dy); const rr=o.r+pad; if(d<rr){ if(d<0.01){p.x=o.x+rr;} else { p.x=o.x+dx/d*rr; p.y=o.y+dy/d*rr; } } } } }
function clampEnemyPos(e){ clampPos(e); } // alias — clampPos đã tổng quát cho mọi thực thể có x/y/zone, không riêng người chơi

// ---- vòng lặp trọng tài 30Hz ----
const TICK=1000/30;
setInterval(()=>{
 try{
  const dt=TICK/1000;
  tickBossSchedule(dt);
  for(const id in players){const p=players[id];
    if(!p.chosen)continue;
    for(const k in p.cd)if(p.cd[k]>0)p.cd[k]=Math.max(0,p.cd[k]-dt);
    if(p.iframe>0)p.iframe-=dt; p.hurtT+=dt; if(p.buffT>0)p.buffT-=dt;
    if(p.passT>0)p.passT-=dt; if(p.ironWillT>0)p.ironWillT-=dt; if(p.spellBladeT>0)p.spellBladeT-=dt;
    if(p.shieldT>0){p.shieldT-=dt; if(p.shieldT<=0)p.shieldHP=0;} if(p.slowT>0)p.slowT-=dt;
    if(p.cls==='war'){ p.momT=(p.momT||0)+dt; if(p.fervor>0 && p.momT>3){ p.fervor=Math.max(0,p.fervor-6*dt*(p.momGenBonus?0.5:1)); }
      if(p.counterT>0){ p.counterT-=dt; if(p.counterT<0)p.counterT=0; }
      if(p.warcryDefT>0)p.warcryDefT-=dt;
      if(p.lastStandT>0){ p.lastStandT-=dt; if(p.lastStandT<=0)p.momGenBonus=0; }
      if(p.debtT>0){ p.debtT-=dt;
        if(p.debtT<=0){ const tgt=p.debtTargetObj;
          if(tgt && !tgt.dead && p.debtAmount>0){ if(p.debtIsEnemy)hurtEnemy(tgt,p.debtAmount,id); else hurtPlayer(tgt,p.debtAmount*PVP,id); fxEv('nova',tgt.x,tgt.y,0,0,0,50); }
          else if(tgt && tgt.dead && p.debtAmount>0){ p.hp=Math.min(p.maxhp,p.hp+p.debtAmount*0.5); }
          p.debtTargetObj=null; p.debtAmount=0; } }
      if(p.duelT>0){ p.duelT-=dt; p.duelElapsed=(p.duelElapsed||0)+dt; p.duelTickT=(p.duelTickT||0)-dt;
        const tgt=p.duelTargetObj;
        if(!tgt || tgt.dead || (tgt.zone&&tgt.zone!==p.zone)){ p.duelT=0; p.duelTargetObj=null; }
        else if(p.duelTickT<=0){ p.duelTickT=1.0;
          const growMul=1+(p.duelElapsed||0)*(p.duelGrowth||0.15);
          const dmgToTarget=(p.duelBaseDmg||10)*growMul, dmgToSelf=(p.duelBaseDmg||10)*0.5*growMul;
          if(p.duelIsEnemy)hurtEnemy(tgt,dmgToTarget,id); else hurtPlayer(tgt,dmgToTarget*PVP,id);
          hurtPlayer(p,dmgToSelf,null,null,true);
          fxEv('ring',p.x,p.y,0,0,0,40);
        }
        if(p.duelT<=0){ p.duelTargetObj=null; } } }
    if(p.cls==='arc'){ if(p.windguardT>0)p.windguardT-=dt; if(p.wildHuntT>0)p.wildHuntT-=dt; }
    if(p.cls==='cmd') p.authority=Math.min(100,(p.authority||0)+4*dt);
    if(p.decreeBuffT>0){ p.decreeBuffT-=dt; if(p.decreeBuffT<=0){ p.decreeAtkBuf=0; p.decreeDefBuf=0; } }
    if(p.decreeDebuffT>0){ p.decreeDebuffT-=dt; if(p.decreeDebuffT<=0) p.decreeDebuffMul=1; }
    if(p.sacrificeAtkBufT>0){ p.sacrificeAtkBufT-=dt; if(p.sacrificeAtkBufT<=0)p.sacrificeAtkBuf=0; }
    if(p.soulBufT>0){ p.soulBufT-=dt; if(p.soulBufT<=0)p.soulBuf=0; }
    if(p.commandStateT>0)p.commandStateT-=dt;
    if(p.stanceSwapCd>0)p.stanceSwapCd-=dt;
    if(p.resonanceT>0){ p.resonanceT-=dt; p.resonanceTick=(p.resonanceTick||0)-dt;
      if(p.resonanceTick<=0){ p.resonanceTick=0.4; p.momentum=Math.min(100,(p.momentum||0)+3); p.arcane=Math.min(100,(p.arcane||0)+3); } }
    if(p.dualityT>0){ p.dualityT-=dt; if(p.dualityT<=0) p.dualityStacks=0; }
    if(p.jumpT>0)p.jumpT-=dt;
    if(p.levitateT>0)p.levitateT-=dt;
    if(p.braceT>0)p.braceT-=dt;
    if(p.tacticalPullT>0){ p.tacticalPullT-=dt;
      if(p.tacticalPullT<=0){ const tgt=players[p.tacticalPullTargetId];
        if(tgt && tgt.chosen && !tgt.dead && tgt.zone===p.zone && tgt.iframe<=0){
          const dx=p.x-tgt.x, dy=p.y-tgt.y, dd=Math.hypot(dx,dy)||1;
          const pd=Math.min(p.tacticalPullDist||150, dd);
          tgt.x+=(dx/dd)*pd; tgt.y+=(dy/dd)*pd; clampPos(tgt);
          fxEv('dash',tgt.x,tgt.y,45,0,0,0);
        }
        p.tacticalPullTargetId=null;
      }
    }
    if(p.cls==='mage' && p.arcaneStateT>0){ p.arcaneStateT-=dt; if(p.arcaneStateT<=0)p.arcaneState=null; }
    if(p.cls==='arc' && p.focus>0 && p.hurtT>3){ p.focus=Math.max(0,p.focus-6*dt); }
    if(p.cls==='blade' && p.hurtT>3){ if(p.momentum>0)p.momentum=Math.max(0,p.momentum-5*dt); if(p.arcane>0)p.arcane=Math.max(0,p.arcane-5*dt); }
    p.mp=Math.min(p.maxmp,p.mp+12*dt);
    if(p.hurtT>1.5 && !p.dead)p.hp=Math.min(p.maxhp,p.hp+8*dt);
    if(p.dead){ p.respawnT-=dt; if(p.respawnT<=0){p.dead=false;p.hp=p.maxhp;p.mp=p.maxmp;p.iframe=2;p.zone='town';p.x=400+Math.random()*100;p.y=300+Math.random()*100;} continue; }
    const bladeArcSpd=(p.cls==='blade' && getStance(p)==='arcane')?1.15:1;
    const sp=(p.spd+(p.AGI||0)*2)*((p.buffT>0)?p.buffSpdMul:1)*((p.slowT>0)?p.slowMul:1)*mountSpdMul(p)*bladeArcSpd;
    p.x+=p.ix*sp*dt; p.y+=p.iy*sp*dt; clampPos(p);
    if(p.cls==='arc' && p.rhythmT>0){ p.rhythmT-=dt;
      const mv=Math.hypot(p.ix,p.iy);
      if(mv>0.3){ const dot=(p.ix/mv)*p.rhythmFx+(p.iy/mv)*p.rhythmFy; if(dot>0.5){ p.rhythmReady=true; p.rhythmT=0; } }
    }
    for(const port of zoneOf(p).portals){ if(Math.hypot(p.x-port.x,p.y-port.y)<port.r){
      if(port.to==='dungeon'){ ensureDungeon(p);
        if(p.dungeonEntries<=0){ if(!p._dgWarned){ sendTo(id,{t:'toast',text:'Hết vé vào Mật Thất hôm nay (tối đa '+DUNGEON_MAX_ENTRIES+')'}); p._dgWarned=true; } continue; }
        p._dgWarned=false; p.dungeonEntries--; sendTo(id,{t:'dungeon',entries:p.dungeonEntries,max:DUNGEON_MAX_ENTRIES});
      }
      p.zone=port.to; p.x=port.tx; p.y=port.ty; break; } }
    let nearest=null,nb=70;
    for(const npc of NPCS){ if(npc.zone!==p.zone)continue; const d=Math.hypot(p.x-npc.x,p.y-npc.y); if(d<nb){nb=d;nearest=npc;} }
    const nnid=nearest?nearest.id:null;
    if(p.nearNpc!==nnid){ p.nearNpc=nnid; sendTo(id,{t:'nearnpc',npcId:nnid,name:nearest?nearest.name:null,icon:nearest?nearest.icon:null,kind:nearest?nearest.kind:null}); }
    if(p.fusedT>0){ p.fusedT-=dt; if(p.fusedT<=0){ p.fusedT=0; p.fusionCd=FUSION_CD; recompute(p); sendTo(id,{t:'toast',text:'Hợp thể kết thúc, Đệ Tử tách ra.'}); } }
    if((p.pkScore||0)>0){
      if(p.jailed>0){ p.jailed-=dt; p.pkScore=Math.max(0,p.pkScore-dt*(1/20)); if(p.jailed<=0){p.jailed=0; sendTo(id,{t:'toast',text:'Đã mãn hạn tự thú. Điểm PK: '+Math.round(p.pkScore)});} }
      else p.pkScore=Math.max(0,p.pkScore-dt*(1/300));
    }
    tickStatuses(p,dt);
    if(p.comboState && p.comboState.expireAt<=Date.now()){
      const csk=findSkill(p.cls,p.comboState.skillId);
      if(csk){ p.cd[p.comboState.slot]=Math.max(0.3,csk.cd-(p.INT||0)*0.02); sendTo(id,{t:'skillcd',slot:p.comboState.slot,dur:p.cd[p.comboState.slot]});
        if(csk.type==='timeecho'){ p.echoPos=null; sendTo(id,{t:'echomark',active:false}); } }
      p.comboState=null;
    }
    if(p.channelState){
      const cs=p.channelState; cs.elapsed+=dt; cs.tickT-=dt;
      if(cs.tickT<=0){
        cs.tickT=(findSkill(p.cls,cs.skillId)||{}).channelTick||0.2;
        const csk2=findSkill(p.cls,cs.skillId);
        if(csk2){
          const fa=Math.atan2(p.fy,p.fx);
          const dmg=applyPassiveOnHit(p,id,null,(csk2.dmg+POW(p))*rankMul((p.skRank&&p.skRank[cs.skillId])||1));
          const hitRectC=(ent)=>{ const dx=ent.x-p.x,dy=ent.y-p.y;
            const fwd=dx*Math.cos(fa)+dy*Math.sin(fa), side=-dx*Math.sin(fa)+dy*Math.cos(fa);
            return fwd>=0 && fwd<=csk2.len && Math.abs(side)<=csk2.width/2; };
          for(const eid in enemies){const e=enemies[eid]; if(!e.dead && e.zone===p.zone && hitRectC(e)) hurtEnemy(e,dmg*markBonus(e),id); }
          for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(o.chosen&&!o.dead&&o.iframe<=0&&o.zone===p.zone&&!zoneOf(o).safe&&hitRectC(o)) hurtPlayer(o,dmg*markBonus(o)*PVP,id); }
          fxEv('ring',p.x+p.fx*csk2.len*0.5,p.y+p.fy*csk2.len*0.5,280,0,0,csk2.width*0.6);
        }
      }
      if(cs.elapsed>=cs.maxDur){
        const csk3=findSkill(p.cls,cs.skillId);
        if(csk3){ p.cd[cs.slot]=Math.max(0.3,csk3.cd-(p.INT||0)*0.02); sendTo(id,{t:'skillcd',slot:cs.slot,dur:p.cd[cs.slot]}); }
        p.channelState=null;
      }
    }
    if(p.hspet){ const wasHungry=p.hspet.hunger<=0; p.hspet.hunger=Math.max(0,(p.hspet.hunger||100)-dt*(100/1800));
      if(!wasHungry && p.hspet.hunger<=0){ recompute(p); sendTo(id,{t:'toast',text:'Thú Cưng đói rồi, hiệu quả giảm — cho ăn đi!'}); } }
    else if(p.fusionCd>0){ p.fusionCd=Math.max(0,p.fusionCd-dt); }
    if(p.pet){ if(p.fusedT<=0) tickPet(p,id,dt); else { p.pet.x=p.x; p.pet.y=p.y; p.pet.zone=p.zone; } }
    if(p.summon){ tickSummon(p,id,dt); }
  }
  for(const eid in enemies){const e=enemies[eid];
    if(e.dead){e.respawnT-=dt;if(e.respawnT<=0){const wasBoss=e.boss,z=e.zone;delete enemies[eid];
      if(wasBoss){ if(z==='dungeon')spawnBoss(z); } else spawnEnemy(z);}continue;}
    if(e.atk>0)e.atk-=dt; if(e.slowT>0)e.slowT-=dt; if(e.atkDebuffT>0)e.atkDebuffT-=dt; tickStatuses(e,dt);
    let tp=null,tpIll=false,best=1e9;
    for(const id in players){const p=players[id];if(!p.chosen||p.dead||p.zone!==e.zone)continue;const d=Math.hypot(p.x-e.x,p.y-e.y);if(d<best){best=d;tp=p;tpIll=false;}}
    for(let ii=0;ii<illusions.length;ii++){const il=illusions[ii]; if(il.zone!==e.zone)continue; const d=Math.hypot(il.x-e.x,il.y-e.y)*0.6; if(d<best){best=d;tp=il;tpIll=true;}}
    const espd=e.spd*((e.slowT>0)?(e.slowMul||1):1);
    if(e.boss && e.lairX!==undefined){
      const lx=e.lairX, ly=e.lairY, lr=e.leash||380; let engage=false;
      if(tp){ const tpLair=Math.hypot(tp.x-lx,tp.y-ly), tpDist=Math.hypot(tp.x-e.x,tp.y-e.y); if(tpLair<=lr||tpDist<=lr) engage=true; }
      if(!engage){ const dl=Math.hypot(e.x-lx,e.y-ly);
        if(dl>10){ const a=Math.atan2(ly-e.y,lx-e.x); e.x+=Math.cos(a)*espd*dt; e.y+=Math.sin(a)*espd*dt; clampEnemyPos(e); }
        tp=null; }
    }
    if(tp){ const reach=15+e.r; if(best>reach){const a=Math.atan2(tp.y-e.y,tp.x-e.x);e.x+=Math.cos(a)*espd*dt;e.y+=Math.sin(a)*espd*dt;}
      else if(e.atk<=0){ const a=Math.atan2(tp.y-e.y,tp.x-e.x); e.x+=Math.cos(a)*12;e.y+=Math.sin(a)*12;
        if(tpIll){ fxEv('bite',tp.x,tp.y,280,Math.cos(a),Math.sin(a),0); }
        else { hurtPlayer(tp,(e.dmg||6)*((e.atkDebuffT>0)?(e.atkDebuffMul||1):1),null,e); fxEv('bite',tp.x,tp.y,0,Math.cos(a),Math.sin(a),0); }
        e.atk=e.boss?1.4:1.0; } }
  }
  for(let i=bolts.length-1;i>=0;i--){const b=bolts[i];b.x+=b.vx*dt;b.y+=b.vy*dt;b.life-=dt;
    let removed=false; if(!b.hitSet)b.hitSet=[];
    const zw=(ZONES[b.zone]||ZONES.town).w, zh=(ZONES[b.zone]||ZONES.town).h;
    const fireBonus=(ent)=>{ if(!b.isFire)return 0; if(getStatus(ent,'frostmark')){ hitEv(ent.x,ent.y-30,'Bùng nổ!',false); return (b.curDmg||b.dmg)*0.8; } return b.burnDmg||0; };
    for(const eid in enemies){const e=enemies[eid];if(e.dead||e.zone!==b.zone||b.hitSet.includes(eid))continue;if(Math.hypot(e.x-b.x,e.y-b.y)<(e.boss?38:24)){
      hurtEnemy(e,((b.curDmg||b.dmg)*markBonus(e)+fireBonus(e))*arcMarkBonus(e),b.owner);if(b.slowMul){e.slowT=b.slowDur;e.slowMul=b.slowMul;}
      if(b.isThrownRupture) addStatus(e,'shred',{dur:b.shredDur,data:{mul:b.shredMul}});
      if(b.pierce && b.pierce>1){ b.pierce--; b.hitSet.push(eid); b.curDmg=(b.curDmg||b.dmg)*(b.falloff||1); } else { removed=true; }
      break;}}
    if(!removed)for(const pid in players){if(pid==b.owner||b.hitSet.includes(pid))continue;const o=players[pid];if(!o.chosen||o.dead||o.iframe>0||o.zone!==b.zone||zoneOf(o).safe)continue;if(Math.hypot(o.x-b.x,o.y-b.y)<25){
      if(b.isThrownRupture && o.shieldHP>0){ const thDmg=(b.curDmg||b.dmg)*1.5; const absorb=Math.min(o.shieldHP,thDmg); o.shieldHP-=absorb; const rem=Math.max(0,thDmg-absorb); if(rem>0)hurtPlayer(o,rem*PVP,b.owner); }
      else { hurtPlayer(o,(((b.curDmg||b.dmg)*markBonus(o)+fireBonus(o))*arcMarkBonus(o))*PVP,b.owner); if(b.isThrownRupture) addStatus(o,'shred',{dur:b.shredDur,data:{mul:b.shredMul}}); }
      if(b.slowMul){o.slowT=b.slowDur;o.slowMul=b.slowMul;}
      if(b.pierce && b.pierce>1){ b.pierce--; b.hitSet.push(pid); b.curDmg=(b.curDmg||b.dmg)*(b.falloff||1); } else { removed=true; }
      break;}}
    if(removed||b.x<0||b.x>zw||b.y<0||b.y>zh||b.life<=0)bolts.splice(i,1);
  }
  for(let i=loot.length-1;i>=0;i--){const it=loot[i];it.life-=dt;
    if(it.life<=0){loot.splice(i,1);continue;}
    for(const id in players){const p=players[id];if(!p.chosen||p.dead||p.zone!==it.zone)continue;
      if(Math.hypot(p.x-it.x,p.y-it.y)<26){ pickup(p,id,it); loot.splice(i,1); break; }}
  }
  for(let i=traps.length-1;i>=0;i--){const tr=traps[i]; tr.life-=dt; let triggered=false;
    for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==tr.zone)continue;
      if(Math.hypot(e.x-tr.x,e.y-tr.y)<tr.triggerR){ e.slowT=tr.rootDur; e.slowMul=0.05; addStatus(e,'huntmark',{dur:4,data:{bonus:0.2}}); triggered=true; break; } }
    if(!triggered) for(const pid in players){ if(pid==tr.owner)continue; const o=players[pid]; if(!o.chosen||o.dead||o.zone!==tr.zone||zoneOf(o).safe)continue;
      if(Math.hypot(o.x-tr.x,o.y-tr.y)<tr.triggerR){ o.slowT=tr.rootDur; o.slowMul=0.05; addStatus(o,'huntmark',{dur:4,data:{bonus:0.2}}); triggered=true; break; } }
    if(triggered||tr.life<=0) traps.splice(i,1);
  }
  for(let i=crystals.length-1;i>=0;i--){const cr=crystals[i]; cr.life-=dt;
    for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==cr.zone)continue;
      if(Math.hypot(e.x-cr.x,e.y-cr.y)<cr.radius) addStatus(e,'frostmark',{dur:0.5}); }
    for(const pid in players){const o=players[pid]; if(!o.chosen||o.dead||o.zone!==cr.zone||zoneOf(o).safe)continue;
      if(Math.hypot(o.x-cr.x,o.y-cr.y)<cr.radius) addStatus(o,'frostmark',{dur:0.5}); }
    if(cr.life<=0) crystals.splice(i,1);
  }
  for(let i=wells.length-1;i>=0;i--){const w=wells[i]; w.life-=dt; w.tickT-=dt; w.pullTickT=(w.pullTickT||0)-dt;
    const doTick=(w.tickT<=0);
    const doPull=(w.pullTickT<=0);
    if(doTick)w.tickT=0.5;
    if(doPull)w.pullTickT=0.1;
    const ownerP=players[w.owner]; const ownerParty=ownerP?ownerP.party:null;
    let tickCount=0;
    for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==w.zone)continue;
      const dx=w.x-e.x,dy=w.y-e.y,d=Math.hypot(dx,dy); if(d>w.radius||d<1)continue;
      if(doPull){ e.x+=(dx/d)*w.pullSpd*0.1; e.y+=(dy/d)*w.pullSpd*0.1; clampEnemyPos(e); }
      if(doTick && tickCount<4){ hurtEnemy(e,w.dmg,w.owner); fxEv('ring',e.x,e.y,280,0,0,20); tickCount++; } }
    for(const pid in players){const o=players[pid]; if(!o.chosen||o.dead||o.zone!==w.zone||zoneOf(o).safe||pid==w.owner)continue;
      if(ownerParty && o.party===ownerParty)continue; // không hút/gây dame đồng đội cùng tổ đội
      const dx=w.x-o.x,dy=w.y-o.y,d=Math.hypot(dx,dy); if(d>w.radius||d<1)continue;
      if(doPull){ o.x+=(dx/d)*w.pullSpd*0.1; o.y+=(dy/d)*w.pullSpd*0.1; clampPos(o); }
      if(doTick && tickCount<4){ hurtPlayer(o,w.dmg*PVP,w.owner); fxEv('ring',o.x,o.y,280,0,0,20); tickCount++; } }
    if(w.life<=0) wells.splice(i,1);
  }
  for(let i=illusions.length-1;i>=0;i--){ illusions[i].life-=dt; if(illusions[i].life<=0) illusions.splice(i,1); }
  for(const pid3 in players){ players[pid3].bannerAtkBuf=0; players[pid3].bannerDefBuf=0; }
  for(let i=banners.length-1;i>=0;i--){const bn=banners[i]; bn.life-=dt;
    const ownerP2=players[bn.owner]; const willBoost=(ownerP2 && ownerP2.commandStateT>0)?(1+(ownerP2.commandStateBannerBuf||0)):1;
    for(const pid3 in players){const o=players[pid3]; if(!o.chosen||o.dead||o.zone!==bn.zone)continue;
      if(Math.hypot(o.x-bn.x,o.y-bn.y)<=bn.radius){ o.bannerAtkBuf=Math.max(o.bannerAtkBuf||0,bn.atkBuf*willBoost); o.bannerDefBuf=Math.max(o.bannerDefBuf||0,bn.defBuf*willBoost); } }
    if(bn.life<=0) banners.splice(i,1);
  }
  for(let i=dotZones.length-1;i>=0;i--){const dz=dotZones[i]; dz.life-=dt; dz.tickT=(dz.tickT||0)-dt;
    const doTick=(dz.tickT<=0); if(doTick)dz.tickT=0.5;
    if(doTick){ let hitCount=0;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==dz.zone||hitCount>=4)continue;
        if(Math.hypot(e.x-dz.x,e.y-dz.y)<=dz.radius){ hurtEnemy(e,dz.dmg,dz.owner); hitCount++; } }
      for(const pid3 in players){ if(hitCount>=4)continue; const o=players[pid3]; if(!o.chosen||o.dead||o.iframe>0||o.zone!==dz.zone||zoneOf(o).safe||pid3==dz.owner)continue;
        if(Math.hypot(o.x-dz.x,o.y-dz.y)<=dz.radius){ hurtPlayer(o,dz.dmg*PVP,dz.owner); hitCount++; } }
    }
    if(dz.life<=0) dotZones.splice(i,1);
  }
  const psPublic={}; for(const id in players){const p=players[id];if(!p.chosen)continue;
    try{
      psPublic[id]={x:r1(p.x),y:r1(p.y),fx:r2(p.fx),fy:r2(p.fy),hp:r1(p.hp),maxhp:p.maxhp,mp:r1(p.mp),maxmp:p.maxmp,hue:p.hue,dead:p.dead,lv:p.lv,cls:p.cls,zone:p.zone,name:p.charDisplayName||('#'+id),bladeStance:p.bladeStance||'blade',jumpT:r2(p.jumpT||0),jumpScale:r2(p.jumpScale||1),levitateT:r2(p.levitateT||0),braceT:r2(p.braceT||0),
        spd:r1((p.spd+(p.AGI||0)*2)*((p.buffT>0)?p.buffSpdMul:1)*mountSpdMul(p)*((p.cls==='blade'&&getStance(p)==='arcane')?1.15:1)),bcd:Math.max(0.15,p.basicCd-(p.AGI||0)*0.01),sh:(p.shieldHP>0),mt:p.mounted,pk:Math.round(p.pkScore||0),
        wound:statusStacks(p,'wound'),shred:!!getStatus(p,'shred'),counter:(p.counterT>0),warcryBuf:(p.warcryDefT>0),frenzy:(p.cls==='war'&&(p.fervor||0)>=80),marked:!!getStatus(p,'huntmark'),arcmarked:!!getStatus(p,'arcmark'),ravenmarked:!!getStatus(p,'ravenmark'),bladefrost:!!getStatus(p,'bladefrost'),spellBladeArmed:(p.spellBladeT>0),resonanceActive:(p.resonanceT>0),dualityActive:(p.dualityT>0),dualityStacks:(p.dualityStacks||0),windguard:(p.windguardT>0),wildhunt:(p.wildHuntT>0),decreeBuf:(p.decreeBuffT>0),decreeDebuf:(p.decreeDebuffT>0),sacrificeBuf:(p.sacrificeAtkBufT>0),soulBuf:(p.soulBufT>0),willActive:(p.commandStateT>0),
        slowed:(p.slowT>0&&(p.slowMul||1)>=0.15),rooted:(p.slowT>0&&(p.slowMul||1)<0.15)};
    }catch(err){ console.error('⚠️ Lỗi tính state công khai cho #'+id+':', err && err.message); }
  }
  const es={}; for(const eid in enemies){const e=enemies[eid];
    es[eid]={x:r1(e.x),y:r1(e.y),zone:e.zone,hp:r1(e.hp),maxhp:e.maxhp,dead:e.dead,boss:e.boss,r:e.r,mname:e.mname||null,mhue:e.mhue,mshape:e.mshape,
      wound:statusStacks(e,'wound'),shred:!!getStatus(e,'shred'),weak:(e.atkDebuffT>0),marked:!!getStatus(e,'huntmark'),arcmarked:!!getStatus(e,'arcmark'),ravenmarked:!!getStatus(e,'ravenmark'),bladefrost:!!getStatus(e,'bladefrost'),
      slowed:(e.slowT>0&&(e.slowMul||1)>=0.15),rooted:(e.slowT>0&&(e.slowMul||1)<0.15)};}
  const bs=bolts.map(b=>({x:r1(b.x),y:r1(b.y),zone:b.zone,hue:b.hue,kind:b.kind||'bolt',r:b.r||6,a:r2(Math.atan2(b.vy,b.vx))}));
  const ls=loot.map(it=>({id:it.item.id,x:r1(it.x),y:r1(it.y),zone:it.zone,slot:it.item.slot,tier:it.item.tier}));
  const trs=traps.map((tr,i)=>({id:i,x:r1(tr.x),y:r1(tr.y),zone:tr.zone,r:tr.triggerR}));
  const crs=crystals.map((cr,i)=>({id:i,x:r1(cr.x),y:r1(cr.y),zone:cr.zone,r:cr.radius}));
  const wls=wells.map((w,i)=>({id:i,x:r1(w.x),y:r1(w.y),zone:w.zone,r:w.radius}));
  const ils=illusions.map((il,i)=>({id:i,x:r1(il.x),y:r1(il.y),zone:il.zone,cls:il.cls,hue:il.hue}));
  const bns=banners.map((bn,i)=>({id:i,x:r1(bn.x),y:r1(bn.y),zone:bn.zone,r:bn.radius}));
  const bt={}; for(const z in zoneBoss)bt[z]={phase:zoneBoss[z].phase,t:Math.ceil(zoneBoss[z].t)};
  const pd={}; for(const id in players){const p=players[id]; if(!p.chosen||!p.pet)continue;
    const pt=PET_TYPES.find(t=>t.id===p.pet.type);
    pd[id]={type:p.pet.type,icon:pt?pt.icon:'🐾',hue:pt?pt.hue:0,x:r1(p.pet.x),y:r1(p.pet.y),zone:p.pet.zone,lv:p.pet.lv};}
  const sd={}; for(const id in players){const p=players[id]; if(!p.chosen||!p.summon)continue;
    sd[id]={x:r1(p.summon.x),y:r1(p.summon.y),zone:p.summon.zone,phase:p.summon.orderPhase||null};}
  // Mỗi người chơi nhận: vị trí/máu công khai của MỌI người (nhẹ) + số liệu riêng (vàng/xp/stat) CHỈ của chính mình
  for(const id in players){ const p=players[id]; if(!p.chosen)continue;
    try{
      const mine=Object.assign({},psPublic[id],{gold:p.gold,stones:p.stones,xp:p.xp,xpNext:p.xpNext,gAtk:p.gearAtk,gHp:p.gearHp,
        STR:p.STR,VIT:p.VIT,AGI:p.AGI,INT:p.INT,statPts:p.statPts,skillPts:p.skillPts,res:resourceInfo(p),
        pet:p.pet?{type:p.pet.type,lv:p.pet.lv,xp:p.pet.xp,xpNext:p.pet.xpNext,fullness:Math.round(p.pet.fullness)}:null,
        fusedT:Math.round(p.fusedT||0),fusionCd:Math.round(p.fusionCd||0),
        hspet:p.hspet?{stat:p.hspet.stat,hunger:Math.round(p.hspet.hunger)}:null,
        pkScore:Math.round(p.pkScore||0),jailed:Math.round(p.jailed||0)});
      const psOut=Object.assign({},psPublic,{[id]:mine});
      sendTo(id,{t:'state',players:psOut,enemies:es,bolts:bs,loot:ls,bossTimers:bt,pets:pd,summons:sd,traps:trs,crystals:crs,wells:wls,illusions:ils,banners:bns});
    }catch(err){ console.error('⚠️ Lỗi gửi state cho #'+id+' (đã chặn, không ảnh hưởng người khác):', err && err.message); }
  }
 }catch(tickErr){ console.error('⚠️ Lỗi trong vòng lặp chính (đã chặn, tick sau sẽ chạy lại bình thường):', tickErr && tickErr.message); }
},TICK);
function r1(v){return Math.round(v*10)/10;} function r2(v){return Math.round(v*100)/100;}

setInterval(()=>{ for(const id in players){ const p=players[id]; if(p.charUser&&p.charSlot&&p.chosen) dbSaveChar(p.charUser,p.charSlot,p); } }, 60000);

dbInit();
server.listen(PORT,()=>console.log('✅ WEBGAME v3.18 (icon trang bị pixel theo cấp) chạy ở cổng '+PORT));
