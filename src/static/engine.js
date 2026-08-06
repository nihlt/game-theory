/* LS20 LAB — Locksmith replica engine
 * Mechanics modelled on ARC-AGI-3 public task ls20:
 * key(shape,color,rotation) + changer tiles + energy budget + pellets + pistons + portals.
 * Deterministic. Emits per-action JSON trace for human & LLM runs.
 */
"use strict";

/* shape defs (SHAPES, shapeMask, N_*, COLOR_CSS, drawKeyShape) come from shapes.js */

/* ---------- tile codes ---------- */
// '#':wall '.':floor ' ':void 'D':door 'R':rotator 'S':shapechanger 'C':colorchanger
// 'E':pellet 'P':player start  '1'-'4':piston up/down/left/right  'a'/'A' 'b'/'B': portal pairs

/* ---------- levels (progressive mechanics, mirrors ls20 curve) ---------- */
const LEVELS = [
{ name:"L1 · movement + rotator", energy:24,
  key:{s:0,c:1,r:1}, door:{s:0,c:1,r:0},
  map:[
  "#########",
  "#D......#",
  "#.###.#.#",
  "#...R.#.#",
  "#.#####.#",
  "#.......#",
  "#...P...#",
  "#########"]},
{ name:"L2 · energy pellets", energy:16,
  key:{s:1,c:2,r:2}, door:{s:1,c:2,r:0},
  map:[
  "###########",
  "#.....#..D#",
  "#.###.#.###",
  "#.#E..R...#",
  "#.#.#####.#",
  "#.#.....#.#",
  "#.#####.#.#",
  "#P....E.#.#",
  "###########"]},
{ name:"L3 · key color", energy:34,
  key:{s:2,c:0,r:0}, door:{s:2,c:1,r:1},
  map:[
  "###########",
  "#P..#..C..#",
  "#.#.#.###.#",
  "#.#...#E#.#",
  "#.#####.E.#",
  "#...R...#.#",
  "###.#####.#",
  "#D..#.....#",
  "###########"]},
{ name:"L4 · pistons", energy:28,
  key:{s:3,c:1,r:0}, door:{s:3,c:1,r:2},
  map:[
  "###########",
  "#P.4.....E#",
  "#.#####.###",
  "#.#...R...#",
  "#.#.#####2#",
  "#...#..E#.#",
  "#.###.#.#.#",
  "#..R..#..D#",
  "###########"]},
{ name:"L5 · portals", energy:26,
  key:{s:0,c:3,r:0}, door:{s:1,c:3,r:1},
  map:[
  "###########",
  "#P.#..E#.a#",
  "#S.#.###.##",
  "#.##.....R#",
  "#.#..###.##",
  "#.#.#EA.#.#",
  "#.#.###.#.#",
  "#...#.R..D#",
  "###########"]},
{ name:"L6 · everything", energy:34,
  key:{s:2,c:0,r:0}, door:{s:3,c:2,r:0},
  map:[
  "#############",
  "#P..#...C#.a#",
  "#.#.#.##.#.##",
  "#.#.4.#E.#.R#",
  "#.#####.##.##",
  "#.#A..#..S#.#",
  "#.#.#.###.#.#",
  "#.#.#..R#...#",
  "#.#.###.#.#3#",
  "#...#E..#.#D#",
  "#############"]},
];

/* ---------- engine state ---------- */
const G = {
  li:0, grid:[], W:0, H:0, player:null, key:null, energy:0, energyMax:0,
  pellets:new Set(), portals:{}, pistons:{}, doorPos:null, doorReq:null,
  undoStack:[], levelActions:0, levelResets:0, levelStart:0, animShove:null,
  run:null, session:{ session_id:"sess_"+Date.now().toString(36), started_at:new Date().toISOString(), runs:[] },
  active:false,
};
const DIRS = {UP:[0,-1],DOWN:[0,1],LEFT:[-1,0],RIGHT:[1,0]};

