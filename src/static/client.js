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

/* ---------------- fully-editable system prompt ---------------- */
let PROMPT_TEMPLATES = {};

async function loadPromptTemplates(){
  try{
    const r = await (await fetch("/api/prompt/templates")).json();
    PROMPT_TEMPLATES = r.templates || {};
    const saved = localStorage.getItem("ls20.olSystemPrompt");
    $("olSystemPrompt").value = saved || PROMPT_TEMPLATES[r.default] || "";
  }catch(e){ console.warn("prompt templates fetch failed", e); }
}
$("olSystemPrompt").addEventListener("input", ()=> localStorage.setItem("ls20.olSystemPrompt", $("olSystemPrompt").value));
$("olLoadTemplate").onclick = ()=>{
  const key = $("olTemplatePicker").value;
  if(!PROMPT_TEMPLATES[key]) return;
  $("olSystemPrompt").value = PROMPT_TEMPLATES[key];
  localStorage.setItem("ls20.olSystemPrompt", PROMPT_TEMPLATES[key]);
};

$("olIncludeExample").checked = localStorage.getItem("ls20.olIncludeExample") === "1";
$("olIncludeExample").addEventListener("change", ()=>
  localStorage.setItem("ls20.olIncludeExample", $("olIncludeExample").checked ? "1" : "0"));

/* ---------------- scrolling thought/action log (chat-style) ---------------- */
const QUALITY_ICON = {perfect:"🏆", good:"✓", neutral:"·", bad:"⚠", mistake:"✗", wasted:"—"};

function olLogClear(){
  $("olLog").innerHTML = '<div class="empty small">Thoughts and moves will appear here once a run starts.</div>';
}
function olLogScrollBottom(){
  const el = $("olLog");
  el.scrollTop = el.scrollHeight;
}
function olLogAddThinking(stepNum){
  const log = $("olLog");
  const empty = log.querySelector(".empty");
  if(empty) empty.remove();
  const div = document.createElement("div");
  div.className = "entry thinking";
  div.id = "olLogPending";
  div.innerHTML = `<div class="thought">⌛ step ${stepNum}: thinking…</div>`;
  log.appendChild(div);
  olLogScrollBottom();
}
function olLogResolve(stepNum, action, thought, quality){
  const div = $("olLogPending") || document.createElement("div");
  div.removeAttribute("id");
  div.className = "entry";
  const icon = QUALITY_ICON[quality] || "";
  div.innerHTML = `<div class="act">#${stepNum} ${action || "?"} ${icon}</div>` +
    (thought ? `<div class="thought">${escapeHtml(thought)}</div>` : "");
  if(!div.parentNode) $("olLog").appendChild(div);
  olLogScrollBottom();
}
function olLogError(stepNum, message){
  const div = $("olLogPending") || document.createElement("div");
  div.removeAttribute("id");
  div.className = "entry error";
  div.innerHTML = `<div class="thought">step ${stepNum} error: ${escapeHtml(message.slice(0, 200))}</div>`;
  if(!div.parentNode) $("olLog").appendChild(div);
  olLogScrollBottom();
}
function olLogNoAction(stepNum, thought){
  const div = $("olLogPending");
  if(!div) return;
  div.removeAttribute("id");
  div.className = "entry error";
  div.innerHTML = `<div class="act">#${stepNum} no valid action</div>` +
    (thought ? `<div class="thought">${escapeHtml(thought)}</div>` : "");
  olLogScrollBottom();
}

$("olStart").onclick = async ()=>{
  if(!OL.model){ alert("Vertex AI not ready — check status."); return; }
  if(LS20.isActive()) LS20.abandon();
  OL.running = true; OL.history = [];
  olLogClear();
  $("olStart").disabled = true; $("olStop").disabled = false;
  LS20.startRun(OL.model, "llm", OL.model);
  llmLoop();
};
$("olStop").onclick = ()=>{ OL.running = false; };

/* Ask Gemini (via our /api/gemini/act proxy) for one action.
   Resolves with {action, thought, raw, cost_usd}. */
async function geminiAct(state, history, temperature, sessionId){
  const res = await fetch("/api/gemini/act", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      state, history, temperature, session_id: sessionId,
      system_prompt: $("olSystemPrompt").value,
      include_example: $("olIncludeExample").checked,
    }),
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data.error || "server error");
  if(data.system_prompt_used !== undefined){
    $("olLastPrompt").textContent =
      "── SYSTEM ──\n" + data.system_prompt_used + "\n\n── USER ──\n" + data.user_prompt_used;
  }
  return data;
}

async function llmLoop(){
  const MAX_STEPS = 600;
  const temp = 0.6;
  let steps = 0, failures = 0;
  const sessionId = LS20.sessionId();

  while(OL.running && LS20.isActive() && steps < MAX_STEPS){
    const state = LS20.getState();
    let action = null, thought = "";
    olLogAddThinking(steps);

    try{
      const data = await geminiAct(state, OL.history, temp, sessionId);
      action = data.action; thought = data.thought || (data.raw || "").slice(0, 300);
      refreshUsage();
    }catch(e){
      olLogError(steps, String(e.message || e));
    }

    $("olStatus").textContent = `step ${steps} → ${action || "?"} | failures: ${failures}`;

    if(!action){
      olLogNoAction(steps, thought);
      if(++failures >= 5){
        $("olStatus").textContent = "LLM run stopped: 5 bad replies in a row.";
        break;
      }
    } else {
      failures = 0;
      const res = LS20.step(action);
      const quality = res.detail?.action_quality?.quality || "unknown";
      olLogResolve(steps, action, thought, quality);
      OL.history.push({
        action,
        result:  res.result,
        explain: res.detail?.text              || "",
        quality,
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
loadPromptTemplates();