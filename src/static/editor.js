/* editor.js — LS20 level editor */
"use strict";
const $ = id => document.getElementById(id);

/* tile palette: char -> {label, glyph, color} */
const TILES = {
  ".":{label:"Floor",     glyph:"",  color:"var(--floor)"},
  "#":{label:"Wall",      glyph:"",  color:"var(--wall)"},
  " ":{label:"Void",      glyph:"",  color:"var(--void)"},
  "P":{label:"Player ▶",  glyph:"▶", color:"#ffffff"},
  "D":{label:"Door",      glyph:"▣", color:"var(--accent)"},
  "R":{label:"Rotator",   glyph:"✚", color:"var(--accent)"},
  "S":{label:"Shape ◇",   glyph:"◇", color:"var(--accent2)"},
  "C":{label:"Color ▦",   glyph:"▦", color:"#c77dff"},
  "E":{label:"Pellet ●",  glyph:"●", color:"var(--good)"},
  "1":{label:"Piston ↑",  glyph:"⤒", color:"var(--bad)"},
  "2":{label:"Piston ↓",  glyph:"⤓", color:"var(--bad)"},
  "3":{label:"Piston ←",  glyph:"⇤", color:"var(--bad)"},
  "4":{label:"Piston →",  glyph:"⇥", color:"var(--bad)"},
  "a":{label:"Portal A·1", glyph:"◎", color:"#59e0d0"},
  "A":{label:"Portal A·2", glyph:"◎", color:"#59e0d0"},
  "b":{label:"Portal B·1", glyph:"◍", color:"#e0a959"},
  "B":{label:"Portal B·2", glyph:"◍", color:"#e0a959"},
};

/* ---------- pack state ---------- */
let pack = [ blankLevel("level 1") ];
let cur = 0;
let sel = "#";

function blankLevel(name){
  const W=11,H=9; const rows=[];
  for(let y=0;y<H;y++){
    let row="";
    for(let x=0;x<W;x++) row += (y===0||y===H-1||x===0||x===W-1) ? "#" : ".";
    rows.push(row);
  }
  rows[H-2] = setChar(rows[H-2], 1, "P");
  rows[1]   = setChar(rows[1], W-2, "D");
  return { name, energy:24, key:{s:0,c:1,r:0}, door:{s:0,c:1,r:0}, map:rows };
}
function setChar(s,i,c){ return s.slice(0,i)+c+s.slice(i+1); }
const L = () => pack[cur];

/* ---------- palette UI ---------- */
function buildPalette(){
  const box=$("palette"); box.innerHTML="";
  for(const [ch,t] of Object.entries(TILES)){
    const b=document.createElement("button");
    b.dataset.ch=ch; if(ch===sel) b.className="sel";
    b.innerHTML=`<span class="swatch" style="background:${t.color==='var(--floor)'?'var(--floor)':t.color==='var(--wall)'?'var(--wall)':'var(--void)'}">${t.glyph}</span>${t.label}`;
    b.onclick=()=>{ sel=ch; buildPalette(); };
    box.appendChild(b);
  }
}

/* ---------- attribute selects ---------- */
function fillSelect(el,n,fmt){ el.innerHTML=""; for(let i=0;i<n;i++){ const o=document.createElement("option"); o.value=i; o.textContent=fmt?fmt(i):i; el.appendChild(o);} }
function initAttrs(){
  for(const id of ["keyS","doorS"]) fillSelect($(id),N_SHAPES);
  for(const id of ["keyC","doorC"]) fillSelect($(id),N_COLORS);
  for(const id of ["keyR","doorR"]) fillSelect($(id),N_ROTS,i=>i*90+"°");
  ["keyS","keyC","keyR","doorS","doorC","doorR"].forEach(id=>$(id).onchange=readAttrs);
}
function loadAttrs(){
  $("keyS").value=L().key.s; $("keyC").value=L().key.c; $("keyR").value=L().key.r;
  $("doorS").value=L().door.s; $("doorC").value=L().door.c; $("doorR").value=L().door.r;
}
function readAttrs(){
  L().key={s:+$("keyS").value,c:+$("keyC").value,r:+$("keyR").value};
  L().door={s:+$("doorS").value,c:+$("doorC").value,r:+$("doorR").value};
  drawMinis(); validate();
}

