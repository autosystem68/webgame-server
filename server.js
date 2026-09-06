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
// ---- THÚ CƯỠI — mua tại NPC (khác Đệ Tử/Pet: không săn, không nuôi), lõi là tăng tốc di chuyển ----
const MOUNTS = [
  {id:'horse', name:'🐴 Ngựa Thường', cost:500,  spdMul:1.15, hp:0,  allStat:0, desc:'+15% tốc độ'},
  {id:'elk',   name:'🦌 Nai Sừng',    cost:2000, spdMul:1.20, hp:30, allStat:0, desc:'+20% tốc độ · +30 Máu'},
  {id:'leo',   name:'🐆 Báo Đốm',     cost:4000, spdMul:1.30, hp:0,  allStat:0, desc:'+30% tốc độ (nhanh nhất)'},
  {id:'dragon',name:'🐉 Long Mã',     cost:8000, spdMul:1.22, hp:60, allStat:5, desc:'+22% tốc độ · +60 Máu · +5 mọi chỉ số'},
];
function sellValue(it){ return Math.max(2, Math.round((it.tier||1)*15 + (it.plus||0)*8)); }
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
  .sk.empty{border-style:dashed;border-color:#ffd76b88;animation:skPulse 1.8s ease-in-out infinite}
  .sk.empty .k{opacity:.5}
  @keyframes skPulse{0%,100%{box-shadow:0 3px 12px #000a;}50%{box-shadow:0 3px 16px #ffd76b70,0 0 6px #ffd76b50 inset;}}
  .basic{width:72px;height:72px;right:8px;bottom:8px;border-color:#b8514d;color:#ffd9a0}
  #sQ{width:54px;height:54px;right:112px;bottom:16px}
  #sW{width:54px;height:54px;right:99px;bottom:64px}
  #sE{width:54px;height:54px;right:64px;bottom:99px}
  #sR{width:58px;height:58px;right:14px;bottom:112px;border-color:#d9a04a}
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
    <div style="margin-top:3px;font-size:12px"><b id="lvt" style="color:#e0b062">Lv 1</b> &nbsp;·&nbsp; <span style="color:#ffd76b">🪙 <span id="gt">0</span></span> &nbsp;·&nbsp; <span style="color:#cfe0ff">⚔<span id="wt">0</span> 🛡<span id="at">0</span></span></div>
  </div>
  <div id="info"><span id="zonelbl">🏘️ Thị Trấn An Bình · An toàn</span><br><span id="bosslbl" style="color:#ffb0b0"></span><br><span id="cnt">0</span> online<br><span id="dglbl" style="color:#c77dff"></span></div>
  <div id="cluster">
    <div class="sk basic" id="sB"><span class="k">⚔</span><span class="l">THƯỜNG</span><div class="cd"></div></div>
    <div class="sk" id="sQ"><span class="k">Q</span><span class="l">LƯỚT</span><span class="m">12</span><div class="cd"></div></div>
    <div class="sk" id="sW"><span class="k">W</span><span class="l">TIA</span><span class="m">18</span><div class="cd"></div></div>
    <div class="sk" id="sE"><span class="k">E</span><span class="l">NỔ</span><span class="m">30</span><div class="cd"></div></div>
    <div class="sk" id="sR"><span class="k">R</span><span class="l">CUỒNG</span><span class="m">55</span><div class="cd"></div></div>
  </div>
  <div id="st">Đang kết nối...</div>
  <div id="ver">v0.44 · fusion + clean admin</div>
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
  hdr.textContent='Kỹ Năng đã học (chạm Q/W/E/R để trang bị vào ô đó):'; skg.appendChild(hdr);
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
var PETTYPES=[], myPets={}, myPetOwn=null, petOpen=false, myFusedT=0, myFusionCd=0;
document.getElementById('petbtn').addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();
  petOpen=!petOpen; document.getElementById('petPanel').style.display=petOpen?'flex':'none'; if(petOpen)renderPet();});
document.getElementById('petClose').addEventListener('pointerdown',function(ev){ev.preventDefault();
  petOpen=false; document.getElementById('petPanel').style.display='none';});
function renderPet(){
  var box=document.getElementById('petBody'); box.innerHTML='';
  if(!myPetOwn){
    var e=document.createElement('div'); e.className='petempty';
    e.textContent='Chưa có Đệ Tử. Hãy hạ Boss Thế Giới (Rừng Ma / Hang Băng) để có cơ hội săn được một con theo mình!';
    box.appendChild(e); return;
  }
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
  d.innerHTML='<div class="dtop">'+top+'</div><div class="drow">'+
    '<button id="dAct">'+(f.loc==='bag'?'Mặc':'Cởi')+'</button>'+
    '<button class="ench" id="dEnch" '+((maxed||poor)?'disabled':'')+'>'+
      (maxed?'Tối đa +'+MAXPLUS:'⚒️ +'+(pl+1)+' · '+cost+'🪙 '+need+'🔨 · '+rate+'%')+'</button></div>';
  document.getElementById('dAct').addEventListener('pointerdown',function(ev){ev.preventDefault();
    if(f.loc==='bag')ws.send(JSON.stringify({t:'equip',itemId:it.id}));else ws.send(JSON.stringify({t:'unequip',slot:f.slot}));});
  if(!maxed&&!poor)document.getElementById('dEnch').addEventListener('pointerdown',function(ev){ev.preventDefault();
    ws.send(JSON.stringify({t:'enchant',itemId:it.id}));});
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
  var m=JSON.parse(e.data);
  if(m.t==='welcome'){myId=m.id;document.getElementById('me').textContent='#'+m.id;}
  else if(m.t==='zones'){ ZONEDATA=m.zones||{}; }
  else if(m.t==='npcs'){ NPCLIST=m.npcs||[]; }
  else if(m.t==='pettypes'){ PETTYPES=m.types||[]; }
  else if(m.t==='mounttypes'){ MOUNTTYPES=m.types||[]; }
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
    setTimeout(function(){tt.style.opacity=0;},2600); }
  else if(m.t==='dungeon'){ document.getElementById('dglbl').textContent='🎫 Vé Mật Thất: '+m.entries+'/'+m.max; }
  else if(m.t==='state'){
    players=m.players; enemies=m.enemies; bolts=m.bolts||[]; loot=m.loot||[]; myPets=m.pets||{};
    document.getElementById('cnt').textContent=Object.keys(m.players).length;
    var me=players[myId];
    if(me){ myZone=me.zone||'town';
      myPetOwn=me.pet||null; myFusedT=me.fusedT||0; myFusionCd=me.fusionCd||0; if(petOpen)renderPet();
      var pdot=document.getElementById('petbtn'); if(pdot){ pdot.style.opacity = myPetOwn ? 1 : 0.5; }
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
      }); }
      if(invOpen){var rg=document.getElementById('rg'),rs=document.getElementById('rs');if(rg)rg.textContent=me.gold;if(rs)rs.textContent=me.stones||0;}
      myBuild.STR=me.STR||0;myBuild.VIT=me.VIT||0;myBuild.AGI=me.AGI||0;myBuild.INT=me.INT||0;
      myBuild.statPts=me.statPts||0;myBuild.skillPts=me.skillPts||0;
      if(chrOpen)renderChr(); }
  }
  else if(m.t==='skills'){ var mm=m.meta, map={b:'sB',q:'sQ',w:'sW',e:'sE',r:'sR'};
    lastSkillMeta=mm; myPassive=m.passive||null; myFull=m.full||myFull; myLoadout=m.loadout||myLoadout;
    for(var kk in map){ var el=document.getElementById(map[kk]); var d=mm[kk]; if(!el||!d)continue;
      var isEmpty=(kk!=='b' && !d.name);
      el.classList.toggle('empty', isEmpty);
      var kEl=el.querySelector('.k'); if(kEl && kk!=='b') kEl.textContent = isEmpty ? '?' : kk.toUpperCase();
      var lbl=el.querySelector('.l'); if(lbl)lbl.textContent = isEmpty ? '???' : (d.name.length>8?d.name.slice(0,8):d.name).toUpperCase();
      var mel=el.querySelector('.m'); if(mel){ if(d.mp>0){mel.style.display='';mel.textContent=d.mp;} else mel.style.display='none'; }
      SKdur[kk]=d.cd; SKmp[kk]=d.mp; }
    if(chrOpen)renderChr();
  }
  else if(m.t==='inv'){ myInv=m.inv||[]; myEquip=m.equip||{}; if(invOpen){renderInv();renderDetail();} }
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
  else if(m.t==='fx'){ var lf=(m.kind==='enchok'||m.kind==='enchfail')?0.6:0.4;
    fx.push({kind:m.kind,x:m.x,y:m.y,fx:m.fx,fy:m.fy,hue:m.hue,R:m.R||60,life:lf,max:lf});
    if(m.kind==='ring')shake=Math.max(shake,14); if(m.kind==='nova')shake=Math.max(shake,7); }
  else if(m.t==='hit'){ dmgs.push({x:m.x,y:m.y,val:m.val,life:0.7,max:0.7,foe:m.foe}); if(!m.foe)shake=Math.max(shake,5);}
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