function loadLevel(i, countReset){
  const L = LEVELS[i];
  G.li=i; G.grid = L.map.map(r=>r.split("")); G.H=G.grid.length; G.W=G.grid[0].length;
  G.pellets.clear(); G.portals={}; G.pistons={};
  for(let y=0;y<G.H;y++)for(let x=0;x<G.W;x++){
    const c=G.grid[y][x];
    if(c==='P'){ G.player={x,y}; G.grid[y][x]='.'; }
    else if(c==='E'){ G.pellets.add(x+","+y); G.grid[y][x]='.'; }
    else if(c==='D'){ G.doorPos={x,y}; }
    else if('1234'.includes(c)){ G.pistons[x+","+y]={'1':'UP','2':'DOWN','3':'LEFT','4':'RIGHT'}[c]; }
    else if(/[abAB]/.test(c)){ (G.portals[c.toLowerCase()] ||= []).push({x,y,char:c}); }
  }
  G.key={...L.key}; G.doorReq={...L.door};
  G.energy=G.energyMax=L.energy;
  G.undoStack=[];
  if(countReset){ G.levelResets++; logLine(`level reset — energy depleted`, "die"); }
  else { G.levelActions=0; G.levelResets=0; G.levelStart=performance.now(); }
  render();
}

function snapshot(){ return JSON.stringify({p:G.player,k:G.key,e:G.energy,pel:[...G.pellets]}); }
function restore(s){ const o=JSON.parse(s); G.player=o.p; G.key=o.k; G.energy=o.e; G.pellets=new Set(o.pel); }

function tileAt(x,y){
  if(x<0||y<0||x>=G.W||y>=G.H) return '#';
  if(G.pistons[x+","+y]) return 'PISTON';
  return G.grid[y][x];
}
function passable(x,y){
  const t=tileAt(x,y);
  return t!=='#' && t!==' ';
}

function enterEffects(results){
  const k = G.player.x+","+G.player.y;
  const t = G.grid[G.player.y][G.player.x];
  if(t==='R'){ G.key.r=(G.key.r+1)%N_ROTS; results.push("rotated"); }
  else if(t==='S'){ G.key.s=(G.key.s+1)%N_SHAPES; results.push("shape_changed"); }
  else if(t==='C'){ G.key.c=(G.key.c+1)%N_COLORS; results.push("color_changed"); }
  if(G.pellets.has(k)){ G.pellets.delete(k); G.energy=G.energyMax; results.push("pellet_collected"); }
  const pd = G.pistons[k];
  if(pd){ // shove until wall/special
    const [dx,dy]=DIRS[pd]; let n=0;
    while(passable(G.player.x+dx,G.player.y+dy) && tileAt(G.player.x+dx,G.player.y+dy)!=='PISTON' && n<20){
      G.player.x+=dx; G.player.y+=dy; n++;
      const t2=G.grid[G.player.y][G.player.x];
      if('RSC'.includes(t2)||G.pellets.has(G.player.x+","+G.player.y)||/[abAB]/.test(t2)||t2==='D') break;
    }
    if(n>0){ results.push("pushed_"+pd.toLowerCase()+"_"+n); enterEffects(results); return; }
  }
  if(/[abAB]/.test(t)){
    const pair = G.portals[t.toLowerCase()];
    const other = pair.find(p=>p.x!==G.player.x||p.y!==G.player.y);
    if(other){ G.player={x:other.x,y:other.y}; results.push("teleported"); }
  }
}

function keyMatches(){
  // canonical comparison: rendered mask + color must match
  const a=shapeMask(G.key.s,G.key.r), b=shapeMask(G.doorReq.s,G.doorReq.r);
  return G.key.c===G.doorReq.c && JSON.stringify(a)===JSON.stringify(b);
}
function matchDetail(){
  // which attributes line up with the door requirement (rotation compared via rendered mask)
  const shapeRotOK = JSON.stringify(shapeMask(G.key.s,G.key.r))===JSON.stringify(shapeMask(G.doorReq.s,G.doorReq.r));
  return {
    color: G.key.c===G.doorReq.c,
    shape: G.key.s===G.doorReq.s,
    rotation: G.key.r===G.doorReq.r,
    silhouette: shapeRotOK,           // shape+rotation combined (what the door actually checks)
    all: shapeRotOK && G.key.c===G.doorReq.c,
  };
}