/* ---------- canvas paint ---------- */
const cv=$("edCanvas"), cx=cv.getContext("2d");
function cellSize(){ const W=L().map[0].length,H=L().map.length; return Math.floor(Math.min(cv.width/W, cv.height/H)); }
function css(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function draw(){
  const rows=L().map, H=rows.length, W=rows[0].length, cs=cellSize();
  const ox=(cv.width-cs*W)/2, oy=(cv.height-cs*H)/2;
  cx.fillStyle=css("--void"); cx.fillRect(0,0,cv.width,cv.height);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const ch=rows[y][x], t=TILES[ch]||TILES["."];
    const px=ox+x*cs, py=oy+y*cs;
    let bg = ch==="#"?css("--wall"): ch===" "?css("--void"): css("--floor");
    cx.fillStyle=bg; cx.fillRect(px,py,cs-1,cs-1);
    if(ch==="D"){ cx.fillStyle="#2a2036"; cx.fillRect(px,py,cs-1,cs-1);
      cx.strokeStyle=css("--accent"); cx.lineWidth=2; cx.strokeRect(px+1,py+1,cs-3,cs-3);
      drawKeyShape(cx,px+cs*0.15,py+cs*0.15,cs*0.7,L().door.s,L().door.c,L().door.r); continue; }
    if(ch==="P"){ drawKeyShape(cx,px+cs*0.12,py+cs*0.12,cs*0.76,L().key.s,L().key.c,L().key.r); continue; }
    if(t.glyph){ cx.fillStyle=t.color.startsWith("var")?css(t.color.slice(4,-1)):t.color;
      cx.font=`${Math.floor(cs*0.6)}px monospace`; cx.textAlign="center"; cx.textBaseline="middle";
      cx.fillText(t.glyph,px+cs/2,py+cs/2+1); }
  }
  // grid lines
  cx.strokeStyle="#ffffff10"; cx.lineWidth=1;
  for(let x=0;x<=W;x++){ cx.beginPath(); cx.moveTo(ox+x*cs,oy); cx.lineTo(ox+x*cs,oy+H*cs); cx.stroke(); }
  for(let y=0;y<=H;y++){ cx.beginPath(); cx.moveTo(ox,oy+y*cs); cx.lineTo(ox+W*cs,oy+y*cs); cx.stroke(); }
}
function cellFromEvent(e){
  const rows=L().map,H=rows.length,W=rows[0].length,cs=cellSize();
  const ox=(cv.width-cs*W)/2, oy=(cv.height-cs*H)/2;
  const r=cv.getBoundingClientRect();
  const mx=(e.clientX-r.left)*(cv.width/r.width), my=(e.clientY-r.top)*(cv.height/r.height);
  const x=Math.floor((mx-ox)/cs), y=Math.floor((my-oy)/cs);
  if(x<0||y<0||x>=W||y>=H) return null;
  return {x,y};
}
function paint(x,y,ch){
  // enforce single P / single D by clearing old ones
  if(ch==="P"||ch==="D"){
    for(let yy=0;yy<L().map.length;yy++)
      L().map[yy]=L().map[yy].replace(new RegExp(ch,"g"),".");
  }
  L().map[y]=setChar(L().map[y],x,ch);
  draw(); validate();
}
let painting=false;
cv.addEventListener("mousedown",e=>{ e.preventDefault(); painting=true; const c=cellFromEvent(e); if(c) paint(c.x,c.y, e.button===2?".":sel); });
cv.addEventListener("mousemove",e=>{ if(!painting) return; const c=cellFromEvent(e); if(c) paint(c.x,c.y, sel); });
window.addEventListener("mouseup",()=>painting=false);
cv.addEventListener("contextmenu",e=>e.preventDefault());

/* ---------- mini previews ---------- */
function drawMinis(){
  for(const [id,a] of [["miniKey",L().key],["miniDoor",L().door]]){
    const c=$(id), g=c.getContext("2d"); g.fillStyle=css("--void"); g.fillRect(0,0,80,80);
    drawKeyShape(g,10,10,60,a.s,a.c,a.r);
  }
}

/* ---------- validation ---------- */
function validate(){
  const el=$("valid"); const rows=L().map; const flat=rows.join("");
  const errs=[];
  const w=rows[0].length; if(!rows.every(r=>r.length===w)) errs.push("map not rectangular");
  const nP=(flat.match(/P/g)||[]).length, nD=(flat.match(/D/g)||[]).length;
  if(nP!==1) errs.push(`need exactly 1 player start (have ${nP})`);
  if(nD!==1) errs.push(`need exactly 1 door (have ${nD})`);
  for(const p of ["a","b"]){ const n=(flat.match(new RegExp(p,"gi"))||[]).length; if(n!==0&&n!==2) errs.push(`portal ${p.toUpperCase()} needs 0 or 2 ends (have ${n})`); }
  if(L().key.s===L().door.s&&L().key.c===L().door.c&&L().key.r===L().door.r)
    errs.push("key already matches door (level trivially solved at start)");
  if(errs.length){ el.className="err"; el.textContent="⚠ "+errs.join(" · "); }
  else { el.className="ok"; el.textContent="✓ valid level"; }
  return errs.length===0;
}