function cast(k){ if(cd[k]>0)return; var me=players[myId];
  if(me && me.mp<SKmp[k]){ flash(k); return; }
  if(ws.readyState===1) ws.send(JSON.stringify({t:'skill',k:k}));
  cd[k]=SKdur[k];
}
function flash(k){var id={b:'sB',q:'sQ',w:'sW',e:'sE',r:'sR'}[k];var el=document.getElementById(id);
  el.animate([{transform:'translateX(-3px)'},{transform:'translateX(3px)'},{transform:'translateX(0)'}],{duration:140});}
function bindBtn(id,k){document.getElementById(id).addEventListener('pointerdown',function(ev){ev.preventDefault();ev.stopPropagation();cast(k);});}
bindBtn('sB','b');bindBtn('sQ','q');bindBtn('sW','w');bindBtn('sE','e');bindBtn('sR','r');

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

  for(var i=fx.length-1;i>=0;i--){var f=fx[i];f.life-=dt;if(f.life<=0){fx.splice(i,1);continue;}
    var t=1-f.life/f.max; ctx.globalAlpha=f.life/f.max;
    if(f.kind==='nova'||f.kind==='ring'){ctx.strokeStyle='hsl('+f.hue+',80%,65%)';ctx.lineWidth=4;
      ctx.beginPath();ctx.arc(f.x,f.y,f.R*t,0,7);ctx.stroke();}
    else if(f.kind==='swing'){ctx.strokeStyle='#ffd9a0';ctx.lineWidth=5;var a=Math.atan2(f.fy,f.fx);
      ctx.beginPath();ctx.arc(f.x,f.y,26,a-0.9,a+0.9);ctx.stroke();}
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
    var bw=en.boss?70:30;ctx.fillStyle='#000a';ctx.fillRect(en.x-bw/2,en.y-er-10,bw,en.boss?6:4);
    ctx.fillStyle=en.boss?'#e07ab8':'#d06a55';ctx.fillRect(en.x-bw/2,en.y-er-10,bw*Math.max(0,en.hp)/en.maxhp,en.boss?6:4);
    if(en.boss){ctx.fillStyle='#ffb0e0';ctx.font='bold 12px Trebuchet MS';ctx.textAlign='center';ctx.fillText('BOSS',en.x,en.y-er-16);}}

  for(var li=0;li<loot.length;li++){var it=loot[li]; if(it.zone!==myZone)continue;
    var col=it.tier>=3?'#c77dff':(it.tier>=2?'#6bd0ff':'#9fe0a0');
    var yy=it.y+Math.sin(performance.now()/300+it.id)*2;
    ctx.save();ctx.translate(it.x,yy);
    ctx.rotate(0.785);ctx.fillStyle=col;ctx.shadowColor=col;ctx.shadowBlur=12;ctx.fillRect(-7,-7,14,14);ctx.shadowBlur=0;
    ctx.strokeStyle='#fff8';ctx.lineWidth=1;ctx.strokeRect(-7,-7,14,14);ctx.restore();
    var ic={wpn:'⚔️',arm:'🛡️',hlm:'🪖',rng:'💍',glv:'🧤',boot:'🥾',neck:'📿',wing:'🪽'}[it.slot]||'❔';
    ctx.font='11px Trebuchet MS';ctx.textAlign='center';ctx.fillText(ic,it.x,yy+4);}

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
    ctx.globalAlpha=p.dead?0.25:1;
    ctx.fillStyle='hsl('+p.hue+',70%,58%)';ctx.strokeStyle='#0d0a06';ctx.lineWidth=3;
    ctx.beginPath();ctx.arc(rx,ry,15,0,7);ctx.fill();ctx.stroke();
    if(!p.dead){ctx.strokeStyle='#ffe0a0';ctx.lineWidth=3;ctx.beginPath();
      ctx.moveTo(rx,ry);ctx.lineTo(rx+ffx*22,ry+ffy*22);ctx.stroke();}
    if(id==myId){ctx.strokeStyle='#ffe0a0';ctx.lineWidth=2;ctx.beginPath();ctx.arc(rx,ry,20,0,7);ctx.stroke();}
    if(p.sh){ctx.strokeStyle='#6bc4ff';ctx.lineWidth=2;ctx.globalAlpha=0.85;ctx.beginPath();ctx.arc(rx,ry,19,0,7);ctx.stroke();ctx.globalAlpha=p.dead?0.25:1;}
    if(p.mt){ctx.save();ctx.globalAlpha=0.55;ctx.fillStyle='#5a3a1a';ctx.beginPath();ctx.ellipse(rx,ry+16,20,9,0,0,7);ctx.fill();ctx.restore();}
    ctx.fillStyle='#000a';ctx.fillRect(rx-16,ry-28,32,4);
    ctx.fillStyle='#6fce6a';ctx.fillRect(rx-16,ry-28,32*Math.max(0,p.hp)/p.maxhp,4);
    ctx.fillStyle='#e8d8b8';ctx.font='11px Trebuchet MS';ctx.textAlign='center';ctx.fillText('#'+id,rx,ry-32);
    ctx.globalAlpha=1;
  }

  ctx.textAlign='center';
  for(var g=dmgs.length-1;g>=0;g--){var dn=dmgs[g];dn.y-=42*dt;dn.life-=dt;if(dn.life<=0){dmgs.splice(g,1);continue;}
    ctx.globalAlpha=Math.max(0,dn.life/dn.max);
    ctx.font=(dn.big?'bold 22px':'bold 15px')+' Trebuchet MS';
    ctx.fillStyle=dn.gear?'#bfe0ff':(dn.gold?'#ffd76b':(dn.big?'#ffe07a':(dn.foe?'#ffe6ad':'#ff8a8a')));
    ctx.fillText(dn.val,dn.x,dn.y);}
  ctx.globalAlpha=1;

  ctx.restore(); // hết camera-space

  ctx.restore();

  if(joy.active){ctx.globalAlpha=.32;ctx.fillStyle='#000';ctx.beginPath();ctx.arc(joy.bx,joy.by,RAD,0,7);ctx.fill();
    ctx.globalAlpha=.9;ctx.strokeStyle='#e0b062';ctx.lineWidth=2;ctx.beginPath();ctx.arc(joy.bx,joy.by,RAD,0,7);ctx.stroke();
    ctx.fillStyle='#e0b062';ctx.beginPath();ctx.arc(joy.kx,joy.ky,20,0,7);ctx.fill();ctx.globalAlpha=1;}

  requestAnimationFrame(frame);
}
function updateBtns(){
  var me=players[myId];
  var map=[['sB','b'],['sQ','q'],['sW','w'],['sE','e'],['sR','r']];
  for(var i=0;i<map.length;i++){var el=document.getElementById(map[i][0]),k=map[i][1];
    el.querySelector('.cd').style.setProperty('--d',(cd[k]/SKdur[k]*360)+'deg');
    el.classList.toggle('nomana', me && SKmp[k]>0 && me.mp<SKmp[k]);}
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
    passT:0,comboN:0,comboTgt:null,spellBladeT:0,party:null,pendingInvite:null,guild:null,fervor:0,focus:0,momentum:0,arcane:0,authority:0,
    cum:{killForest:0,killCave:0,bossForest:0,bossCave:0},npcAccepted:{},npcClaimed:{},nearNpc:null,
    dungeonDate:null,dungeonEntries:3,pet:null,mounts:[],mounted:null,fusedT:0,fusionCd:0,
    basicType:'melee',basicRange:90,basicDmg:18,basicCd:0.45,basicSpd:0,basicR:6,basicKind:'melee',
    cd:{b:0,q:0,w:0,e:0,r:0}};
  ws.pid=id; sockets[id]=ws;
  ws.send(JSON.stringify({t:'welcome',id}));
  ws.send(JSON.stringify({t:'zones',zones:ZONES}));
  ws.send(JSON.stringify({t:'npcs',npcs:NPCS}));
  ws.send(JSON.stringify({t:'pettypes',types:PET_TYPES}));
  ws.send(JSON.stringify({t:'mounttypes',types:MOUNTS}));

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
    } else if(m.t==='skill'){ doSkill(id,m.k); }
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
    {id:'w1',name:'Lướt',       icon:'💨',type:'dash', mp:10,cd:2.0, unlockLv:2,  dist:155},
    {id:'w2',name:'Chém Xoáy',  icon:'🌀',type:'cone', mp:16,cd:1.1, unlockLv:3,  range:115,arc:1.05,dmg:26},
    {id:'w3',name:'Chấn Động',  icon:'💥',type:'nova', mp:28,cd:5,   unlockLv:5,  radius:135,dmg:40},
    {id:'w4',name:'Cuồng Nộ',   icon:'🔥',type:'buff', mp:55,cd:14,  unlockLv:7,  dur:6,atk:22,spdmul:1.25,radius:150,dmg:44},
    {id:'w5',name:'Khiên Gang', icon:'🛡️',type:'shield',mp:22,cd:9, unlockLv:10, amount:60,dur:5, reqStat:'VIT',reqVal:15},
    {id:'w6',name:'Hút Sinh Kiếm',icon:'🩸',type:'lifesteal',mp:18,cd:3.5,unlockLv:13,range:100,dmg:30,lsPct:0.6, reqStat:'STR',reqVal:15},
    {id:'w7',name:'Trảm Cước',  icon:'❄️',type:'slow', mp:26,cd:8,   unlockLv:16, radius:130,dmg:20,slowMul:0.5,slowDur:2.5},
    {id:'w8',name:'Xung Phong', icon:'⚡',type:'leap',  mp:30,cd:10,  unlockLv:20, dist:220,dmg:50,impactR:100},
  ],
  mage:[
    {id:'m1',name:'Dịch Chuyển',icon:'✨',type:'dash', mp:14,cd:3,   unlockLv:2,  dist:180},
    {id:'m2',name:'Cầu Lửa',    icon:'🔥',type:'proj', mp:16,cd:0.8, unlockLv:3,  count:1,dmg:42,speed:520,r:9},
    {id:'m3',name:'Tân Băng',   icon:'❄️',type:'slow', mp:30,cd:5,   unlockLv:5,  radius:145,dmg:48,slowMul:0.5,slowDur:2.5},
    {id:'m4',name:'Thiên Thạch',icon:'☄️',type:'nova', mp:60,cd:13,  unlockLv:7,  radius:215,dmg:98},
    {id:'m5',name:'Băng Trói',  icon:'🧊',type:'proj', mp:20,cd:4,   unlockLv:10, count:1,dmg:24,speed:460,r:8,slowMul:0.45,slowDur:2.5},
    {id:'m6',name:'Lá Chắn Phép',icon:'🔷',type:'shield',mp:24,cd:10,unlockLv:13, amount:70,dur:5, reqStat:'VIT',reqVal:15},
    {id:'m7',name:'Hút Hồn',    icon:'💜',type:'lifesteal',mp:20,cd:4,unlockLv:16,range:380,dmg:34,lsPct:0.55, reqStat:'INT',reqVal:20},
    {id:'m8',name:'Vô Cực Trảm',icon:'🌌',type:'proj', mp:40,cd:9,   unlockLv:20, count:1,dmg:88,speed:600,r:10},
  ],
  arc: [
    {id:'a1',name:'Lộn Né',     icon:'💨',type:'dash', mp:10,cd:2.0, unlockLv:2,  dist:150},
    {id:'a2',name:'Xuyên Tâm',  icon:'🎯',type:'proj', mp:14,cd:0.7, unlockLv:3,  count:1,dmg:36,speed:720,r:6},
    {id:'a3',name:'Mưa Tên',    icon:'🏹',type:'proj', mp:26,cd:4,   unlockLv:5,  count:5,spread:0.55,dmg:22,speed:640,r:5},
    {id:'a4',name:'Đại Xạ',     icon:'🌟',type:'proj', mp:55,cd:12,  unlockLv:7,  count:9,spread:1.1,dmg:30,speed:660,r:6},
    {id:'a5',name:'Tên Đóng Băng',icon:'🧊',type:'proj',mp:18,cd:3.5,unlockLv:10, count:1,dmg:20,speed:640,r:6,slowMul:0.5,slowDur:2.2},
    {id:'a6',name:'Loạn Tiễn Bộ',icon:'⚡',type:'leap', mp:24,cd:8,  unlockLv:13, dist:190,dmg:34,impactR:80},
    {id:'a7',name:'Tên Hút Máu',icon:'🩸',type:'lifesteal',mp:20,cd:4,unlockLv:16,range:340,dmg:32,lsPct:0.5, reqStat:'STR',reqVal:18},
    {id:'a8',name:'Né Hoàn Hảo',icon:'🌀',type:'dodge', mp:20,cd:10, unlockLv:20, dur:1.2, reqStat:'AGI',reqVal:20},
  ],
  blade:[
    {id:'b1',name:'Lướt Kiếm',  icon:'💨',type:'dash', mp:10,cd:2.0, unlockLv:2,  dist:165},
    {id:'b2',name:'Chém Phép',  icon:'⚔️',type:'cone', mp:16,cd:1.0, unlockLv:3,  range:115,arc:0.95,dmg:25},
    {id:'b3',name:'Sóng Kiếm',  icon:'🌊',type:'proj', mp:24,cd:3,   unlockLv:5,  count:3,spread:0.4,dmg:27,speed:520,r:7},
    {id:'b4',name:'Vũ Bão',     icon:'🌀',type:'nova', mp:55,cd:12,  unlockLv:7,  radius:185,dmg:82},
    {id:'b5',name:'Kiếm Hút Sinh',icon:'🩸',type:'lifesteal',mp:18,cd:3.5,unlockLv:10,range:105,dmg:28,lsPct:0.55, reqStat:'STR',reqVal:12},
    {id:'b6',name:'Hộ Thể Quyết',icon:'🛡️',type:'shield',mp:22,cd:9, unlockLv:13, amount:65,dur:5, reqStat:'INT',reqVal:15},
    {id:'b7',name:'Băng Kiếm',  icon:'❄️',type:'slow', mp:24,cd:8,   unlockLv:16, radius:120,dmg:22,slowMul:0.5,slowDur:2.5},
    {id:'b8',name:'Kiếm Phá Không',icon:'⚡',type:'leap',mp:30,cd:10,unlockLv:20, dist:210,dmg:48,impactR:95},
  ],
  // Thống Lĩnh — "Chỉ Huy" lai giữa Dark Lord (xích, áp chế) và support (1 skill hồi máu duy nhất, không phải class heal chính)
  cmd: [
    {id:'c1',name:'Lướt',       icon:'💨',type:'dash', mp:10,cd:2.2, unlockLv:2,  dist:150},
    {id:'c2',name:'Xích Trói',  icon:'⛓️',type:'proj', mp:16,cd:1.0, unlockLv:3,  count:1,dmg:30,speed:400,r:7,kind:'chain', authGain:8,slowMul:0.08,slowDur:1.4},
    {id:'c3',name:'Chữa Trị',   icon:'💚',type:'heal', mp:30,cd:7,   unlockLv:5,  radius:165,heal:60, authGain:12, reqStat:'INT',reqVal:10},
    {id:'c4',name:'Uy Lệnh',    icon:'👑',type:'buff', mp:55,cd:14,  unlockLv:7,  dur:6,atk:18,spdmul:1.2,radius:170,dmg:32, authGain:18},
    {id:'c5',name:'Giáp Hộ Vệ', icon:'🛡️',type:'shield',mp:26,cd:10,unlockLv:10, amount:55,dur:5,radius:160, authGain:10},
    {id:'c6',name:'Áp Chế',     icon:'❄️',type:'slow', mp:26,cd:8,   unlockLv:13, radius:140,dmg:18,slowMul:0.5,slowDur:2.8, authGain:10},
    {id:'c7',name:'Xích Hút Sinh',icon:'⛓️',type:'lifesteal',mp:22,cd:4,unlockLv:16,range:220,dmg:26,lsPct:0.5,kind:'chain', authGain:8, reqStat:'STR',reqVal:18},
    {id:'c8',name:'Xung Kích Chỉ Huy',icon:'⚡',type:'leap',mp:30,cd:10,unlockLv:20,dist:200,dmg:40,impactR:95, authGain:12},
    {id:'c9',name:'Xích Kéo',   icon:'🔗',type:'pull', mp:24,cd:9,   unlockLv:12, range:260,dmg:20,pullDist:150,authCost:50},
    {id:'c10',name:'Lệnh Tấn Công',icon:'📯',type:'command',mp:35,cd:16,unlockLv:18, radius:200,atkBonus:0.3,dur:6,authCost:60},
  ],
};
// ---- PASSIVE nội tại riêng từng class (LOL-signature style) ----
const PASSIVES = {
  war:  {name:'Ý Chí Sắt',  desc:'Máu <30% → giảm 20% sát thương nhận 3s (hồi sau 15s)'},
  mage: {name:'Tích Tụ Phép',desc:'Đòn skill thứ 3 liên tiếp trúng cùng mục tiêu → nổ thêm 40% dmg'},
  arc:  {name:'Sát Thủ',    desc:'Đánh thường vào mục tiêu <30% máu → x1.5 sát thương'},
  blade:{name:'Song Tu',    desc:'Skill trúng địch → đòn thường tiếp theo +50% sát thương'},
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
    reqStat:s.reqStat||null,reqVal:s.reqVal||0,
    unlocked:meetsReq(p,s), rank:(p.skRank&&p.skRank[s.id])||1}));
}
function inCone(p,t,range,arc){ const dx=t.x-p.x,dy=t.y-p.y,d=Math.hypot(dx,dy); if(d>range)return false;
  const ang=Math.atan2(dy,dx),fa=Math.atan2(p.fy,p.fx); let df=Math.abs(ang-fa); if(df>Math.PI)df=2*Math.PI-df; return df<=arc; }