function step(action){
  if(!G.active) return {result:["no_active_run"], done:false};
  const d = DIRS[action]; if(!d) return {result:["invalid_action"], done:false};
  G.undoStack.push(snapshot()); if(G.undoStack.length>200) G.undoStack.shift();

  // --- capture before-state for explanation ---
  const before = { pos:{...G.player}, key:{...G.key}, energy:G.energy };
  const results=[];
  const nx=G.player.x+d[0], ny=G.player.y+d[1];
  const t = tileAt(nx,ny);
  let targetTile = tileName(nx,ny);

  if(t==='#'||t===' '){ results.push("blocked"); }
  else if(t==='D'){
    if(keyMatches()){ results.push("moved","door_opened"); G.player={x:nx,y:ny}; }
    else { results.push("door_rejected"); }
  } else {
    G.player={x:nx,y:ny}; results.push("moved");
    enterEffects(results);
  }
  G.energy--; G.levelActions++;

  const detail = buildDetail(action, before, results, targetTile);
  trace(action, results, detail);
  logMove(detail);

  let done=false;
  if(results.includes("door_opened")){
    finishLevel();
    done = !G.active; // run may have completed
  } else if(G.energy<=0){
    loadLevel(G.li, true);
  }
  render();
  return {result:results, done, detail, frame:observe()};
}

const KEYNAME = k => `s${k.s}/c${k.c}/${k.r*90}°`;
function tileName(x,y){
  if(x<0||y<0||x>=G.W||y>=G.H) return "WALL";
  if(G.pistons[x+","+y]) return "PISTON_"+G.pistons[x+","+y];
  if(G.pellets.has(x+","+y)) return "PELLET";
  const c=G.grid[y][x];
  return {"#":"WALL",".":"FLOOR"," ":"VOID","D":"DOOR","R":"ROTATOR","S":"SHAPE_CHANGER","C":"COLOR_CHANGER"}[c]
    || (/[abAB]/.test(c) ? "PORTAL_"+c.toLowerCase() : c);
}

/* ── gap analysis: how many more changer visits are needed ─────────── */
function computeGap(key, req){
  const rotV   = (req.r - key.r + N_ROTS)   % N_ROTS;
  const colorV = (req.c - key.c + N_COLORS) % N_COLORS;
  const shapeV = (req.s - key.s + N_SHAPES) % N_SHAPES;
  const total  = rotV + colorV + shapeV;
  const parts  = [];
  if(rotV)   parts.push(`rotation: have ${key.r*90}°→need ${req.r*90}° (${rotV} rotator visit${rotV>1?'s':''})`);
  if(colorV) parts.push(`color: have ${key.c}→need ${req.c} (${colorV} color-changer visit${colorV>1?'s':''})`);
  if(shapeV) parts.push(`shape: have ${key.s}→need ${req.s} (${shapeV} shape-changer visit${shapeV>1?'s':''})`);
  return {
    rot_visits:   rotV,
    color_visits: colorV,
    shape_visits: shapeV,
    total,
    solved:       total === 0,
    description:  total === 0
      ? "key matches door — go directly to door"
      : parts.join("; "),
  };
}

/* ── action quality: was this move good, bad, or neutral? ──────────── */
function assessQuality(results, gapBefore, gapAfter){
  if(results.includes("door_opened"))
    return {quality:"perfect", reason:"door opened — level complete"};
  if(results.includes("door_rejected"))
    return {quality:"mistake",  reason:"tried door before key was ready — wasted move + energy"};
  if(results.includes("blocked"))
    return {quality:"wasted",   reason:"walked into wall — no progress"};
  const delta   = gapAfter.total - gapBefore.total;
  const changed = results.some(r=>["rotated","shape_changed","color_changed"].includes(r));
  if(changed){
    if(delta < 0) return {quality:"good",    reason:`changer used — gap ${gapBefore.total}→${gapAfter.total}`};
    if(delta > 0) return {quality:"bad",     reason:`over-cycled changer — gap INCREASED ${gapBefore.total}→${gapAfter.total}`};
    return          {quality:"neutral",  reason:"changer stepped, net gap unchanged (partial re-cycle)"};
  }
  if(results.includes("pellet_collected")) return {quality:"good", reason:"energy refilled"};
  if(results.includes("teleported"))       return {quality:"good", reason:"portal used"};
  if(gapBefore.solved) return {quality:"good",    reason:`key ready, navigating to door (${gapAfter.total===0?"on track":"gap still 0"})`};
  return                {quality:"neutral", reason:`floor movement — gap still ${gapAfter.total}`};
}

