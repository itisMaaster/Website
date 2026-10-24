const configuredApiBase = String(window.SMP_CONFIG?.apiBase || "").trim();
const API = (() => {
  if (!/^https?:\/\//i.test(configuredApiBase)) return "https://api.itsmaaster.xyz/api/v1";
  const base = configuredApiBase.replace(/\/+$/, "");
  return /\/api\/v1$/i.test(base) ? base : `${base}/api/v1`;
})();
const app = document.querySelector("#admin-app");
let adminToken = ""; // memory only: never saved to localStorage or cookies
let toastTimer;
let activeTab = "overview";
const TABS = [
  ["overview", "Overview"], ["players", "Players"], ["announcements", "Announcements"],
  ["chat", "Chat"], ["bounties", "Bounties"], ["transactions", "Transactions"],
  ["inventory", "Inventory sync"], ["settings", "Settings"], ["audit", "Audit log"]
];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (v) => v == null || !Number.isFinite(Number(v)) ? "—" : new Intl.NumberFormat().format(Number(v));
const when = (v) => v ? new Intl.DateTimeFormat(undefined, {dateStyle:"medium", timeStyle:"short"}).format(new Date(v)) : "—";
const nice = (v) => String(v || "—").replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase());
const statusTag = (s) => `<span class="queue-state status-${esc(String(s || "unknown").toLowerCase())}">${esc(nice(s))}</span>`;

