/* client.js — server integration + Gemini (Vertex AI) LLM player loop */
"use strict";

const $ = id => document.getElementById(id);

/* ---------------- run persistence + leaderboard ---------------- */
async function refreshLeaderboard(){
  const scoped = $("lbSession").checked;
  const url = "/api/leaderboard" + (scoped ? "?session_id="+encodeURIComponent(LS20.sessionId()) : "");
  try{
    const rows = await (await fetch(url)).json();
    const tb = document.querySelector("#lb tbody"); tb.innerHTML = "";
    rows.forEach(r=>{
      const tr = document.createElement("tr");
      const name = r.player_name + (r.model ? ` <span class="small">(${escapeHtml(r.model)})</span>` : "");
      tr.innerHTML = `<td>${r.rank}</td><td>${name}</td>
        <td><span class="tag ${r.player_type}">${r.player_type}</span></td>
        <td>${r.levels_completed}/${LS20.nLevels()}</td><td>${r.total_actions}</td>
        <td>${(r.total_time_ms/1000).toFixed(1)}s</td>`;
      tb.appendChild(tr);
    });
  }catch(e){ console.warn("leaderboard fetch failed", e); }
}
function escapeHtml(s){ return String(s).replace(/[<>&]/g,m=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[m])); }

window.onRunFinished = async run => {
  try{
    await fetch("/api/runs", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(run)});
  }catch(e){ console.warn("run save failed", e); }
  refreshLeaderboard();
};

$("lbSession").addEventListener("change", refreshLeaderboard);
$("btnExport").onclick = async ()=>{
  const r = await (await fetch("/api/export", {method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({session_id: LS20.sessionId()})})).json();
  alert(r.ok ? `Saved ${r.saved} (${r.n_runs} runs) into data/` : "Export failed: "+r.error);
};

/* ---------------- Gemini (Vertex AI) LLM player ---------------- */
const OL = { running:false, history:[], model:null };

async function checkGeminiStatus(){
  const st = $("olStatus");
  try{
    const r = await (await fetch("/api/gemini/status")).json();
    if(!r.ok) throw new Error(r.error);
    OL.model = r.model;
    $("olModelLabel").textContent = `${r.model} (${r.project}/${r.location})`;
    st.textContent = "Vertex AI: ready";
    refreshUsage();
  }catch(e){
    st.textContent = "Vertex AI unreachable — " + e.message;
  }
}
$("olRefresh").onclick = checkGeminiStatus;
$("olDelay").oninput = ()=> $("olDelayVal").textContent = $("olDelay").value;

/* persist preset + custom instructions across reloads */
$("olPreset").value = localStorage.getItem("ls20.olPreset") || "standard";
$("olCustomInstructions").value = localStorage.getItem("ls20.olCustomInstructions") || "";
$("olPreset").addEventListener("change", ()=> localStorage.setItem("ls20.olPreset", $("olPreset").value));
$("olCustomInstructions").addEventListener("input", ()=> localStorage.setItem("ls20.olCustomInstructions", $("olCustomInstructions").value));

$("olStart").onclick = async ()=>{
  if(!OL.model){ alert("Vertex AI not ready — check status."); return; }
  if(LS20.isActive()) LS20.abandon();
  OL.running = true; OL.history = [];
  $("olStart").disabled = true; $("olStop").disabled = false;
  LS20.startRun(OL.model, "llm", OL.model);
  llmLoop();
};
$("olStop").onclick = ()=>{ OL.running = false; };

/* Ask Gemini (via our /api/gemini/act proxy) for one action.
   Resolves with {action, thought, raw, cost_usd}. */
async function geminiAct(state, history, temperature, sessionId){
  const thoughtEl = $("olThought");
  thoughtEl.textContent = "⌛ thinking…";
  const res = await fetch("/api/gemini/act", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      state, history, temperature, session_id: sessionId,
      preset: $("olPreset").value,
      custom_instructions: $("olCustomInstructions").value.trim() || undefined,
    }),
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data.error || "server error");
  thoughtEl.textContent = data.thought || (data.raw || "").slice(0, 300);
  return data;
}

async function llmLoop(){
  const MAX_STEPS = 600;
  const temp = 0.6;
  let steps = 0, failures = 0;
  const sessionId = LS20.sessionId();

  while(OL.running && LS20.isActive() && steps < MAX_STEPS){
    const state = LS20.getState();
    let action = null, raw = "";

    try{
      const data = await geminiAct(state, OL.history, temp, sessionId);
      action = data.action; raw = data.raw;
      refreshUsage();
    }catch(e){
      raw = String(e);
      $("olThought").textContent = "error: " + raw.slice(0, 200);
    }

    $("olStatus").textContent = `step ${steps} → ${action || "?"} | failures: ${failures}`;

    if(!action){
      if(++failures >= 5){
        $("olStatus").textContent = "LLM run stopped: 5 bad replies in a row.";
        break;
      }
    } else {
      failures = 0;
      const res = LS20.step(action);
      OL.history.push({
        action,
        result:  res.result,
        explain: res.detail?.text              || "",
        quality: res.detail?.action_quality?.quality || "unknown",
        gap:     res.detail?.gap?.total        ?? null,
        gap_desc:res.detail?.gap?.description  || "",
      });
      if(OL.history.length > 12) OL.history.shift();
      if(res.done) break;
    }
    steps++;
    const d = +$("olDelay").value;
    if(d) await new Promise(r => setTimeout(r, d));
  }

  if(LS20.isActive()) LS20.abandon();
  OL.running = false;
  $("olStart").disabled = false; $("olStop").disabled = true;
}

/* ---------------- usage/cost widget ---------------- */
async function refreshUsage(){
  try{
    const r = await (await fetch("/api/llm/usage?session_id="+encodeURIComponent(LS20.sessionId()))).json();
    $("olUsage").textContent = `${r.calls} call(s) · ${r.total_tokens} tokens · $${r.total_cost_usd.toFixed(4)} (this session)`;
  }catch(e){ /* non-critical */ }
}

/* ---------------- custom level pack (?levels=name) ---------------- */
async function maybeLoadCustomPack(){
  const name = new URLSearchParams(location.search).get("levels");
  if(!name) return;
  try{
    const pack = await (await fetch("/api/levels/"+encodeURIComponent(name))).json();
    if(pack.levels){
      LS20.loadCustomLevels(pack.levels);
      const banner = document.createElement("div");
      banner.className = "small";
      banner.style.cssText = "color:var(--accent);margin-top:6px";
      banner.textContent = `▶ custom pack loaded: ${name} (${pack.levels.length} levels). New runs use these.`;
      document.querySelector("header > div").appendChild(banner);
    }
  }catch(e){ console.warn("custom pack load failed", e); }
}

/* ---------------- boot ---------------- */
maybeLoadCustomPack();
checkGeminiStatus();
refreshLeaderboard();