/* Build a structured, human-readable explanation of what one action did. */
function buildDetail(action, before, results, targetTile){
  const parts=[]; const keyChanges=[];
  if(before.key.r!==G.key.r) keyChanges.push(`rotation ${before.key.r*90}°→${G.key.r*90}°`);
  if(before.key.s!==G.key.s) keyChanges.push(`shape ${before.key.s}→${G.key.s}`);
  if(before.key.c!==G.key.c) keyChanges.push(`color ${before.key.c}→${G.key.c}`);

  if(results.includes("blocked"))
    parts.push(`tried ${action} but ${targetTile} blocks — stayed at (${before.pos.x},${before.pos.y})`);
  else if(results.includes("door_opened"))
    parts.push(`moved ${action} into the DOOR — key ${KEYNAME(G.key)} matches the requirement → OPENED`);
  else if(results.includes("door_rejected")){
    const m=matchDetail();
    const miss=[]; if(!m.silhouette) miss.push("silhouette (shape+rotation)"); if(!m.color) miss.push("color");
    parts.push(`moved ${action} onto the DOOR but it REJECTED the key — mismatch on ${miss.join(" & ")}`);
  } else if(results.includes("moved")){
    parts.push(`moved ${action} onto ${targetTile}`);
    if(results.includes("rotated")) parts.push("ROTATOR spun the key");
    if(results.includes("shape_changed")) parts.push("SHAPE_CHANGER cycled the shape");
    if(results.includes("color_changed")) parts.push("COLOR_CHANGER cycled the color");
    const push = results.find(r=>r.startsWith("pushed_"));
    if(push){ const [,dir,n]=push.split("_"); parts.push(`PISTON shoved ${n} cell(s) ${dir}`); }
    if(results.includes("teleported")) parts.push("PORTAL teleported to its pair");
    if(results.includes("pellet_collected")) parts.push("collected an ENERGY PELLET → energy refilled");
  }

  const m        = matchDetail();
  const matchStr = `match[shape+rot:${m.silhouette?"✓":"✗"} color:${m.color?"✓":"✗"}]`;
  const gapBefore = computeGap(before.key, G.doorReq);
  const gapAfter  = computeGap(G.key,      G.doorReq);
  const quality   = assessQuality(results, gapBefore, gapAfter);

  return {
    text: parts.join("; "),
    action,
    from: before.pos, to: {...G.player},
    key_before: before.key, key_after: {...G.key},
    key_changes: keyChanges,
    energy_before: before.energy, energy_after: G.energy,
    target_tile: targetTile,
    door_req: {...G.doorReq},
    match: m,
    match_summary: matchStr,
    gap_before: gapBefore,
    gap:        gapAfter,
    action_quality: quality,
    results: [...results],
  };
}

function trace(action, results, detail){
  if(!G.run) return;
  G.run.action_trace.push({
    t:             Math.round(performance.now()-G.run._t0),
    level:         G.li+1,
    action,
    result:        results,
    energy:        G.energy,
    key:           {...G.key},
    door_req:      detail.door_req,
    pos:           {...G.player},
    explain:       detail.text,
    key_changes:   detail.key_changes,
    target_tile:   detail.target_tile,
    match:         detail.match,
    gap:           detail.gap,
    action_quality: detail.action_quality,
  });
}

function logMove(d){
  const q    = d.action_quality?.quality || "";
  const qTag = {perfect:"🏆",good:"✓",neutral:"·",bad:"⚠",mistake:"✗",wasted:"—"}[q] || "";
  const cls  = d.results.includes("door_opened") ? "win"
    : (q==="mistake"||q==="bad"||d.results.includes("door_rejected")) ? "die" : "";
  const e    = `E${d.energy_after}/${G.energyMax}`;
  const gap  = d.gap ? ` gap:${d.gap.total}` : "";
  logLine(`[${G.levelActions}] ${qTag}${d.action} · ${d.text} · ${d.match_summary}${gap} · ${e}`, cls);
}
function recordLevelAttemptReset(){ /* reset accounting kept in levelResets */ }

