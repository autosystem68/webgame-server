// ============================================================
// WEBGAME — MMORPG server-authoritative (Node + ws, single-file theo quy trình tablet-upload)
// 5 class · 8-12 skill/class (combo riêng) · world nhiều vùng · dungeon vé vào
// world boss lịch cố định · NPC/quest · party/guild/chat · loot/enchant/equip
// Chạy:  npm install ws   →   node server.js
// ============================================================
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const W = 800, H = 600, SPD = 250;
// ---- VÙNG BẢN ĐỒ (world nhiều vùng + thị trấn an toàn) ----
const ZONES = {
  town:   {name:'🏘️ Thị Trấn An Bình', w:900,  h:700,  safe:true,  bg:'#1a2318',
    portals:[ {x:820,y:350,r:44,to:'forest',tx:80,ty:500,label:'→ Rừng Ma'},
              {x:80, y:350,r:44,to:'cave',  tx:700,ty:500,label:'→ Hang Băng'},
              {x:450,y:660,r:44,to:'dungeon',tx:120,ty:475,label:'🎫 Mật Thất Cổ (vé)'} ]},
  forest: {name:'🌲 Rừng Ma', w:1500, h:1100, safe:false, bg:'#14100c', tier:1,
    portals:[ {x:40,y:550,r:44,to:'town',tx:760,ty:350,label:'→ Thị Trấn'} ]},
  cave:   {name:'❄️ Hang Băng', w:1500, h:1100, safe:false, bg:'#0d1520', tier:2,
    portals:[ {x:1460,y:550,r:44,to:'town',tx:140,ty:350,label:'→ Thị Trấn'} ]},
  dungeon:{name:'🏚️ Mật Thất Cổ', w:1300, h:950, safe:false, bg:'#1a0f1a', tier:3,
    portals:[ {x:40,y:475,r:44,to:'town',tx:400,ty:600,label:'→ Thị Trấn'} ]},
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
  .sk .k{font-size:16px;line-height:1}.sk .l{font-size:8px;color:#9a8a6a}
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
  <div id="pick">
    <h2>Chọn Class</h2><p>Mỗi class một lối chơi — chọn để vào trận</p>
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
    <div class="sk" id="sQ"><span class="k">Q</span><span class="l">LƯỚT</span><span class="m">12</span><div class="cd"></div></div>
    <div class="sk" id="sW"><span class="k">W</span><span class="l">TIA</span><span class="m">18</span><div class="cd"></div></div>
    <div class="sk" id="sE"><span class="k">E</span><span class="l">NỔ</span><span class="m">30</span><div class="cd"></div></div>
    <div class="sk" id="sR"><span class="k">R</span><span class="l">CUỒNG</span><span class="m">55</span><div class="cd"></div></div>
  </div>
  <div id="st">Đang kết nối...</div>
  <div id="ver">v0.92 · xoay/nhảy/bay lơ lửng thật (5 skill)</div>
</div>
<script>
var WW=800, WH=600;
var cv=document.getElementById('c'), ctx=cv.getContext('2d');
var scr={w:0,h:0,scale:1,ox:0,oy:0,dpr:1};
function resize(){
  scr.dpr=Math.min(devicePixelRatio||1,2);
  var r=cv.getBoundingClientRect(); scr.w=r.width; scr.h=r.height;
  cv.width=scr.w*scr.dpr; cv.height=scr.h*scr.dpr;
  scr.scale=Math.min(scr.w/WW, scr.h/WH);
  scr.ox=(scr.w-WW*scr.scale)/2; scr.oy=(scr.h-WH*scr.scale)/2;
}
addEventListener('resize',resize); resize();

var myId=null, players={}, enemies={}, bolts=[], loot=[], fx=[], dmgs=[], shake=0, chosen=false, lastSkillMeta=null;
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
function itemHTML(it){var pl=it.plus||0;return SLOTICON[it.slot]+(pl>0?'<span class="pl">+'+pl+'</span>':'')+'<span class="v">'+eVal(it)+'</span>';}
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
      el.innerHTML=it?itemHTML(it):'<span style="opacity:.28">'+SLOTICON[slot]+'</span>';
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
(function buildPicker(){var box=document.getElementById('pcards');
  var order=['war','mage','arc','blade','cmd'];
  for(var i=0;i<order.length;i++){(function(c){
    var el=document.createElement('div');el.className='pcard';
    el.innerHTML='<div class="ic">'+CLS[c].n.split(' ')[0]+'</div><div class="cn">'+CLS[c].n.replace(/^\S+\s/,'')+'</div><div class="cd2">'+CLS[c].d+'</div>';
    el.addEventListener('pointerdown',function(ev){ev.preventDefault();
      if(ws.readyState===1)ws.send(JSON.stringify({t:'pick',c:c}));
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
  if(m.t==='welcome'){myId=m.id;document.getElementById('me').textContent='#'+m.id;}
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
          var stTxt=(myBladeStance==='arcane')?'🔮 PHÉP (-20% Mana, đánh xa)':'⚔️ KIẾM (+10% hút máu, đánh gần)';
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
    for(var kk in map){ var el=document.getElementById(map[kk]); var d=mm[kk]; if(!el||!d)continue;
      var isEmpty=(kk!=='b' && !d.name);
      el.classList.toggle('empty', isEmpty);
      var kEl=el.querySelector('.k'); if(kEl && kk!=='b') kEl.textContent = isEmpty ? '?' : kk.toUpperCase();
      var lbl=el.querySelector('.l'); if(lbl)lbl.textContent = isEmpty ? '???' : (d.name.length>8?d.name.slice(0,8):d.name).toUpperCase();
      var mel=el.querySelector('.m'); if(mel){ if(d.mp>0){mel.style.display='';mel.textContent=d.mp;} else mel.style.display='none'; }
      SKdur[kk]=d.cd; SKmp[kk]=d.mp; }
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
  else if(m.t==='stance'){ myBladeStance=m.stance; var swapLbl=document.getElementById('swapLbl'); if(swapLbl)swapLbl.textContent=(m.stance==='arcane')?'PHÉP':'KIẾM'; }
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
var FX_DUR={enchok:0.6,enchfail:0.6,starfall:0.9,bigswing:0.5,raven:0.55,orderflag:0.5,plantflag:0.8,rally:0.7,horsecharge:0.4,ravenscout:0.6,sacrifice:0.5,soulburst:0.6,swapblade:0.4,swaparcane:0.4,phaseslash:0.35,arcblink:0.4,backstep:0.3,spinattack:0.45,jumpslam:0.5,levitatenova:0.9,braceward:0.35};
var AIM_MAX_PX=90;
function isChargeable(k){ var sid=myLoadout&&myLoadout[k]; for(var i=0;i<myFull.length;i++){ if(myFull[i].id===sid) return !!myFull[i].chargeable; } return false; }
function isChannelable(k){ var sid=myLoadout&&myLoadout[k]; for(var i=0;i<myFull.length;i++){ if(myFull[i].id===sid) return !!myFull[i].channelable; } return false; }
var AIMABLE_TYPES={dash:1,warcleave:1,predstep:1,groundbreak:1,pierce:1,huntmark:1,trap:1,starfall:1,windguard:1,
  emberlance:1,frostprism:1,arcanethread:1,cataclysm:1,mirrorstep:1,gravitywell:1,arcanedet:1,blooddebt:1,warlordverdict:1,ravenmark:1,cmdadvance:1,banner:1,horsecharge:1,tacticalrecall:1,blinkcut:1,arcslash:1,wildhunt:1,lifesteal:1,swordwave:1,voidsword:1,bloodsword:1,proj:1,cone:1,nova:1,slow:1,leap:1};
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

  var meNow=players[myId];
  var followX = (myPX!==null?myPX:(meNow?meNow.x:zd.w/2));
  var followY = (myPY!==null?myPY:(meNow?meNow.y:zd.h/2));
  var camX = zd.w<=WW ? zd.w/2 : Math.max(WW/2,Math.min(zd.w-WW/2,followX));
  var camY = zd.h<=WH ? zd.h/2 : Math.max(WH/2,Math.min(zd.h-WH/2,followY));
  var camOX = WW/2-camX, camOY = WH/2-camY;
  ctx.save(); ctx.translate(camOX,camOY);

  ctx.strokeStyle='#2b2117';ctx.lineWidth=1;ctx.globalAlpha=.55;
  for(var x=0;x<=zd.w;x+=48){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,zd.h);ctx.stroke();}
  for(var y=0;y<=zd.h;y+=48){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(zd.w,y);ctx.stroke();}
  ctx.globalAlpha=1;
  ctx.strokeStyle='#000';ctx.lineWidth=6;ctx.strokeRect(0,0,zd.w,zd.h);

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
      ctx.strokeStyle='#ffb060';ctx.lineWidth=5;
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

  for(var eid in enemies){var en=enemies[eid];if(en.dead||en.zone!==myZone)continue;var er=en.r||14;
    ctx.fillStyle=en.boss?'#8a2f6a':'#b8514d';ctx.strokeStyle=en.boss?'#4a1838':'#7a2f2c';ctx.lineWidth=en.boss?3:2;
    ctx.beginPath();ctx.arc(en.x,en.y,er,0,7);ctx.fill();ctx.stroke();
    if(en.rooted){ ctx.globalAlpha=0.4; ctx.fillStyle='#8a4a2a'; ctx.beginPath(); ctx.arc(en.x,en.y,er,0,7); ctx.fill(); ctx.globalAlpha=1; }
    else if(en.slowed){ ctx.globalAlpha=0.35; ctx.fillStyle='#5ab0e0'; ctx.beginPath(); ctx.arc(en.x,en.y,er,0,7); ctx.fill(); ctx.globalAlpha=1; }
    var bw=en.boss?70:30;ctx.fillStyle='#000a';ctx.fillRect(en.x-bw/2,en.y-er-10,bw,en.boss?6:4);
    ctx.fillStyle=en.boss?'#e07ab8':'#d06a55';ctx.fillRect(en.x-bw/2,en.y-er-10,bw*Math.max(0,en.hp)/en.maxhp,en.boss?6:4);
    if(en.boss){ctx.fillStyle='#ffb0e0';ctx.font='bold 12px Trebuchet MS';ctx.textAlign='center';ctx.fillText('BOSS',en.x,en.y-er-16);}
    var stIc=''; if(en.wound>0)stIc+='🩸'; if(en.shred)stIc+='💢'; if(en.weak)stIc+='📢'; if(en.marked)stIc+='🎯'; if(en.arcmarked)stIc+='🔮'; if(en.ravenmarked)stIc+='🐦'; if(en.bladefrost)stIc+='🧊'; if(en.rooted)stIc+='⛓️'; else if(en.slowed)stIc+='❄️';
    if(stIc){ ctx.font='11px serif';ctx.textAlign='center';ctx.fillText(stIc,en.x,en.y-er-(en.boss?24:16)); }}

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
    else {ctx.beginPath();ctx.arc(bl.x,bl.y,br,0,7);ctx.fill();}
    ctx.shadowBlur=0;ctx.restore();}

  // --- DỰ ĐOÁN vị trí nhân vật MÌNH (client prediction) cho mượt tức thì ---
  var me=players[myId];
  if(me && !me.dead){
    if(myPX===null){myPX=me.x;myPY=me.y;}
    var pmx=joy.mag>0.15?joy.dx:0, pmy=joy.mag>0.15?joy.dy:0;
    var spd=me.spd||250; if(me.bcd)SKdur.b=me.bcd;
    myPX+=pmx*spd*dt; myPY+=pmy*spd*dt;
    myPX=Math.max(15,Math.min(zd.w-15,myPX)); myPY=Math.max(15,Math.min(zd.h-15,myPY));
    var gap=Math.hypot(me.x-myPX,me.y-myPY);
    if(gap>110){myPX+=(me.x-myPX)*0.5;myPY+=(me.y-myPY)*0.5;} else {myPX+=(me.x-myPX)*0.12;myPY+=(me.y-myPY)*0.12;}
    if(joy.mag>0.2){myFX=joy.dx;myFY=joy.dy;} else {myFX=me.fx;myFY=me.fy;}
  } else { myPX=null; }

  for(var id in players){var p=players[id]; if(p.zone!==myZone)continue;
    var rx,ry,ffx,ffy;
    if(id==myId && myPX!==null && !p.dead){ rx=myPX;ry=myPY;ffx=myFX;ffy=myFY; }
    else { if(p._rx===undefined){p._rx=p.x;p._ry=p.y;} p._rx+=(p.x-p._rx)*0.4;p._ry+=(p.y-p._ry)*0.4; rx=p._rx;ry=p._ry;ffx=p.fx;ffy=p.fy; }
    var yOff=0;
    if(p.jumpT>0){ var jp=p.jumpT/0.4; yOff=-Math.sin(jp*Math.PI)*26; }
    else if(p.levitateT>0){ yOff=-10-Math.sin(performance.now()/200)*3; }
    if(yOff!==0){ ctx.save();ctx.globalAlpha=0.3;ctx.fillStyle='#000';ctx.beginPath();ctx.ellipse(rx,ry+15,13,4,0,0,7);ctx.fill();ctx.restore(); ry+=yOff; }
    ctx.globalAlpha=p.dead?0.25:1;
    ctx.fillStyle='hsl('+p.hue+',70%,58%)';ctx.strokeStyle='#0d0a06';ctx.lineWidth=3;
    ctx.beginPath();ctx.arc(rx,ry,15,0,7);ctx.fill();ctx.stroke();
    if(p.rooted){ ctx.globalAlpha=0.4; ctx.fillStyle='#8a4a2a'; ctx.beginPath(); ctx.arc(rx,ry,15,0,7); ctx.fill(); ctx.globalAlpha=p.dead?0.25:1; }
    else if(p.slowed){ ctx.globalAlpha=0.35; ctx.fillStyle='#5ab0e0'; ctx.beginPath(); ctx.arc(rx,ry,15,0,7); ctx.fill(); ctx.globalAlpha=p.dead?0.25:1; }
    if(!p.dead){ctx.strokeStyle='#ffe0a0';ctx.lineWidth=3;ctx.beginPath();
      ctx.moveTo(rx,ry);ctx.lineTo(rx+ffx*22,ry+ffy*22);ctx.stroke();}
    if(id==myId){ctx.strokeStyle='#ffe0a0';ctx.lineWidth=2;ctx.beginPath();ctx.arc(rx,ry,20,0,7);ctx.stroke();}
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
    ctx.fillStyle='#000a';ctx.fillRect(rx-16,ry-28,32,4);
    ctx.fillStyle='#6fce6a';ctx.fillRect(rx-16,ry-28,32*Math.max(0,p.hp)/p.maxhp,4);
    ctx.fillStyle=(p.pk>=50)?'#ff4a4a':'#e8d8b8';ctx.font='11px Trebuchet MS';ctx.textAlign='center';ctx.fillText('#'+id+(p.pk>=50?' ☠️':''),rx,ry-32);
    var pStIc=''; if(p.wound>0)pStIc+='🩸'; if(p.shred)pStIc+='💢'; if(p.counter)pStIc+='🛡️'; if(p.warcryBuf)pStIc+='📯'; if(p.frenzy)pStIc+='🔥'; if(p.marked)pStIc+='🎯'; if(p.arcmarked)pStIc+='🔮'; if(p.ravenmarked)pStIc+='🐦'; if(p.bladefrost)pStIc+='🧊'; if(p.decreeBuf)pStIc+='📣'; if(p.decreeDebuf)pStIc+='😨'; if(p.sacrificeBuf)pStIc+='💔'; if(p.soulBuf)pStIc+='📖'; if(p.willActive)pStIc+='👑'; if(p.windguard)pStIc+='🍃'; if(p.wildhunt)pStIc+='🐾'; if(p.rooted)pStIc+='⛓️'; else if(p.slowed)pStIc+='❄️';
    if(pStIc){ ctx.font='11px serif'; ctx.fillText(pStIc,rx,ry-44); }
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

function spawnEnemy(zone){
  const id = nextE++; const z=ZONES[zone];
  const edge = Math.floor(Math.random()*4), m=40; let x,y;
  if(edge===0){x=Math.random()*z.w;y=m;} else if(edge===1){x=z.w-m;y=Math.random()*z.h;}
  else if(edge===2){x=Math.random()*z.w;y=z.h-m;} else {x=m;y=Math.random()*z.h;}
  const tier=z.tier||1;
  enemies[id]={x,y,zone,hp:70*tier,maxhp:70*tier,spd:52,atk:0,dead:false,respawnT:0,xp:24*tier,gold:6*tier,r:14,boss:false,dmg:6*tier};
}
function spawnBoss(zone){
  const id=nextE++; const z=ZONES[zone]; const tier=z.tier||1;
  enemies[id]={x:z.w/2,y:90,zone,hp:900*tier,maxhp:900*tier,spd:34,atk:0,dead:false,respawnT:0,xp:400*tier,gold:120*tier,r:34,boss:true,dmg:22*tier};
}
for(let i=0;i<4;i++) spawnEnemy('forest');
for(let i=0;i<5;i++) spawnEnemy('cave');
for(let i=0;i<6;i++) spawnEnemy('dungeon');
spawnBoss('dungeon'); // Mật Thất: boss luôn chờ sẵn, vé vào mới là cửa ải (kiểu Blood Castle)

// ---- BOSS THẾ GIỚI THEO LỊCH CỐ ĐỊNH, ĐẾM NGƯỢC CÔNG KHAI (kiểu MU Crywolf/Invasion) ----
// Số giây đặt tạm để test nhanh — khi hài lòng cơ chế, chỉnh lại cho gần thực tế (VD 1800-3600s).
const BOSS_CFG = { forest:{interval:180, active:90}, cave:{interval:240, active:90} };
const zoneBoss = { forest:{phase:'countdown', t:BOSS_CFG.forest.interval}, cave:{phase:'countdown', t:BOSS_CFG.cave.interval} };
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
    cd:{b:0,q:0,w:0,e:0,r:0}};
  ws.pid=id; sockets[id]=ws;
  ws.send(JSON.stringify({t:'welcome',id}));
  ws.send(JSON.stringify({t:'zones',zones:ZONES}));
  ws.send(JSON.stringify({t:'npcs',npcs:NPCS}));
  ws.send(JSON.stringify({t:'pettypes',types:PET_TYPES}));
  ws.send(JSON.stringify({t:'mounttypes',types:MOUNTS}));
  ws.send(JSON.stringify({t:'gemtypes',types:GEM_TYPES}));

  ws.on('message',(buf)=>{
    let m; try{m=JSON.parse(buf.toString());}catch(e){return;}
    const p=players[id]; if(!p)return;
    if(m.t==='pick'){
      const c=CLASSES[m.c]; if(!c||p.chosen)return;
      try{
        p.cls=m.c; p.chosen=true; p.hue=c.hue; p.spd=c.spd;
        p.baseMaxhp=c.hp; p.baseMaxmp=c.mp; p.gearAtk=0; p.gearHp=0; p.inv=[]; p.equip=emptyEquip();
        p.maxhp=c.hp; p.hp=c.hp; p.maxmp=c.mp; p.mp=c.mp;
        p.basicType=c.basic.type; p.basicRange=c.basic.range; p.basicDmg=c.basic.dmg; p.basicCd=c.basic.cd;
        p.basicSpd=c.basic.spd||0; p.basicR=c.basic.r||6; p.basicKind=c.basic.kind||'melee';
        p.zone='town'; p.x=400+Math.random()*100; p.y=300+Math.random()*100; p.iframe=2;
        p.buffT=0; p.STR=0;p.VIT=0;p.AGI=0;p.INT=0;p.statPts=0;p.skillPts=0;p.skRank={};
        p.loadout={q:null,w:null,e:null,r:null}; // bắt đầu trống — chỉ đánh thường, skill mở khóa dần theo cấp
        p.shieldHP=0;p.shieldT=0;p.slowT=0;p.slowMul=1;
        p.passT=0;p.comboN=0;p.comboTgt=null;p.spellBladeT=0; recompute(p);
        sendInv(p,id); sendTo(id,{t:'skills',meta:skillMeta(p),passive:PASSIVES[p.cls],full:fullSkillList(p),loadout:p.loadout}); sendQuests(p,id); sendGuildData(id);
        sendTo(id,{t:'mounts',owned:p.mounts,mounted:p.mounted});
        ensureDungeon(p); sendTo(id,{t:'dungeon',entries:p.dungeonEntries,max:DUNGEON_MAX_ENTRIES});
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
      if((p.stanceSwapCd||0)>0)return;
      p.bladeStance=(p.bladeStance==='arcane')?'blade':'arcane';
      p.stanceSwapCd=0.6;
      if(p.bladeStance==='blade'){ p.x+=p.fx*18; p.y+=p.fy*18; } else { p.x-=p.fx*14; p.y-=p.fy*14; }
      clampPos(p);
      fxEv(p.bladeStance==='arcane'?'swaparcane':'swapblade',p.x,p.y,p.bladeStance==='arcane'?270:15,0,0,40);
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
    {id:'w6',name:'Xuyên Giáp', icon:'🗡️',type:'rupture',mp:20,cd:6,  unlockLv:13, range:105,dmg:32,shredMul:1.5,shredDur:3, reqStat:'STR',reqVal:15,scaleKey:'dmg',
      desc:'Đánh xuyên: nếu mục tiêu (người chơi) đang có khiên thì phá khiên trước rồi mới tính dame thường. Nếu không có khiên thì gây Suy Yếu — mục tiêu nhận thêm 50% sát thương trong 3s.'},
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
    {id:'b1',name:'Chớp Cắt',   icon:'💨',type:'blinkcut', mp:10,cd:2.0, unlockLv:2,  distBlade:110,distArcane:190,dmgBlade:22,
      desc:'Hành vi đổi theo VŨ KHÍ đang cầm (bấm nút ⇄ để đổi): KIẾM → lao ngắn XUYÊN QUA địch trên đường (vệt chém dày, có động tác thật), gây dame. PHÉP → BIẾN MẤT tức thời rồi HIỆN LẠI ở xa hơn hẳn (không có vệt di chuyển, đúng cảm giác dịch chuyển thật, không phải chạy nhanh), không gây dame nhưng né đòn tốt hơn.'},
    {id:'b2',name:'Chém Cung',  icon:'⚔️',type:'arcslash', mp:16,cd:1.2, unlockLv:3,  range:115,arc:0.95,dmgBlade:26,rangeArcane:340,dmgArcane:24,
      desc:'Hành vi đổi theo VŨ KHÍ đang cầm: KIẾM → chém cận chiến hình quạt thật gần; PHÉP → phóng 1 lưỡi kiếm năng lượng bay xa. Đòn Kiếm (kể cả đánh thường) nuôi Momentum, đòn Phép nuôi Arcane.'},
    {id:'b3',name:'Sóng Kiếm',  icon:'🌊',type:'swordwave', mp:24,cd:3,   unlockLv:5,  dmgBlade:27,dmgArcane:22,
      desc:'Kiếm: XOAY NGƯỜI 360° thật (không phải đứng chém), đánh trúng mọi địch xung quanh, nuôi Momentum mạnh. Phép: LÙI HẲN 1 bước trong lúc bắn 3 tia xuyên xa (kite thật, không đứng ì), nuôi Arcane.'},
    {id:'b4',name:'Vũ Bão',     icon:'🌀',type:'stormblade', mp:55,cd:12,  unlockLv:7,  dmgBlade:82,dmgArcane:60,radius:185,
      desc:'ULTIMATE — 2 động tác hoàn toàn khác nhau. Kiếm: NHẢY LÊN KHÔNG TRUNG rồi ĐẬP XUỐNG (bất tử trong lúc bay), nova cực lớn + hút 15% dame thành máu, rung màn hình mạnh. Phép: NHẤC BỔNG NGƯỜI LÊN lơ lửng, nova nhỏ hơn + hồi 25% mana tối đa + làm chậm mọi mục tiêu trúng.'},
    {id:'b5',name:'Kiếm Hút Sinh',icon:'🩸',type:'bloodsword',mp:18,cd:3.5,unlockLv:10,rangeBlade:105,dmgBlade:28,lsBlade:0.55,rangeArcane:220,dmgArcane:22,lsArcane:0.3, reqStat:'STR',reqVal:12,
      desc:'Nhánh STR (Kiếm mạnh hơn hẳn ở đây). Kiếm: tầm ngắn, hút máu 55%. Phép: tầm xa gấp đôi nhưng hút máu chỉ 30%, bù lại gây thêm Bỏng nhẹ theo thời gian.'},
    {id:'b6',name:'Hộ Thể Quyết',icon:'🛡️',type:'bodyward', mp:22,cd:9, unlockLv:13, amountBlade:65,reflectPct:0.2,amountArcane:50,manaShieldPct:0.5,dur:5, reqStat:'INT',reqVal:15,
      desc:'Nhánh INT (Phép mạnh hơn hẳn ở đây). Kiếm: VÀO THẾ THỦ thật (khiên nhỏ giơ trước người suốt 5s), khiên hấp thụ + phản 20% dame về kẻ đánh. Phép: NGƯỜI LƠ LỬNG NHẸ khỏi mặt đất suốt khi còn khiên, khiên yếu hơn nhưng vỡ ra chuyển 50% phần dư thành Mana ngay.'},
    {id:'b7',name:'Băng Kiếm',  icon:'❄️',type:'iceblade', mp:24,cd:8,   unlockLv:16, radius:120,dmgBlade:22,dmgArcane:18,slowMul:0.5,slowDur:2.5,
      desc:'Kiếm: làm chậm + gây Wound (cộng dồn với các đòn Kiếm khác). Phép: làm chậm + đóng dấu Frostmark riêng của Phép (tăng dame nhận từ đòn Phép tiếp theo).'},
    {id:'b8',name:'Kiếm Phá Không',icon:'⚡',type:'voidsword',mp:30,cd:10,unlockLv:20, distBlade:210,dmgBlade:48,impactR:95,distArcane:260,dmgArcane:30,zoneDur:3,
      desc:'Kiếm: nhảy bổ xuống, va chạm gây nổ lớn tức thì. Phép: dịch chuyển xa hơn, va chạm nhẹ hơn nhưng để lại 1 VÙNG DAME liên tục 3s tại điểm đáp.'},
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
  blade:{name:'Song Tu (Dual Mastery)', desc:'CHỦ ĐỘNG đổi vũ khí qua nút ⇄ riêng (không tự động) — đang cầm Kiếm hay Phép quyết định cách MỌI skill Q/W hoạt động. Đánh thường bằng Kiếm nuôi Momentum, bằng Phép nuôi Arcane. Cả 2 trạng thái đều +15% sát thương NHƯ NHAU — khác biệt ở TIỆN ÍCH: cầm KIẾM → hút 10% sát thương thành máu; cầm PHÉP → giảm 20% chi phí Mana mọi skill. Ngoài ra: Skill trúng địch → đòn thường tiếp theo +50% sát thương.'},
  cmd:  {name:'Chỉ Huy',    desc:'Đồng đội trong 150px quanh bạn được +8% sát thương'},
};
function findSkill(cls,id){ return (SKILLS[cls]||[]).find(s=>s.id===id); }
function skillMeta(p){
  const map={ b:{icon:(p.basicType==='melee'?'⚔️':'✦'),name:'Đánh thường',mp:0,cd:p.basicCd,rank:1} };
  for(const k of ['q','w','e','r']){ const sid=p.loadout&&p.loadout[k]; const s=findSkill(p.cls,sid);
    map[k]= s ? {icon:s.icon,name:s.name,mp:s.mp,cd:s.cd,rank:(p.skRank&&p.skRank[sid])||1} : {icon:'?',name:'',mp:0,cd:1,rank:0}; }
  return map;
}
function meetsReq(p,s){ return p.lv>=s.unlockLv && (!s.reqStat || (p[s.reqStat]||0)>=s.reqVal); }
function fullSkillList(p){
  return (SKILLS[p.cls]||[]).map(s=>({id:s.id,name:s.name,icon:s.icon,mp:s.mp,cd:s.cd,unlockLv:s.unlockLv,
    reqStat:s.reqStat||null,reqVal:s.reqVal||0,desc:s.desc||'',scaleKey:s.scaleKey||null,type:s.type,
    range:s.range||s.dist||s.rangeOut||s.dashDist||0,radius:s.radius||s.triggerR||0,len:s.len||0,width:s.width||0,arc:s.arc||0,chargeable:!!s.chargeable,comboNext:!!s.comboNext,channelable:!!s.channelable,
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
    if(p.cls==='blade'){ if(getStance(p)==='arcane')mpCost*=0.8; }
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
    if(bladeArcaneMode && hit){ p.x-=Math.cos(a)*14; p.y-=Math.sin(a)*14; clampPos(p); } // Phép: lùi nhẹ mỗi phát — cảm giác kite thật, khác hẳn đứng yên
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
      fxEv('phaseslash',startX,startY,15,p.x,p.y,0);
    }
  }
  else if(sk.type==='arcslash'){
    const stance=getStance(p);
    if(stance==='arcane'){
      const a=Math.atan2(p.fy,p.fx);
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgArcane+POW(p))*mul);
      bolts.push({x:p.x,y:p.y,zone:p.zone,vx:Math.cos(a)*560,vy:Math.sin(a)*560,life:sk.rangeArcane/560,dmg,curDmg:dmg,owner:id,hue:270,kind:'bolt',r:7});
      p.arcane=Math.min(100,(p.arcane||0)+8);
      fxEv('swing',p.x,p.y,270,p.fx,p.fy,0);
    } else {
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
      fxEv('swing',p.x,p.y,15,p.fx,p.fy,0);
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
      fxEv('backstep',p.x,p.y,270,p.fx,p.fy,0);
    } else {
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgBlade+POW(p))*mul*0.85);
      let swHit=0;
      for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone||swHit>=6)continue;
        if(Math.hypot(e.x-p.x,e.y-p.y)<=100){ hurtEnemy(e,dmg,id); swHit++; } }
      for(const pid2 in players){ if(pid2==id||swHit>=6)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.iframe>0||o.zone!==p.zone||zoneOf(o).safe)continue;
        if(Math.hypot(o.x-p.x,o.y-p.y)<=100){ hurtPlayer(o,dmg*PVP,id); swHit++; } }
      p.momentum=Math.min(100,(p.momentum||0)+9);
      fxEv('spinattack',p.x,p.y,15,0,0,100);
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
      fxEv('levitatenova',p.x,p.y,270,0,0,sk.radius*0.75);
    } else {
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgBlade+POW(p))*mul);
      p.iframe=Math.max(p.iframe||0,0.4); p.jumpT=0.4;
      aoe(p,sk.radius,dmg,id);
      p.hp=Math.min(p.maxhp,p.hp+dmg*0.15);
      p.momentum=Math.min(100,(p.momentum||0)+15);
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
      } else {
        const dmg=applyPassiveOnHit(p,id,null,(sk.dmgBlade+POW(p))*mul);
        if(h.tp==='e')hurtEnemy(h.ent,dmg,id); else hurtPlayer(h.ent,dmg*PVP,id);
        const heal=Math.round(dmg*sk.lsBlade); p.hp=Math.min(p.maxhp,p.hp+heal); hitEv(p.x,p.y-20,heal,true);
        p.momentum=Math.min(100,(p.momentum||0)+8);
      }
    }
    fxEv('swing',p.x,p.y,stance==='arcane'?270:340,p.fx,p.fy,0);
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
    const dmg=applyPassiveOnHit(p,id,null,((stance==='arcane'?sk.dmgArcane:sk.dmgBlade)+POW(p))*mul);
    for(const eid in enemies){const e=enemies[eid]; if(e.dead||e.zone!==p.zone)continue; if(Math.hypot(e.x-p.x,e.y-p.y)>sk.radius)continue;
      hurtEnemy(e,dmg,id); e.slowT=sk.slowDur; e.slowMul=sk.slowMul;
      if(stance==='arcane') addStatus(e,'bladefrost',{dur:3,data:{bonus:0.2}}); else addStatus(e,'wound',{stacks:1,dur:6,maxStacks:5}); }
    for(const pid2 in players){ if(pid2==id)continue; const o=players[pid2]; if(!o.chosen||o.dead||o.iframe>0||o.zone!==p.zone||zoneOf(o).safe)continue; if(Math.hypot(o.x-p.x,o.y-p.y)>sk.radius)continue;
      hurtPlayer(o,dmg*PVP,id); o.slowT=sk.slowDur; o.slowMul=sk.slowMul;
      if(stance==='arcane') addStatus(o,'bladefrost',{dur:3,data:{bonus:0.2}}); else addStatus(o,'wound',{stacks:1,dur:6,maxStacks:5}); }
    if(stance==='arcane') p.arcane=Math.min(100,(p.arcane||0)+8); else p.momentum=Math.min(100,(p.momentum||0)+8);
    fxEv('nova',p.x,p.y,stance==='arcane'?270:15,0,0,sk.radius);
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
      fxEv('ring',p.x,p.y,270,0,0,sk.impactR);
    } else {
      const dmg=applyPassiveOnHit(p,id,null,(sk.dmgBlade+POW(p))*mul);
      aoe(p,sk.impactR,dmg,id);
      p.momentum=Math.min(100,(p.momentum||0)+10);
      fxEv('nova',p.x,p.y,15,0,0,sk.impactR);
    }
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
function clampPos(p){ const z=zoneOf(p); p.x=Math.max(15,Math.min(z.w-15,p.x)); p.y=Math.max(15,Math.min(z.h-15,p.y)); }
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
    const sp=(p.spd+(p.AGI||0)*2)*((p.buffT>0)?p.buffSpdMul:1)*((p.slowT>0)?p.slowMul:1)*mountSpdMul(p);
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
      if(b.pierce && b.pierce>1){ b.pierce--; b.hitSet.push(eid); b.curDmg=(b.curDmg||b.dmg)*(b.falloff||1); } else { removed=true; }
      break;}}
    if(!removed)for(const pid in players){if(pid==b.owner||b.hitSet.includes(pid))continue;const o=players[pid];if(!o.chosen||o.dead||o.iframe>0||o.zone!==b.zone||zoneOf(o).safe)continue;if(Math.hypot(o.x-b.x,o.y-b.y)<25){
      hurtPlayer(o,(((b.curDmg||b.dmg)*markBonus(o)+fireBonus(o))*arcMarkBonus(o))*PVP,b.owner);if(b.slowMul){o.slowT=b.slowDur;o.slowMul=b.slowMul;}
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
      psPublic[id]={x:r1(p.x),y:r1(p.y),fx:r2(p.fx),fy:r2(p.fy),hp:r1(p.hp),maxhp:p.maxhp,mp:r1(p.mp),maxmp:p.maxmp,hue:p.hue,dead:p.dead,lv:p.lv,cls:p.cls,zone:p.zone,bladeStance:p.bladeStance||'blade',jumpT:r2(p.jumpT||0),levitateT:r2(p.levitateT||0),braceT:r2(p.braceT||0),
        spd:r1((p.spd+(p.AGI||0)*2)*((p.buffT>0)?p.buffSpdMul:1)*mountSpdMul(p)),bcd:Math.max(0.15,p.basicCd-(p.AGI||0)*0.01),sh:(p.shieldHP>0),mt:p.mounted,pk:Math.round(p.pkScore||0),
        wound:statusStacks(p,'wound'),shred:!!getStatus(p,'shred'),counter:(p.counterT>0),warcryBuf:(p.warcryDefT>0),frenzy:(p.cls==='war'&&(p.fervor||0)>=80),marked:!!getStatus(p,'huntmark'),arcmarked:!!getStatus(p,'arcmark'),ravenmarked:!!getStatus(p,'ravenmark'),bladefrost:!!getStatus(p,'bladefrost'),windguard:(p.windguardT>0),wildhunt:(p.wildHuntT>0),decreeBuf:(p.decreeBuffT>0),decreeDebuf:(p.decreeDebuffT>0),sacrificeBuf:(p.sacrificeAtkBufT>0),soulBuf:(p.soulBufT>0),willActive:(p.commandStateT>0),
        slowed:(p.slowT>0&&(p.slowMul||1)>=0.15),rooted:(p.slowT>0&&(p.slowMul||1)<0.15)};
    }catch(err){ console.error('⚠️ Lỗi tính state công khai cho #'+id+':', err && err.message); }
  }
  const es={}; for(const eid in enemies){const e=enemies[eid];
    es[eid]={x:r1(e.x),y:r1(e.y),zone:e.zone,hp:r1(e.hp),maxhp:e.maxhp,dead:e.dead,boss:e.boss,r:e.r,
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

server.listen(PORT,()=>console.log('✅ WEBGAME v0.92 (xoay/nhảy/bay lơ lửng thật) chạy ở cổng '+PORT));