function doSkill(id,k){
  const p=players[id]; if(!p||p.dead)return;
  if(k==='b'){ if(p.cd.b>0)return; p.cd.b=Math.max(0.15,p.basicCd-(p.AGI||0)*0.01); doBasic(p,id); return; }
  const sid=p.loadout&&p.loadout[k]; const sk=findSkill(p.cls,sid); if(!sk||!meetsReq(p,sk))return;
  if(p.cd[k]>0 || p.mp<sk.mp)return;
  if(sk.authCost && (p.authority||0)<sk.authCost)return;
  p.mp-=sk.mp; p.cd[k]=Math.max(0.3,sk.cd-(p.INT||0)*0.02); execSkill(p,id,sk,(p.skRank&&p.skRank[sid])||1);
}
function rankMul(rank){ return 1+(rank-1)*0.22; } // rank 1..5 → tới +88% dmg
function auraBonus(p){ // Chỉ Huy: đồng minh gần được +8% dmg từ chính người đó khi tính damage của HỌ
  if(p.cls==='cmd')return 0; // bản thân không tự buff mình qua aura
  for(const pid in players){ const o=players[pid]; if(o===p||!o.chosen||o.dead||o.cls!=='cmd')continue;
    if(Math.hypot(o.x-p.x,o.y-p.y)<150)return 0.08; }
  return 0;
}
function applyPassiveOnHit(p,id,target,dmg){
  let mul=1+auraBonus(p);
  if(p.cls==='blade' && p.spellBladeT>0){ mul*=1.5; p.spellBladeT=0; }
  return dmg*mul;
}
function doBasic(p,id){
  const hit=nearestHostile(p,id,p.basicRange);
  let dmg=p.basicDmg+POW(p);
  if(p.cls==='arc' && hit && hit.ent.hp!==undefined && hit.ent.maxhp && (hit.ent.hp/hit.ent.maxhp)<0.3) dmg*=1.5; // Sát Thủ
  if(p.basicType==='melee'){
    if(hit){const a=Math.atan2(hit.ent.y-p.y,hit.ent.x-p.x);p.fx=Math.cos(a);p.fy=Math.sin(a);
      const fd=applyPassiveOnHit(p,id,hit.ent,dmg);
      if(hit.tp==='e')hurtEnemy(hit.ent,fd,id);else hurtPlayer(hit.ent,fd*PVP,id);
      if(p.cls==='war') p.fervor=Math.min(100,(p.fervor||0)+8);
      if(p.cls==='blade') p.momentum=Math.min(100,(p.momentum||0)+6);
    }
    fxEv('swing',p.x,p.y,p.hue,p.fx,p.fy,0);
  } else {
    let a; if(hit){a=Math.atan2(hit.ent.y-p.y,hit.ent.x-p.x);p.fx=Math.cos(a);p.fy=Math.sin(a);} else {a=Math.atan2(p.fy,p.fx);}
    bolts.push({x:p.x,y:p.y,zone:p.zone,vx:Math.cos(a)*p.basicSpd,vy:Math.sin(a)*p.basicSpd,life:1.0,dmg:applyPassiveOnHit(p,id,null,dmg),owner:id,hue:p.hue,kind:p.basicKind,r:p.basicR});
    if(p.cls==='arc' && hit) p.focus=Math.min(100,(p.focus||0)+10);
  }
}
function execSkill(p,id,sk,rank){
  const mul=rankMul(rank||1);
  if(sk.type==='dash'){ p.x+=p.fx*sk.dist;p.y+=p.fy*sk.dist;clampPos(p);p.iframe=0.4;fxEv('dash',p.x,p.y,p.hue,p.fx,p.fy,0); }
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
    if(n===1){const h=nearestHostile(p,id,600); if(h){base=Math.atan2(h.ent.y-p.y,h.ent.x-p.x);p.fx=Math.cos(base);p.fy=Math.sin(base);}}
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
  else if(sk.type==='shield'){
    p.shieldHP=(sk.amount+skDmgPow(p,sk)*0.4)*mul; p.shieldT=sk.dur;
    if(sk.radius){ for(const pid in players){const o=players[pid];if(o===p||!o.chosen||o.dead)continue;
      if(Math.hypot(o.x-p.x,o.y-p.y)<sk.radius){o.shieldHP=p.shieldHP;o.shieldT=sk.dur;} } }
    if(p.cls==='blade') p.arcane=Math.min(100,(p.arcane||0)+10);
    if(p.cls==='cmd' && sk.authGain) p.authority=Math.min(100,(p.authority||0)+sk.authGain);
    fxEv('shield',p.x,p.y,195,0,0,sk.radius||70);
  }
  else if(sk.type==='lifesteal'){
    const h=nearestHostile(p,id,sk.range);
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
    if(h){ const dmg=applyPassiveOnHit(p,id,null,sk.dmg+POW(p));
      const a=Math.atan2(h.ent.y-p.y,h.ent.x-p.x);p.fx=Math.cos(a);p.fy=Math.sin(a);
      const cd=Math.min(sk.pullDist,Math.hypot(h.ent.x-p.x,h.ent.y-p.y)-40);
      if(cd>0){ h.ent.x-=Math.cos(a)*cd; h.ent.y-=Math.sin(a)*cd; }
      if(h.tp==='e'){ clampEnemyPos(h.ent); hurtEnemy(h.ent,dmg,id); } else { clampPos(h.ent); hurtPlayer(h.ent,dmg*PVP,id); }
      fxEv('dash',h.ent.x,h.ent.y,45,-p.fx,-p.fy,0);
    }
    fxEv('swing',p.x,p.y,45,p.fx,p.fy,0);
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
function hurtEnemy(e,dmg,byId){ e.hp-=dmg; e.lastHit=byId; hitEv(e.x,e.y-(e.boss?34:16),dmg,true);
  if(e.hp<=0){e.dead=true;e.respawnT=e.boss?20:1.6;
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
function POW(p){ return p.atkPow + (p.gearAtk||0) + (p.STR||0)*2 + ((p.buffT>0)?(p.buffAtk||0):0); }
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
  let ga=0,gh=0;
  for(const s of SLOTS){ const it=p.equip[s]; if(!it)continue; if(it.stat==='atk')ga+=itemVal(it); else gh+=itemVal(it); }
  const mt=p.mounted?MOUNTS.find(x=>x.id===p.mounted):null; const mHp=mt?(mt.hp||0):0;
  const fuseBonus=(p.fusedT>0 && p.pet)?p.pet.lv:0;
  p.gearAtk=ga+fuseBonus*2; p.gearHp=gh+mHp+fuseBonus*10; p.maxhp=p.baseMaxhp+gh+mHp+fuseBonus*10+(p.VIT||0)*8; if(p.hp>p.maxhp)p.hp=p.maxhp;
  p.maxmp=p.baseMaxmp+(p.INT||0)*4; if(p.mp>p.maxmp)p.mp=p.maxmp;
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
function sendInv(p,id){ sendTo(id,{t:'inv',inv:p.inv,equip:p.equip,gAtk:p.gearAtk,gHp:p.gearHp}); }
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
    gainXP(p,500000);
    if(p.pet){ p.pet.fullness=100; }
    p.dungeonEntries=DUNGEON_MAX_ENTRIES;
    sendInv(p,id);
    sendTo(id,{t:'dungeon',entries:p.dungeonEntries,max:DUNGEON_MAX_ENTRIES});
    sendTo(id,{t:'toast',text:'🛠️ Admin: đã cộng tài nguyên để test.'});
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
  if(o.shieldHP>0){ const absorb=Math.min(o.shieldHP,dmg); o.shieldHP-=absorb; dmg-=absorb; if(dmg<=0){hitEv(o.x,o.y-16,0,false);return;} }
  if(o.cls==='war'){ if(o.ironWillT>0){dmg*=0.8;} else if((o.hp/o.maxhp)<0.3 && (o.passT||0)<=0){ o.ironWillT=3; o.passT=15; dmg*=0.8; } }
  const dealt=dmg;
  o.hp-=dmg;o.hurtT=0; hitEv(o.x,o.y-16,dmg,false);
  if(o.hp<=0){o.dead=true;o.respawnT=2.5;o.hp=0;}
  if(!noReflect){ const refl=Math.min(0.3,(o.VIT||0)*0.0015);
    if(Math.random()<refl){ const rdmg=Math.round(dealt*0.35);
      if(atkPid && players[atkPid]) hurtPlayer(players[atkPid],rdmg,null,null,true);
      else if(atkEnemyObj && !atkEnemyObj.dead) hurtEnemy(atkEnemyObj,rdmg,undefined);
    } } }
function clampPos(p){ const z=zoneOf(p); p.x=Math.max(15,Math.min(z.w-15,p.x)); p.y=Math.max(15,Math.min(z.h-15,p.y)); }

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
    if(p.cls==='war' && p.fervor>0 && p.hurtT>3){ p.fervor=Math.max(0,p.fervor-6*dt); }
    if(p.cls==='arc' && p.focus>0 && p.hurtT>3){ p.focus=Math.max(0,p.focus-6*dt); }
    if(p.cls==='blade' && p.hurtT>3){ if(p.momentum>0)p.momentum=Math.max(0,p.momentum-5*dt); if(p.arcane>0)p.arcane=Math.max(0,p.arcane-5*dt); }
    p.mp=Math.min(p.maxmp,p.mp+12*dt);
    if(p.hurtT>1.5 && !p.dead)p.hp=Math.min(p.maxhp,p.hp+8*dt);
    if(p.dead){ p.respawnT-=dt; if(p.respawnT<=0){p.dead=false;p.hp=p.maxhp;p.mp=p.maxmp;p.iframe=2;p.zone='town';p.x=400+Math.random()*100;p.y=300+Math.random()*100;} continue; }
    const sp=(p.spd+(p.AGI||0)*2)*((p.buffT>0)?p.buffSpdMul:1)*((p.slowT>0)?p.slowMul:1)*mountSpdMul(p);
    p.x+=p.ix*sp*dt; p.y+=p.iy*sp*dt; clampPos(p);
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
    else if(p.fusionCd>0){ p.fusionCd=Math.max(0,p.fusionCd-dt); }
    if(p.pet){ if(p.fusedT<=0) tickPet(p,id,dt); else { p.pet.x=p.x; p.pet.y=p.y; p.pet.zone=p.zone; } }
  }
  for(const eid in enemies){const e=enemies[eid];
    if(e.dead){e.respawnT-=dt;if(e.respawnT<=0){const wasBoss=e.boss,z=e.zone;delete enemies[eid];
      if(wasBoss){ if(z==='dungeon')spawnBoss(z); } else spawnEnemy(z);}continue;}
    if(e.atk>0)e.atk-=dt; if(e.slowT>0)e.slowT-=dt;
    let tp=null,best=1e9;
    for(const id in players){const p=players[id];if(!p.chosen||p.dead||p.zone!==e.zone)continue;const d=Math.hypot(p.x-e.x,p.y-e.y);if(d<best){best=d;tp=p;}}
    const espd=e.spd*((e.slowT>0)?(e.slowMul||1):1);
    if(tp){ const reach=15+e.r; if(best>reach){const a=Math.atan2(tp.y-e.y,tp.x-e.x);e.x+=Math.cos(a)*espd*dt;e.y+=Math.sin(a)*espd*dt;}
      else if(e.atk<=0){ const a=Math.atan2(tp.y-e.y,tp.x-e.x); e.x+=Math.cos(a)*12;e.y+=Math.sin(a)*12; hurtPlayer(tp,e.dmg||6,null,e); fxEv('bite',tp.x,tp.y,0,Math.cos(a),Math.sin(a),0); e.atk=e.boss?1.4:1.0; } }
  }
  for(let i=bolts.length-1;i>=0;i--){const b=bolts[i];b.x+=b.vx*dt;b.y+=b.vy*dt;b.life-=dt;
    let hit=false; const zw=(ZONES[b.zone]||ZONES.town).w, zh=(ZONES[b.zone]||ZONES.town).h;
    for(const eid in enemies){const e=enemies[eid];if(e.dead||e.zone!==b.zone)continue;if(Math.hypot(e.x-b.x,e.y-b.y)<(e.boss?38:24)){hurtEnemy(e,b.dmg,b.owner);if(b.slowMul){e.slowT=b.slowDur;e.slowMul=b.slowMul;}hit=true;break;}}
    if(!hit)for(const pid in players){if(pid==b.owner)continue;const o=players[pid];if(!o.chosen||o.dead||o.iframe>0||o.zone!==b.zone||zoneOf(o).safe)continue;if(Math.hypot(o.x-b.x,o.y-b.y)<25){hurtPlayer(o,b.dmg*PVP,b.owner);if(b.slowMul){o.slowT=b.slowDur;o.slowMul=b.slowMul;}hit=true;break;}}
    if(hit||b.x<0||b.x>zw||b.y<0||b.y>zh||b.life<=0)bolts.splice(i,1);
  }
  for(let i=loot.length-1;i>=0;i--){const it=loot[i];it.life-=dt;
    if(it.life<=0){loot.splice(i,1);continue;}
    for(const id in players){const p=players[id];if(!p.chosen||p.dead||p.zone!==it.zone)continue;
      if(Math.hypot(p.x-it.x,p.y-it.y)<26){ pickup(p,id,it); loot.splice(i,1); break; }}
  }
  const psPublic={}; for(const id in players){const p=players[id];if(!p.chosen)continue;
    try{
      psPublic[id]={x:r1(p.x),y:r1(p.y),fx:r2(p.fx),fy:r2(p.fy),hp:r1(p.hp),maxhp:p.maxhp,mp:r1(p.mp),maxmp:p.maxmp,hue:p.hue,dead:p.dead,lv:p.lv,cls:p.cls,zone:p.zone,
        spd:r1((p.spd+(p.AGI||0)*2)*((p.buffT>0)?p.buffSpdMul:1)*mountSpdMul(p)),bcd:Math.max(0.15,p.basicCd-(p.AGI||0)*0.01),sh:(p.shieldHP>0),mt:p.mounted};
    }catch(err){ console.error('⚠️ Lỗi tính state công khai cho #'+id+':', err && err.message); }
  }
  const es={}; for(const eid in enemies){const e=enemies[eid];es[eid]={x:r1(e.x),y:r1(e.y),zone:e.zone,hp:r1(e.hp),maxhp:e.maxhp,dead:e.dead,boss:e.boss,r:e.r};}
  const bs=bolts.map(b=>({x:r1(b.x),y:r1(b.y),zone:b.zone,hue:b.hue,kind:b.kind||'bolt',r:b.r||6,a:r2(Math.atan2(b.vy,b.vx))}));
  const ls=loot.map(it=>({id:it.item.id,x:r1(it.x),y:r1(it.y),zone:it.zone,slot:it.item.slot,tier:it.item.tier}));
  const bt={}; for(const z in zoneBoss)bt[z]={phase:zoneBoss[z].phase,t:Math.ceil(zoneBoss[z].t)};
  const pd={}; for(const id in players){const p=players[id]; if(!p.chosen||!p.pet)continue;
    const pt=PET_TYPES.find(t=>t.id===p.pet.type);
    pd[id]={type:p.pet.type,icon:pt?pt.icon:'🐾',hue:pt?pt.hue:0,x:r1(p.pet.x),y:r1(p.pet.y),zone:p.pet.zone,lv:p.pet.lv};}
  // Mỗi người chơi nhận: vị trí/máu công khai của MỌI người (nhẹ) + số liệu riêng (vàng/xp/stat) CHỈ của chính mình
  for(const id in players){ const p=players[id]; if(!p.chosen)continue;
    try{
      const mine=Object.assign({},psPublic[id],{gold:p.gold,stones:p.stones,xp:p.xp,xpNext:p.xpNext,gAtk:p.gearAtk,gHp:p.gearHp,
        STR:p.STR,VIT:p.VIT,AGI:p.AGI,INT:p.INT,statPts:p.statPts,skillPts:p.skillPts,res:resourceInfo(p),
        pet:p.pet?{type:p.pet.type,lv:p.pet.lv,xp:p.pet.xp,xpNext:p.pet.xpNext,fullness:Math.round(p.pet.fullness)}:null,
        fusedT:Math.round(p.fusedT||0),fusionCd:Math.round(p.fusionCd||0)});
      const psOut=Object.assign({},psPublic,{[id]:mine});
      sendTo(id,{t:'state',players:psOut,enemies:es,bolts:bs,loot:ls,bossTimers:bt,pets:pd});
    }catch(err){ console.error('⚠️ Lỗi gửi state cho #'+id+' (đã chặn, không ảnh hưởng người khác):', err && err.message); }
  }
 }catch(tickErr){ console.error('⚠️ Lỗi trong vòng lặp chính (đã chặn, tick sau sẽ chạy lại bình thường):', tickErr && tickErr.message); }
},TICK);
function r1(v){return Math.round(v*10)/10;} function r2(v){return Math.round(v*100)/100;}

server.listen(PORT,()=>console.log('✅ WEBGAME v0.44 (fusion + clean admin) chạy ở cổng '+PORT));