function finishLevel(){
  const rec = { level:G.li+1, name:LEVELS[G.li].name,
    actions:G.levelActions, resets:G.levelResets,
    time_ms: Math.round(performance.now()-G.levelStart) };
  G.run.levels.push(rec);
  logLine(`✔ ${LEVELS[G.li].name} cleared — ${rec.actions} actions, ${rec.resets} resets`, "win");
  if(G.li+1 < LEVELS.length){ loadLevel(G.li+1,false); logLine(`▶ ${LEVELS[G.li].name}`, "ev"); }
  else finishRun("completed");
}

function startRun(name, type, model){
  G.run = { run_id:"run_"+Date.now().toString(36), player:{name:name||"anon", type:type||"human", model:model||null},
    started_at:new Date().toISOString(), _t0:performance.now(),
    outcome:"in_progress", levels:[], action_trace:[] };
  G.active=true;
  document.getElementById("log").innerHTML="";
  logLine(`● run started — ${name} [${type}]`, "ev");
  loadLevel(0,false);
  logLine(`▶ ${LEVELS[0].name}`, "ev");
  return G.run.run_id;
}

function finishRun(outcome){
  if(!G.run) return;
  G.run.outcome=outcome;
  G.run.ended_at=new Date().toISOString();
  G.run.total_actions = G.run.levels.reduce((a,l)=>a+l.actions,0) +
    (outcome==="completed"?0:G.levelActions);
  G.run.levels_completed = G.run.levels.length;
  G.run.total_time_ms = Math.round(performance.now()-G.run._t0);
  const pub = {...G.run, session_id:G.session.session_id}; delete pub._t0;
  G.session.runs.push(pub);
  G.active=false;
  logLine(`■ run ${outcome} — ${G.run.levels_completed}/${LEVELS.length} levels, ${G.run.total_actions} actions`, outcome==="completed"?"win":"die");
  if(window.onRunFinished) window.onRunFinished(pub);
  if(outcome==="completed") showWinDialog(pub);
}

function leaderboard(){
  return [...G.session.runs].sort((a,b)=>
    b.levels_completed-a.levels_completed || a.total_actions-b.total_actions || a.total_time_ms-b.total_time_ms);
}

/* ---------- observation for LLM harness ---------- */
function observe(){
  const grid = G.grid.map((row,y)=>row.map((c,x)=>{
    if(G.player.x===x&&G.player.y===y) return "PLAYER";
    if(G.pellets.has(x+","+y)) return "PELLET";
    if(G.pistons[x+","+y]) return "PISTON_"+G.pistons[x+","+y];
    return {"#":"WALL",".":"FLOOR"," ":"VOID","D":"DOOR","R":"ROTATOR","S":"SHAPE_CHANGER","C":"COLOR_CHANGER"}[c] || ("PORTAL_"+c.toLowerCase());
  }));
  return { level:G.li+1, level_name:LEVELS[G.li].name, grid,
    player:{...G.player}, key:{...G.key}, door_requirement:{...G.doorReq},
    energy:G.energy, energy_max:G.energyMax,
    n_shapes:N_SHAPES, n_colors:N_COLORS, n_rotations:N_ROTS,
    actions:["UP","DOWN","LEFT","RIGHT"] };
}