async function api(path, opts = {}) {
  const headers = {
    Accept: "application/json",
    ...(opts.body ? {"Content-Type":"application/json"} : {}),
    ...(adminToken ? {Authorization:`Bearer ${adminToken}`} : {}),
    ...(opts.headers || {})
  };
  const response = await fetch(`${API}${path}`, {...opts, headers, credentials:"omit", cache:"no-store"});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Request failed (${response.status})`);
  return data;
}
function toast(message) {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = message; el.classList.add("show"); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3600);
}
function loginView(message = "") {
  app.innerHTML = `<section class="login-card"><p class="eyebrow">RESTRICTED ACCESS</p><h1>Server control room</h1><p class="muted">Sign in with the SMP admin secret configured in the API. The secret stays in this tab's memory and is never written to website files.</p><form id="login-form"><label for="admin-code">Admin access code</label><input id="admin-code" type="password" autocomplete="current-password" spellcheck="false" required><button class="button primary" type="submit">Unlock control room</button><p id="login-error" class="feedback" role="status">${esc(message)}</p></form><p class="fineprint">Use the SMP_ADMIN_TOKEN value, not the plugin HMAC secret. Keep it private.</p></section>`;
  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    const input = document.querySelector("#admin-code");
    const error = document.querySelector("#login-error");
    adminToken = input.value.trim(); button.disabled = true; error.textContent = "Checking access…";
    try { await api("/admin/ping"); await shell("overview"); }
    catch (e) { adminToken = ""; error.textContent = e.message || "Access denied."; button.disabled = false; }
  });
}
async function shell(tab = "overview") {
  activeTab = tab;
  app.innerHTML = `<header class="admin-header"><div><p>ITSMAASTER SMP / ADMIN</p><h1>Control room</h1><div class="muted">Moderation, bounty monitoring, website chat, announcements and server settings.</div></div><div class="admin-actions"><a class="button" href="/smp/">Public site</a><button class="button" id="refresh-tab" type="button">Refresh</button><button class="button" id="logout" type="button">Lock session</button></div></header><nav class="tabs admin-tabs" aria-label="Admin sections">${TABS.map(([id,label]) => `<button class="tab" type="button" data-tab="${id}" aria-selected="${id === tab}">${label}</button>`).join("")}</nav><div id="admin-content"><section class="panel notice">Loading ${esc(tab)}…</section></div>`;
  document.querySelector("#logout").addEventListener("click", () => { adminToken = ""; loginView("Admin session locked."); });
  document.querySelector("#refresh-tab").addEventListener("click", () => shell(activeTab));
  document.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => shell(button.dataset.tab)));
  const loaders = {overview: overviewTab, players: playersTab, announcements: announcementsTab, chat: chatTab, bounties: bountiesTab, transactions: transactionsTab, inventory: inventoryTab, settings: settingsTab, audit: auditTab};
  try { await loaders[tab](); }
  catch (e) { const content = document.querySelector("#admin-content"); if (content) content.innerHTML = `<section class="panel notice error"><strong>Could not load this section.</strong><p>${esc(e.message || "Unknown error")}</p><button class="button" id="retry-section" type="button">Try again</button></section>`; document.querySelector("#retry-section")?.addEventListener("click", () => shell(activeTab)); }
}
function content() { return document.querySelector("#admin-content"); }
function statCard(label, value, caption = "") { return `<article class="admin-stat"><div class="admin-stat-label">${esc(label)}</div><div class="admin-stat-value">${esc(fmt(value))}</div><div class="admin-stat-caption">${esc(caption)}</div></article>`; }
async function overviewTab() {
  const c = content();
  const d = await api("/admin/dashboard");
  const t = d.totals || {}; const server = d.server || {};
  c.innerHTML = `<section class="admin-section"><div class="section-heading"><div><p class="eyebrow">LIVE SNAPSHOT</p><h2>Server overview</h2><p class="muted">Updated ${esc(when(d.generatedAt))}. Use Refresh to request fresh counts.</p></div>${statusTag(server.status || "unavailable")}</div><div class="admin-stat-grid">${statCard("Players tracked", t.players)}${statCard("Online players", server.onlinePlayers ?? t.onlinePlayers, `of ${server.maxPlayers ?? "—"} slots`)}${statCard("Active bounties", t.activeBounties)}${statCard("Pending transactions", t.pendingTransactions)}${statCard("Hidden profiles", t.hiddenPlayers)}${statCard("Announcements live", t.activeAnnouncements)}${statCard("Delivered chat rows", t.chatMessages)}${statCard("Inventory snapshots", t.inventorySnapshots)}${statCard("Item types synced", t.catalogItems)}</div></section><section class="admin-grid"><article class="panel"><h2>Server status</h2><div class="data-list"><div><span>Name</span><strong>${esc(server.name || "itsMaaster SMP")}</strong></div><div><span>Version</span><strong>${esc(server.version || "—")}</strong></div><div><span>Edition</span><strong>${esc(server.edition || "—")}</strong></div><div><span>Heartbeat</span><strong>${esc(when(server.lastHeartbeat))}</strong></div><div><span>Last stats sync</span><strong>${esc(when(server.lastStatisticsUpdate))}</strong></div><div><span>Address</span><strong>${esc(server.address || "Not published")}</strong></div></div></article><article class="panel"><h2>Quick controls</h2><p class="muted">Pause new website bounties without deleting pending or completed records, or toggle the public chat mirror.</p><div class="quick-control"><span>Website bounty placements</span><strong>${d.settings?.bountiesEnabled ? "Enabled" : "Paused"}</strong><button class="button" id="quick-bounties" type="button">${d.settings?.bountiesEnabled ? "Pause bounties" : "Enable bounties"}</button></div><div class="quick-control"><span>Public chat mirror</span><strong>${d.settings?.mirrorChatEnabled ? "Enabled" : "Paused"}</strong><button class="button" id="quick-chat" type="button">${d.settings?.mirrorChatEnabled ? "Pause mirror" : "Enable mirror"}</button></div><p class="form-feedback" id="quick-feedback" aria-live="polite"></p></article></section>`;
  document.querySelector("#quick-bounties").addEventListener("click", () => quickSet({bountiesEnabled: !d.settings?.bountiesEnabled}));
  document.querySelector("#quick-chat").addEventListener("click", () => quickSet({mirrorChatEnabled: !d.settings?.mirrorChatEnabled}));
  async function quickSet(value) { try { await api("/admin/settings", {method:"POST", body:JSON.stringify(value)}); toast("Setting updated."); await shell("overview"); } catch (e) { document.querySelector("#quick-feedback").textContent = e.message; } }
}
async function playersTab() {
  const c = content();
  c.innerHTML = `<section class="panel"><div class="section-heading"><div><h2>Player directory & visibility</h2><p class="muted">Searches include hidden players. Hiding a profile only removes it from public pages/chat; existing bounty and historical data are retained.</p></div></div><form id="players-search" class="search-row"><input id="player-search" class="admin-field" maxlength="32" type="search" placeholder="Search username…"><button class="button primary" type="submit">Search</button><button class="button" id="players-reset" type="button">Reset</button></form><div id="players-results" class="table-wrap">Loading players…</div></section>`;
  document.querySelector("#players-search").addEventListener("submit", e => { e.preventDefault(); loadPlayers(document.querySelector("#player-search").value.trim()); });
  document.querySelector("#players-reset").addEventListener("click", () => { document.querySelector("#player-search").value = ""; loadPlayers(""); });
  await loadPlayers("");
}
async function loadPlayers(search = "") {
  const target = document.querySelector("#players-results"); if (!target) return;
  target.textContent = "Loading…";
  try {
    const d = await api(`/admin/players?includeHidden=1&limit=100${search ? `&search=${encodeURIComponent(search)}` : ""}`);
    target.innerHTML = d.items?.length ? `<table class="admin-table"><thead><tr><th>Player</th><th>Visibility</th><th>Kills / deaths</th><th>Online</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>${d.items.map(p => `<tr><td><strong>${esc(p.username)}</strong><small class="mono">${esc(p.uuid)}</small></td><td>${p.hidden ? statusTag("hidden") : statusTag("visible")}</td><td>${fmt(p.kills)} / ${fmt(p.deaths)}</td><td>${p.online == null ? "Unknown" : p.online ? statusTag("online") : "Offline"}</td><td>${esc(when(p.lastSeen))}</td><td>${p.hidden ? `<button class="button primary" data-unhide="${esc(p.uuid)}">Unhide</button>` : `<button class="button" data-hide="${esc(p.uuid)}">Hide profile</button>`}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No tracked players matched.</p>`;
    target.querySelectorAll("[data-hide]").forEach(b => b.addEventListener("click", async () => { if (!confirm("Hide this player from public profiles, leaderboards and future public chat? Existing chat history and bounty records will be retained.")) return; try { await api(`/admin/players/${encodeURIComponent(b.dataset.hide)}`, {method:"DELETE"}); toast("Player hidden from public pages."); await loadPlayers(search); } catch (e) { toast(e.message); } }));
    target.querySelectorAll("[data-unhide]").forEach(b => b.addEventListener("click", async () => { try { await api(`/admin/players/${encodeURIComponent(b.dataset.unhide)}/unhide`, {method:"POST", body:"{}"}); toast("Player made visible again."); await loadPlayers(search); } catch (e) { toast(e.message); } }));
  } catch (e) { target.textContent = e.message; }
}
async function announcementsTab() {
  const c = content();
  c.innerHTML = `<div class="admin-grid"><section class="panel"><h2>Publish announcement</h2><p class="muted">Announcements are public on the SMP site.</p><form id="announce-form" class="admin-form"><label class="field-label" for="announce-title">Title</label><input id="announce-title" maxlength="100" required placeholder="Server update…"><label class="field-label" for="announce-body">Message</label><textarea id="announce-body" maxlength="3000" required placeholder="Write your announcement…"></textarea><label class="inline-check"><input id="announce-pin" type="checkbox"> Pin at the top</label><button class="button primary" type="submit">Publish</button><p id="announce-feedback" class="form-feedback" role="status"></p></form></section><section class="panel"><div class="section-heading"><div><h2>Published announcements</h2><p class="muted">Edit, pin/unpin or hide published posts.</p></div><button id="refresh-announcements" class="button">Refresh</button></div><div id="announcement-list" class="list">Loading…</div></section></div>`;
  document.querySelector("#announce-form").addEventListener("submit", async e => { e.preventDefault(); const fb=document.querySelector("#announce-feedback"); const button=e.currentTarget.querySelector("button[type=submit]"); button.disabled=true; try { await api("/admin/announcements", {method:"POST", body:JSON.stringify({title:document.querySelector("#announce-title").value.trim(), body:document.querySelector("#announce-body").value.trim(), pinned:document.querySelector("#announce-pin").checked})}); e.currentTarget.reset(); fb.textContent="Announcement published."; toast("Published."); await loadAnnouncements(); } catch(err) { fb.className="form-feedback error"; fb.textContent=err.message; } finally {button.disabled=false;} });
  document.querySelector("#refresh-announcements").addEventListener("click", loadAnnouncements);
  await loadAnnouncements();
}
async function loadAnnouncements() {
  const list=document.querySelector("#announcement-list"); if(!list)return; list.textContent="Loading…";
  try { const d=await api("/announcements?limit=50"); list.innerHTML=d.items?.length ? d.items.map(item=>`<article class="list-item"><div class="list-meta"><time>${esc(when(item.createdAt))}</time><span>${item.pinned ? statusTag("pinned") : ""}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.body)}</p><div class="button-row"><button class="button" data-edit-announcement="${esc(item.id)}">Edit</button><button class="button danger" data-hide-announcement="${esc(item.id)}">Hide</button></div></article>`).join("") : `<p class="muted">No public announcements yet.</p>`;
    list.querySelectorAll("[data-edit-announcement]").forEach(b=>b.addEventListener("click", async()=>{ const item=d.items.find(x=>x.id===b.dataset.editAnnouncement); if(!item)return; const title=prompt("Announcement title",item.title); if(title===null)return; const body=prompt("Announcement message",item.body); if(body===null)return; const pinned=confirm("Press OK to pin this announcement. Press Cancel to leave it unpinned."); try { await api(`/admin/announcements/${encodeURIComponent(item.id)}`,{method:"POST",body:JSON.stringify({title,body,pinned})}); toast("Announcement updated."); await loadAnnouncements(); } catch(e){toast(e.message);} }));
    list.querySelectorAll("[data-hide-announcement]").forEach(b=>b.addEventListener("click",async()=>{if(!confirm("Hide this announcement from the public site?"))return;try{await api(`/admin/announcements/${encodeURIComponent(b.dataset.hideAnnouncement)}`,{method:"DELETE"});toast("Announcement hidden.");await loadAnnouncements();}catch(e){toast(e.message);}}));
  } catch(e) {list.textContent=e.message;}
}
async function chatTab() {
  const c=content(); c.innerHTML=`<div class="admin-grid"><section class="panel"><h2>Send a message to Minecraft</h2><p class="muted">The bridge queues the message and broadcasts it in-game. This does not directly edit the public feed.</p><form id="admin-chat-form" class="admin-form"><label for="admin-chat-text" class="field-label">Message</label><textarea id="admin-chat-text" maxlength="256" required placeholder="Message (up to 256 characters)…"></textarea><button class="button primary" type="submit">Queue chat message</button><p id="admin-chat-feedback" class="form-feedback" role="status"></p></form><hr class="admin-rule"><h2>Chat mirror status</h2><div id="chat-setting-status" class="notice">Loading…</div></section><section class="panel"><div class="section-heading"><div><h2>Chat history / moderation</h2><p class="muted">Delivered rows can be removed from the public feed without deleting audit history.</p></div><button class="button" id="refresh-chat">Refresh</button></div><div id="admin-chat-list" class="list">Loading…</div></section></div>`;
  document.querySelector("#admin-chat-form").addEventListener("submit",async e=>{e.preventDefault();const fb=document.querySelector("#admin-chat-feedback"),b=e.currentTarget.querySelector("button[type=submit]");b.disabled=true;try{const res=await api("/admin/chat",{method:"POST",body:JSON.stringify({message:document.querySelector("#admin-chat-text").value.trim()})});document.querySelector("#admin-chat-text").value="";fb.textContent=`Queued (${res.item?.status||"pending"}).`;toast("Message queued.");await loadAdminChat();}catch(err){fb.className="form-feedback error";fb.textContent=err.message;}finally{b.disabled=false;}});
  document.querySelector("#refresh-chat").addEventListener("click",loadAdminChat);
  await loadAdminChat();
}
async function loadAdminChat(){
 const list=document.querySelector("#admin-chat-list");if(!list)return;list.textContent="Loading…";
 try{const d=await api("/admin/chat?limit=100");document.querySelector("#chat-setting-status").innerHTML=`Public feed mirror is ${statusTag(d.mirrorChatEnabled?"enabled":"paused")}. Change it under <button class="button" type="button" id="go-settings">Settings</button>.`;
 document.querySelector("#go-settings")?.addEventListener("click",()=>shell("settings"));
 list.innerHTML=d.items?.length?d.items.map(m=>`<article class="list-item"><div class="list-meta"><span>${esc(m.username)} · ${esc(m.source)}</span><span>${esc(when(m.createdAt))} · ${statusTag(m.status)}</span></div><p>${esc(m.message)}</p>${m.status==="delivered"?`<div class="button-row"><button class="button danger" type="button" data-remove-chat="${esc(m.id)}">Remove from public feed</button></div>`:""}</article>`).join(""):`<p class="muted">No chat messages.</p>`;
 list.querySelectorAll("[data-remove-chat]").forEach(b=>b.addEventListener("click",async()=>{if(!confirm("Remove this delivered message from the public feed? This action is audited."))return;try{await api(`/admin/chat/${encodeURIComponent(b.dataset.removeChat)}`,{method:"DELETE"});toast("Message removed from public feed.");await loadAdminChat();}catch(e){toast(e.message);}}));
 }catch(e){list.textContent=e.message;}
}
async function bountiesTab(){
 const c=content(); c.innerHTML=`<section class="panel"><div class="section-heading"><div><h2>Bounty monitor</h2><p class="muted">Read-only monitoring. Bounty cancellation or payout reconciliation needs explicit item-refund safety logic, so this panel does not perform destructive changes.</p></div><div class="filter-row"><label for="bounty-status-filter">Status</label><select id="bounty-status-filter" class="admin-field"><option value="active">Active</option><option value="claimed">Claimed</option><option value="under_review">Under review</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option><option value="all">All</option></select></div></div><div id="bounty-table" class="table-wrap">Loading…</div></section>`;
 document.querySelector("#bounty-status-filter").addEventListener("change",e=>loadBounties(e.target.value)); await loadBounties("active");
}
async function loadBounties(status="active"){
 const table=document.querySelector("#bounty-table");if(!table)return;table.textContent="Loading…";
 try{const d=await api(`/admin/bounties?status=${encodeURIComponent(status)}&limit=100`);table.innerHTML=d.items?.length?`<table class="admin-table"><thead><tr><th>Target</th><th>Reward pool</th><th>Status</th><th>Contributors</th><th>Payment</th><th>Hunter</th><th>Expires</th><th>Updated</th></tr></thead><tbody>${d.items.map(b=>`<tr><td><strong>${esc(b.targetUsername || b.target?.username || "Unknown")}</strong><small class="mono">${esc(b.targetUuid || "")}</small></td><td>${fmt(b.itemAmount ?? b.totalValue)} × ${esc(b.itemMaterial || b.currency || "item")}</td><td>${statusTag(b.status)}</td><td>${fmt(b.contributorCount)}</td><td>${statusTag(b.paymentStatus || "unknown")}</td><td>${esc(b.hunterUsername || b.hunter?.username || "—")}</td><td>${esc(when(b.expiresAt))}</td><td>${esc(when(b.updatedAt))}</td></tr>`).join("")}</tbody></table><p class="muted">Showing ${fmt(d.items.length)} of ${fmt(d.total)} bounties.</p>`:`<p class="muted">No bounties for this status.</p>`;}catch(e){table.textContent=e.message;}
}
async function transactionsTab(){
 const c=content(); c.innerHTML=`<section class="panel"><div class="section-heading"><div><h2>Transaction monitor</h2><p class="muted">Placement requests and payouts, including safe error codes. This page is read-only.</p></div><div class="filter-row"><label for="tx-status">Status</label><select id="tx-status" class="admin-field"><option value="">All</option><option>requested</option><option>processing</option><option>completed</option><option>failed</option><option>manual_review</option></select><label for="tx-type">Type</label><select id="tx-type" class="admin-field"><option value="">All</option><option value="placement">Placement</option><option value="payout">Payout</option><option value="refund">Refund</option></select></div></div><div id="tx-table" class="table-wrap">Loading…</div></section>`;
 const update=()=>loadTransactions(document.querySelector("#tx-status").value,document.querySelector("#tx-type").value);document.querySelector("#tx-status").addEventListener("change",update);document.querySelector("#tx-type").addEventListener("change",update);await update();
}
async function loadTransactions(status="",type=""){
 const table=document.querySelector("#tx-table");if(!table)return;table.textContent="Loading…";const qs=new URLSearchParams({limit:"100"});if(status)qs.set("status",status);if(type)qs.set("type",type);
 try{const d=await api(`/admin/transactions?${qs}`);table.innerHTML=d.items?.length?`<table class="admin-table"><thead><tr><th>Created</th><th>Type</th><th>Player</th><th>Target</th><th>Item / amount</th><th>Status</th><th>Details</th></tr></thead><tbody>${d.items.map(t=>`<tr><td>${esc(when(t.createdAt))}</td><td>${esc(nice(t.type))}</td><td><strong>${esc(t.playerUsername||"—")}</strong><small class="mono">${esc(t.playerUuid||"")}</small></td><td>${esc(t.targetUsername||"—")}</td><td>${fmt(t.itemAmount??t.amount)} ${esc(t.itemMaterial||t.currency||"")}</td><td>${statusTag(t.status)}</td><td><small class="mono">${esc(t.id)}</small>${t.errorCode?`<br>${statusTag(t.errorCode)}`:""}</td></tr>`).join("")}</tbody></table><p class="muted">Showing ${fmt(d.items.length)} recent matches.</p>`:`<p class="muted">No matching transactions.</p>`;}catch(e){table.textContent=e.message;}
}
async function inventoryTab() {
  const c=content();
  c.innerHTML=`<section class="panel"><div class="section-heading"><div><h2>Inventory snapshot sync</h2><p class="muted">Shows freshness and item-type counts only, not exact quantities. A snapshot is taken on join/quit and refreshed periodically by the Paper bridge.</p></div><button class="button" id="refresh-inventory" type="button">Refresh</button></div><form id="inventory-search-form" class="search-row"><input id="inventory-search" class="admin-field" type="search" maxlength="32" placeholder="Find player…"><button class="button primary" type="submit">Search</button><button class="button" id="inventory-reset" type="button">Reset</button></form><div id="inventory-table" class="table-wrap">Loading…</div></section>`;
  document.querySelector("#refresh-inventory").addEventListener("click",()=>loadInventory(document.querySelector("#inventory-search").value.trim()));
  document.querySelector("#inventory-search-form").addEventListener("submit",e=>{e.preventDefault();loadInventory(document.querySelector("#inventory-search").value.trim());});
  document.querySelector("#inventory-reset").addEventListener("click",()=>{document.querySelector("#inventory-search").value="";loadInventory("");});
  await loadInventory("");
}
async function loadInventory(search="") {
  const table=document.querySelector("#inventory-table");if(!table)return;table.textContent="Loading…";
  try {
    const d=await api(`/admin/inventory-snapshots?limit=100${search?`&search=${encodeURIComponent(search)}`:""}`);
    table.innerHTML=d.items?.length?`<table class="admin-table"><thead><tr><th>Player</th><th>Presence</th><th>Visibility</th><th>Item types recorded</th><th>Snapshot time</th></tr></thead><tbody>${d.items.map(x=>`<tr><td><strong>${esc(x.username)}</strong><small class="mono">${esc(x.playerUuid)}</small></td><td>${statusTag(x.online?"online":"offline")}</td><td>${statusTag(x.hidden?"hidden":"visible")}</td><td>${fmt(x.itemTypes)}</td><td>${esc(when(x.updatedAt))}</td></tr>`).join("")}</tbody></table><p class="muted">Showing ${fmt(d.items.length)} saved inventory snapshots. Exact item counts are only checked by the API and Paper bounty processor.</p>`:`<p class="muted">No inventory snapshots yet. The player must join once after the bridge update.</p>`;
  } catch(e) {table.textContent=e.message;}
}
async function settingsTab(){
 const c=content();const d=await api("/admin/settings");c.innerHTML=`<div class="admin-grid"><section class="panel"><p class="eyebrow">PUBLIC FEED</p><h2>Chat mirror</h2><p class="muted">Controls whether public Minecraft chat is copied to itsMaaster.xyz. In-game chat itself is not disabled.</p><div class="setting-row"><div><strong>${d.mirrorChatEnabled?"Enabled":"Paused"}</strong><p class="muted">${d.mirrorChatEnabled?"New eligible public messages can be mirrored.":"Incoming messages are accepted but not added to the website feed."}</p></div><button id="toggle-chat" class="button ${d.mirrorChatEnabled?"danger":"primary"}">${d.mirrorChatEnabled?"Pause mirror":"Enable mirror"}</button></div></section><section class="panel"><p class="eyebrow">BOUNTY CONTROLS</p><h2>Website bounty placements</h2><p class="muted">Pause or resume new website requests. This does not delete existing bounties or transaction history.</p><div class="setting-row"><div><strong>${d.bountiesEnabled?"Enabled":"Paused"}</strong><p class="muted">${d.bountiesEnabled?"Linked website users can submit item-bounty requests, subject to inventory verification.":"New placement requests are blocked by the API."}</p></div><button id="toggle-bounties" class="button ${d.bountiesEnabled?"danger":"primary"}">${d.bountiesEnabled?"Pause bounties":"Enable bounties"}</button></div></section><section class="panel"><h2>Safety notes</h2><ul class="admin-notes"><li>Item bounties remain inactive until the Paper plugin confirms actual item removal.</li><li>Offline placement requests are queued until the player joins.</li><li>Hidden profiles can be restored under Players.</li><li>Do not share the admin token or plugin HMAC secret.</li></ul></section></div>`;
 document.querySelector("#toggle-chat").addEventListener("click",()=>changeSetting({mirrorChatEnabled:!d.mirrorChatEnabled}));document.querySelector("#toggle-bounties").addEventListener("click",()=>changeSetting({bountiesEnabled:!d.bountiesEnabled}));
 async function changeSetting(value){try{await api("/admin/settings",{method:"POST",body:JSON.stringify(value)});toast("Setting updated.");await shell("settings");}catch(e){toast(e.message);}}
}
async function auditTab(){
 const c=content();c.innerHTML=`<section class="panel"><div class="section-heading"><div><h2>Audit log</h2><p class="muted">Recent administrative changes and bounty actions.</p></div><button class="button" id="refresh-audit">Refresh</button></div><div id="audit-list" class="table-wrap">Loading…</div></section>`;document.querySelector("#refresh-audit").addEventListener("click",loadAudit);await loadAudit();
}
async function loadAudit(){const list=document.querySelector("#audit-list");if(!list)return;list.textContent="Loading…";try{const d=await api("/admin/audit?limit=100");list.innerHTML=d.items?.length?`<table class="admin-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Result</th></tr></thead><tbody>${d.items.map(a=>`<tr><td>${esc(when(a.createdAt))}</td><td><small class="mono">${esc(a.actorUuid||"system")}</small></td><td>${esc(nice(a.action))}</td><td>${esc(a.entityType)}<small class="mono">${esc(a.entityId||"")}</small></td><td>${esc(a.result||"—")}</td></tr>`).join("")}</tbody></table>`:`<p class="muted">No audit rows yet.</p>`;}catch(e){list.textContent=e.message;}}

loginView();