/* ---------- tabs ---------- */
function buildTabs(){
  const box=$("tabs"); box.innerHTML="";
  pack.forEach((lv,i)=>{
    const b=document.createElement("button"); b.textContent=`${i+1}. ${lv.name}`;
    if(i===cur) b.className="active";
    b.onclick=()=>{ saveForm(); cur=i; loadForm(); };
    box.appendChild(b);
  });
}
function saveForm(){ L().name=$("lvName").value||L().name; L().energy=+$("lvEnergy").value||24; }
function loadForm(){
  $("lvName").value=L().name; $("lvEnergy").value=L().energy;
  $("lvW").value=L().map[0].length; $("lvH").value=L().map.length;
  loadAttrs(); buildTabs(); draw(); drawMinis(); validate();
}

/* ---------- resize / clear / border ---------- */
$("btnResize").onclick=()=>{
  const W=Math.max(3,Math.min(24,+$("lvW").value)), H=Math.max(3,Math.min(24,+$("lvH").value));
  const old=L().map, oW=old[0].length,oH=old.length; const rows=[];
  for(let y=0;y<H;y++){ let row=""; for(let x=0;x<W;x++) row += (y<oH&&x<oW)?old[y][x]:"."; rows.push(row); }
  L().map=rows; draw(); validate();
};
$("btnBorder").onclick=()=>{ const rows=L().map,H=rows.length,W=rows[0].length;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++) if(y===0||y===H-1||x===0||x===W-1) rows[y]=setChar(rows[y],x,"#");
  draw(); validate(); };
$("btnClear").onclick=()=>{ const rows=L().map,H=rows.length,W=rows[0].length;
  L().map=rows.map((r,y)=>r.split("").map((c,x)=>(y===0||y===H-1||x===0||x===W-1)?"#":".").join(""));
  draw(); validate(); };

/* ---------- pack ops ---------- */
$("btnAdd").onclick=()=>{ saveForm(); pack.push(blankLevel(`level ${pack.length+1}`)); cur=pack.length-1; loadForm(); };
$("btnDup").onclick=()=>{ saveForm(); pack.splice(cur+1,0,JSON.parse(JSON.stringify(L()))); pack[cur+1].name+=" copy"; cur++; loadForm(); };
$("btnDel").onclick=()=>{ if(pack.length===1){ alert("keep at least one level"); return; } pack.splice(cur,1); cur=Math.max(0,cur-1); loadForm(); };

/* ---------- import / export ---------- */
$("btnExport").onclick=()=>{ saveForm();
  const data={ name:$("packName").value||"custom_pack", n_levels:pack.length, levels:pack };
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=(data.name.replace(/[^A-Za-z0-9_-]/g,"_"))+".json"; a.click(); URL.revokeObjectURL(a.href); };
$("btnImport").onclick=()=>$("fileImport").click();
$("fileImport").onchange=e=>{ const f=e.target.files[0]; if(!f) return;
  const rd=new FileReader(); rd.onload=()=>{ try{
    const d=JSON.parse(rd.result); const lv=Array.isArray(d)?d:d.levels;
    if(!Array.isArray(lv)||!lv.length) throw new Error("no levels array");
    pack=lv; cur=0; if(d.name)$("packName").value=d.name; loadForm();
  }catch(err){ alert("import failed: "+err.message); } };
  rd.readAsText(f); };

/* ---------- server save / test ---------- */
$("btnSaveServer").onclick=async ()=>{ saveForm();
  if(!pack.every((_,i)=>{cur=i;return validate();})){ cur=0;loadForm(); $("serverMsg").textContent="fix validation errors first"; return; }
  cur=0; loadForm();
  const name=($("packName").value||"custom_pack").replace(/[^A-Za-z0-9_-]/g,"_");
  try{
    const r=await (await fetch("/api/levels",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({name,levels:pack})})).json();
    $("serverMsg").textContent = r.ok ? `saved data/levels/${r.name}.json (${r.n_levels} levels)` : "error: "+r.error;
  }catch(e){ $("serverMsg").textContent="save failed (is the server running?)"; }
};
$("btnTest").onclick=async ()=>{ saveForm();
  const name=($("packName").value||"custom_pack").replace(/[^A-Za-z0-9_-]/g,"_");
  try{
    const r=await (await fetch("/api/levels",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({name,levels:pack})})).json();
    if(r.ok) location.href="index.html?levels="+encodeURIComponent(name);
    else $("serverMsg").textContent="error: "+r.error;
  }catch(e){ $("serverMsg").textContent="test failed (is the server running?)"; }
};

/* ---------- boot ---------- */
buildPalette(); initAttrs(); loadForm();