/* ---------- rendering ---------- */
const cv=document.getElementById("board"), cx=cv.getContext("2d");
function css(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function render(){
  if(!G.grid.length) { cx.fillStyle=css("--void"); cx.fillRect(0,0,cv.width,cv.height); return; }
  const cs = Math.floor(Math.min(cv.width/G.W, cv.height/G.H));
  const ox=(cv.width-cs*G.W)/2, oy=(cv.height-cs*G.H)/2;
  cx.fillStyle=css("--void"); cx.fillRect(0,0,cv.width,cv.height);
  for(let y=0;y<G.H;y++)for(let x=0;x<G.W;x++){
    const px=ox+x*cs, py=oy+y*cs, c=G.grid[y][x];
    if(c==='#'){ cx.fillStyle=css("--wall"); cx.fillRect(px,py,cs-1,cs-1); continue; }
    if(c===' ') continue;
    cx.fillStyle=css("--floor"); cx.fillRect(px,py,cs-1,cs-1);
    const k=x+","+y;
    if(c==='D'){ drawDoor(px,py,cs); }
    else if(c==='R'){ glyph(px,py,cs,"✚", css("--accent")); }
    else if(c==='S'){ glyph(px,py,cs,"◇", css("--accent2")); }
    else if(c==='C'){ glyph(px,py,cs,"▦", "#c77dff"); }
    else if(/[abAB]/.test(c)){ glyph(px,py,cs,"◎", "#59e0d0"); }
    if(G.pellets.has(k)){ glyph(px,py,cs,"●", css("--good")); }
    if(G.pistons[k]){ glyph(px,py,cs,{"UP":"⤒","DOWN":"⤓","LEFT":"⇤","RIGHT":"⇥"}[G.pistons[k]], css("--bad")); }
  }
  // player + carried key mini
  const px=ox+G.player.x*cs, py=oy+G.player.y*cs;
  cx.fillStyle="#ffffff22"; cx.fillRect(px,py,cs-1,cs-1);
  drawKey(cx, px+cs*0.12, py+cs*0.12, cs*0.76, G.key.s, G.key.c, G.key.r, true);
  // HUD
  document.getElementById("hudLevel").textContent=G.li+1;
  document.getElementById("hudActions").textContent=G.levelActions;
  document.getElementById("hudResets").textContent=G.levelResets;
  const pct=Math.max(0,G.energy/G.energyMax*100);
  const f=document.getElementById("energyfill");
  f.style.width=pct+"%"; f.style.background = pct>40?css("--good"):pct>15?css("--accent"):css("--bad");
  drawPreview();
}
function drawDoor(px,py,cs){
  cx.fillStyle="#2a2036"; cx.fillRect(px,py,cs-1,cs-1);
  cx.strokeStyle=css("--accent"); cx.lineWidth=2; cx.strokeRect(px+1,py+1,cs-3,cs-3);
  drawKey(cx, px+cs*0.15, py+cs*0.15, cs*0.7, G.doorReq.s, G.doorReq.c, G.doorReq.r, false);
}
function drawKey(ctx,x,y,size,s,c,r,filledBG){
  const m=shapeMask(s,r), u=size/3;
  ctx.fillStyle=COLOR_CSS(c);
  for(let yy=0;yy<3;yy++)for(let xx=0;xx<3;xx++) if(m[yy][xx]) ctx.fillRect(x+xx*u, y+yy*u, u-1, u-1);
}
function glyph(px,py,cs,ch,color){
  cx.fillStyle=color; cx.font=`${Math.floor(cs*0.62)}px monospace`;
  cx.textAlign="center"; cx.textBaseline="middle";
  cx.fillText(ch, px+cs/2, py+cs/2+1);
}
function drawPreview(){
  const kc=document.getElementById("keyPreview"), k2=kc.getContext("2d");
  k2.fillStyle=css("--void"); k2.fillRect(0,0,120,120);
  if(!G.key) return;
  drawKey(k2, 15,15,90, G.key.s, G.key.c, G.key.r);
  document.getElementById("keyDesc").textContent =
    `shape ${G.key.s} · color ${G.key.c} · rot ${G.key.r*90}°  →  door: s${G.doorReq.s} c${G.doorReq.c} ${G.doorReq.r*90}°`;
}
function esc(s){ return String(s).replace(/[<>&]/g,m=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[m])); }
function logLine(msg, cls){
  const el=document.getElementById("log");
  el.innerHTML+=`<div class="${cls||""}">${esc(msg)}</div>`; el.scrollTop=el.scrollHeight;
}
function showWinDialog(run){
  const d=document.getElementById("dlgWin");
  document.getElementById("winStats").innerHTML =
    `<b>${esc(run.player.name)}</b> <span class="tag ${run.player.type}">${run.player.type}</span><br>
     Levels: ${run.levels_completed}/${LEVELS.length}<br>
     Total actions: <b>${run.total_actions}</b><br>
     Time: ${(run.total_time_ms/1000).toFixed(1)}s<br>` +
     run.levels.map(l=>`&nbsp;&nbsp;${esc(l.name)} — ${l.actions} act, ${l.resets} rst`).join("<br>");
  d.showModal();
}

/* ---------- legend ---------- */
(function legend(){
  const items=[["#","Wall"],["D","Door (shows required key)"],["R","Rotator"],["S","Shape changer"],["C","Color changer"],["E","Energy pellet"],["3","Piston"],["a","Portal"]];
  const box=document.getElementById("legend");
  items.forEach(([code,label])=>{
    const c=document.createElement("canvas"); c.width=c.height=22;
    const g=c.getContext("2d");
    g.fillStyle=code==='#'?css("--wall"):css("--floor"); g.fillRect(0,0,22,22);
    const glyphs={D:["▣",css("--accent")],R:["✚",css("--accent")],S:["◇",css("--accent2")],C:["▦","#c77dff"],E:["●",css("--good")],"3":["⇤",css("--bad")],a:["◎","#59e0d0"]};
    if(glyphs[code]){ g.fillStyle=glyphs[code][1]; g.font="14px monospace"; g.textAlign="center"; g.textBaseline="middle"; g.fillText(glyphs[code][0],11,12); }
    box.appendChild(c);
    const l=document.createElement("div"); l.textContent=label; box.appendChild(l);
  });
})();

/* ---------- input ---------- */
document.querySelectorAll("[data-act]").forEach(b=>b.addEventListener("click",()=>step(b.dataset.act)));
document.getElementById("btnUndo").onclick=()=>undo();
document.getElementById("btnReset").onclick=()=>manualReset();
function undo(){ if(!G.active||!G.undoStack.length) return; restore(G.undoStack.pop()); G.levelActions=Math.max(0,G.levelActions-1); trace("UNDO",["undone"]); render(); }
function manualReset(){ if(!G.active) return; trace("RESET",["manual_reset"]); loadLevel(G.li,true); }
window.addEventListener("keydown",e=>{
  if(document.querySelector("dialog[open]")) return;
  const map={ArrowUp:"UP",ArrowDown:"DOWN",ArrowLeft:"LEFT",ArrowRight:"RIGHT",w:"UP",s:"DOWN",a:"LEFT",d:"RIGHT",W:"UP",S:"DOWN",A:"LEFT",D:"RIGHT"};
  if(map[e.key]){ e.preventDefault(); step(map[e.key]); }
  else if(e.key==="z"||e.key==="Z") undo();
  else if(e.key==="r"||e.key==="R") manualReset();
});

/* ---------- dialogs ---------- */
const dlg=document.getElementById("dlgStart");
document.getElementById("btnNewRun").onclick=()=>{ if(G.active && G.run){ finishRun("abandoned"); } dlg.showModal(); };
document.getElementById("btnCancel").onclick=()=>dlg.close();
document.getElementById("btnGo").onclick=()=>{
  const n=document.getElementById("inName").value.trim()||"anon";
  dlg.close(); startRun(n,"human");
};
document.getElementById("btnWinClose").onclick=()=>document.getElementById("dlgWin").close();

/* ---------- public API for LLM harnesses ---------- */
/* Replace the built-in level set with custom levels (e.g. from the editor).
   Accepts an array of {name,energy,key:{s,c,r},door:{s,c,r},map:[...]} objects,
   or a single such object. Validates shape before swapping. */
function loadCustomLevels(levels){
  const arr = Array.isArray(levels) ? levels : [levels];
  if(!arr.length) throw new Error("no levels provided");
  arr.forEach((L,i)=>{
    for(const f of ["name","energy","key","door","map"])
      if(!(f in L)) throw new Error(`level ${i+1} missing field: ${f}`);
    const w=L.map[0].length;
    if(!L.map.every(r=>r.length===w)) throw new Error(`level ${i+1} map not rectangular`);
    const flat=L.map.join("");
    if((flat.match(/P/g)||[]).length!==1) throw new Error(`level ${i+1} needs exactly one P (player start)`);
    if((flat.match(/D/g)||[]).length!==1) throw new Error(`level ${i+1} needs exactly one D (door)`);
  });
  if(G.active) finishRun("abandoned");
  LEVELS.length=0; arr.forEach(L=>LEVELS.push(L));
  document.getElementById("hudMax").textContent=LEVELS.length;
  logLine(`loaded ${LEVELS.length} custom level(s): ${arr.map(l=>l.name).join(", ")}`, "ev");
  return LEVELS.length;
}

window.LS20 = {
  startRun, step, reset:manualReset, undo,
  getState:observe,
  loadCustomLevels,
  sessionId:()=>G.session.session_id,
  nLevels:()=>LEVELS.length,
  isActive:()=>G.active,
  abandon:()=>finishRun("abandoned"),
  _debug:G,
};

render();
logLine("Press NEW RUN to begin. Manual on the right →","ev");