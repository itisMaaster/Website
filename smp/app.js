const API = String(window.SMP_CONFIG?.apiBase || "/api/v1").replace(/\/$/, "");
const BASE = "/smp";
const app = document.querySelector("#app");
const NAV = [
  ["Overview", BASE], ["Players", `${BASE}/players`], ["Leaderboards", `${BASE}/leaderboards`],
  ["Bounties", `${BASE}/bounties`], ["Weapons", `${BASE}/weapons`],
  ["Activity", `${BASE}/activity`], ["Status", `${BASE}/status`]
];
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
let routeVersion = 0;
let toastTimer;
let restoreSearchCursor = null;
let refreshTimer;
let transactionInFlight = false;

class ApiError extends Error {
  constructor(message, status = 0, code = "") { super(message); this.status = status; this.code = code; }
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: "include",
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  let body = {};
  try { body = await response.json(); } catch { /* Non-JSON error is handled below. */ }
  if (!response.ok) throw new ApiError(body.error?.message || body.message || `Request failed (${response.status})`, response.status, body.error?.code || "");
  return body;
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (value, suffix = "") => value == null || !Number.isFinite(Number(value)) ? "—" : `${number.format(Number(value))}${suffix}`;
const ratio = (kills, deaths) => !deaths || deaths < 0 ? (kills > 0 ? "N/A" : "—") : (Number(kills) / Number(deaths)).toFixed(2);
const compact = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return number.format(n);
};
const date = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "—";
const dateTime = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
const since = (value) => {
  if (!value) return "Time unavailable";
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date(value);
};
const playtime = (seconds) => {
  if (seconds == null) return "—";
  const hours = Math.floor(Number(seconds) / 3600);
  const days = Math.floor(hours / 24);
  return days ? `${days}d ${hours % 24}h` : `${hours}h`;
};
const playerPath = (player) => `${BASE}/player/${encodeURIComponent(player.uuid || player.username || "")}`;
const activeRoute = (path, current) => current === path || (path !== BASE && current.startsWith(`${path}/`));

function avatar(player, sizeClass = "") {
  const name = player?.username || "?";
  const source = player?.skinUrl || (window.SMP_CONFIG?.skinUrlTemplate && player?.uuid
    ? window.SMP_CONFIG.skinUrlTemplate.replace("{uuid}", encodeURIComponent(player.uuid)) : "");
  const img = source ? `<img loading="lazy" alt="" src="${esc(source)}" onload="this.nextElementSibling.hidden=true" onerror="this.remove()">` : "";
  return `<span class="player-avatar ${sizeClass}" aria-label="${esc(name)}">${img}<span aria-hidden="true">${esc(name.slice(0, 2).toUpperCase())}</span></span>`;
}

function statusPill(status, label) {
  const state = String(status || "unavailable").toLowerCase();
  const klass = state === "online" ? "online" : state === "offline" ? "offline" : "";
  const text = label || (state === "online" ? "Online" : state === "offline" ? "Offline" : "Unavailable");
  return `<span class="status-pill ${klass}"><i class="status-dot" aria-hidden="true"></i>${esc(text)}</span>`;
}

function shell(content, current) {
  const links = NAV.map(([label, href]) => `<a data-link href="${href}" ${activeRoute(href, current) ? 'aria-current="page"' : ""}>${label}</a>`).join("");
  return `<header class="topbar"><div class="topbar-inner">
    <a class="brand" href="https://itsmaaster.xyz" aria-label="itsMaaster home"><span class="brand-mark" aria-hidden="true">✦</span><span>itsMaaster<small>SMP / Universe</small></span></a>
    <nav class="nav" id="main-nav" aria-label="SMP navigation">${links}</nav>
    <a class="home-link" href="https://itsmaaster.xyz">↗ itsMaaster.xyz</a>
    <button class="menu-toggle" id="menu-toggle" type="button" aria-label="Open navigation" aria-expanded="false">☰</button>
  </div></header><main><div class="container">${content}</div></main>
  <footer class="footer">itsMaaster SMP by Maaster <span aria-hidden="true">·</span> Statistics appear when verified server data is available <span aria-hidden="true">·</span> <a href="https://itsmaaster.xyz">itsMaaster.xyz</a></footer><div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="true"></div>`;
}

function pageHead(kicker, title, subtitle, action = "") {
  return `<div class="page-head"><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div>${action}</div>`;
}
function sectionHead(title, link = "", href = "") {
  return `<div class="section-head"><div><p class="section-kicker">ITSMAASTER SMP</p><h2 class="section-title">${esc(title)}</h2></div>${link ? `<a data-link class="text-link" href="${href}">${esc(link)} <span aria-hidden="true">↗</span></a>` : ""}</div>`;
}
function loading(label = "Loading verified server data…") { return `<div class="loading"><span><i class="spinner" aria-hidden="true"></i>${esc(label)}</span></div>`; }
function errorBox(error) {
  const unavailable = error instanceof TypeError || error.status === 502 || error.status === 503;
  return `<div class="notice error" role="status">${unavailable ? "The SMP API is unavailable right now. Live data will appear when the backend reconnects." : esc(error.message || "Could not load this information.")}</div>`;
}
function empty(title, detail) { return `<div class="table-empty"><strong>${esc(title)}</strong><span>${esc(detail)}</span></div>`; }
function pill(status) { const name = String(status || "unavailable").toLowerCase(); return `<span class="pill ${esc(name)}">${esc(name.replaceAll("_", " "))}</span>`; }
function toast(message) {
  const region = document.querySelector("#toast-region");
  if (!region) return;
  region.innerHTML = `<div class="toast" role="status">${esc(message)}</div>`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { region.innerHTML = ""; }, 4200);
}
function bindMenu() {
  const button = document.querySelector("#menu-toggle");
  const nav = document.querySelector("#main-nav");
  button?.addEventListener("click", () => {
    const open = nav.classList.toggle("open"); button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  });
}
function navigate(path, replace = false) {
  if (replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  render();
}

document.addEventListener("click", (event) => {
  const anchor = event.target.closest("a[data-link]");
  if (!anchor || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = new URL(anchor.href, location.href);
  if (target.origin !== location.origin) return;
  event.preventDefault(); navigate(`${target.pathname}${target.search}${target.hash}`);
});
window.addEventListener("popstate", () => render());

function route() {
  let path = decodeURI(location.pathname).replace(/\/$/, "") || BASE;
  if (path === "/") path = BASE;
  if (path === `${BASE}/index.html`) path = BASE;
  if (!path.startsWith(BASE)) path = BASE;
  return path;
}

async function render() {
  const version = ++routeVersion;
  const path = route();
  if (path !== `${BASE}/players`) restoreSearchCursor = null;
  app.innerHTML = shell(`<div class="panel">${loading()}</div>`, path);
  bindMenu();
  let content;
  if (path === BASE) content = await overviewPage(version);
  else if (path === `${BASE}/players`) content = await playersPage(version);
  else if (path.startsWith(`${BASE}/player/`)) content = await playerPage(path.slice(`${BASE}/player/`.length), version);
  else if (path === `${BASE}/leaderboards`) content = await leaderboardsPage(version);
  else if (path === `${BASE}/bounties`) content = await bountiesPage(version);
  else if (path === `${BASE}/bounties/history`) content = await bountyHistoryPage(version);
  else if (path.startsWith(`${BASE}/bounties/`)) content = await bountyDetailPage(path.slice(`${BASE}/bounties/`.length), version);
  else if (path === `${BASE}/weapons`) content = await weaponsPage(version);
  else if (path === `${BASE}/activity`) content = await activityPage(version);
  else if (path === `${BASE}/status`) content = await statusPage(version);
  else content = `<div class="panel">${empty("Page not found", "Use the navigation to explore the SMP dashboard.")}</div>`;
  if (version !== routeVersion) return;
  app.innerHTML = shell(content, path);
  bindMenu(); bindPage(path, version);
  setupAutoRefresh();
  if (restoreSearchCursor != null && path === `${BASE}/players`) {
    const input = document.querySelector("#player-search");
    if (input) { input.focus({ preventScroll: true }); input.setSelectionRange(restoreSearchCursor, restoreSearchCursor); }
    restoreSearchCursor = null;
  }
}

function stat(label, value, note = "") {
  return `<div class="stat"><span class="stat-label">${esc(label)}</span><strong class="stat-value">${esc(value)}</strong>${note ? `<div class="stat-note">${esc(note)}</div>` : ""}</div>`;
}

async function overviewPage(version) {
  try {
    const data = await api("/overview");
    if (version !== routeVersion) return "";
    const server = data.server || {};
    const ip = server.address || "Server address not configured";
    const addressClass = server.address ? "address" : "address unavailable";
    const stats = data.totals || {};
    const leaders = [
      ["Most player kills", "kills", "player_kills"], ["Best killstreak", "killstreak", "best_killstreak"],
      ["Qualifying K/D", "kd", "kd_ratio"], ["Bounties claimed", "bountyClaims", "bounties_claimed"]
    ];
    const leaderMarkup = leaders.map(([label, key, field]) => {
      const player = data.leaders?.[key];
      return `<div class="panel leader-panel"><p class="section-kicker">${esc(label)}</p>${player ? `<a class="leader-row" data-link href="${playerPath(player)}"><span class="rank top">#1</span>${avatar(player)}<span class="player-name">${esc(player.username)}</span><span class="leader-value">${esc(player[field] == null ? (key === "kd" ? ratio(player.kills, player.deaths) : fmt(player.value)) : key === "kd" ? fmt(player[field]) : compact(player[field]))}</span></a>` : `<div class="empty-inline">${empty("No tracked players", "Verified leaderboard data will appear here.")}</div>`}</div>`;
    }).join("");
    return `<div class="hero-grid"><section class="hero-copy"><p class="eyebrow">ITSMAASTER SMP</p><h1>The universe is yours.</h1><p class="subtitle">Explore the players. Track the competition. Put a price on a target.</p><div class="hero-actions"><a class="button primary" data-link href="${BASE}/players">Browse players <span aria-hidden="true">↗</span></a><a class="button" data-link href="${BASE}/bounties">View bounties</a></div></section>
      <aside class="server-card" aria-label="Minecraft server connection"><div class="server-top"><div><p class="server-name">${esc(server.name || "itsMaaster SMP")}</p><p class="server-edition">${esc([server.edition, server.version].filter(Boolean).join(" · ") || "Edition and version unavailable")}</p></div>${statusPill(server.status)}</div><div class="server-divider"></div>
      <div class="server-meta"><span>Players online</span><strong>${server.onlinePlayers == null || server.maxPlayers == null ? "Unavailable" : `${fmt(server.onlinePlayers)} / ${fmt(server.maxPlayers)}`}</strong></div>
      <div class="server-meta"><span>Last heartbeat</span><strong>${server.lastHeartbeat ? esc(since(server.lastHeartbeat)) : "Unavailable"}</strong></div>
      <div class="address-row"><span class="${addressClass}" id="server-address">${esc(ip)}</span>${server.address ? `<button class="button ghost" data-copy-address="${esc(server.address)}" type="button">Copy address</button>` : ""}</div></aside></div>
      <section class="section"><div class="stats-grid">${stat("Tracked players", stats.players == null ? "—" : compact(stats.players), "Server records")}${stat("Player kills", stats.playerKills == null ? "—" : compact(stats.playerKills), "PvP · all time")}${stat("Active bounties", stats.activeBounties == null ? "—" : compact(stats.activeBounties), "Confirmed · current")}${stat("Bounty pool", stats.currency && stats.activeBountyValue != null ? `${compact(stats.activeBountyValue)} ${stats.currency}` : "—", stats.currency ? "Across active targets" : "Currency unavailable")}</div></section>
      <section class="section">${sectionHead("The Leaders", "All rankings", `${BASE}/leaderboards`)}<div class="bounty-grid leaders-grid">${leaderMarkup}</div></section>
      <section class="section">${sectionHead("Wanted Across the Universe", "Full bounty board", `${BASE}/bounties`)}${data.bounties?.length ? `<div class="bounty-grid">${data.bounties.slice(0,3).map(bountyCard).join("")}</div>` : `<div class="panel">${empty("No active bounties", "New confirmed bounty pools will appear here when they are placed in game.")}</div>`}</section>
      <section class="section">${sectionHead("Recent Discoveries", "All activity", `${BASE}/activity`)}<div class="panel activity-list">${data.activity?.length ? data.activity.slice(0,5).map(activityRow).join("") : empty("Nothing recorded yet", "Verified player and bounty activity will appear here.")}</div></section>
      <section class="section">${sectionHead("Quick access")}<div class="hero-actions"><a class="button" data-link href="${BASE}/players">Players</a><a class="button" data-link href="${BASE}/leaderboards">Leaderboards</a><a class="button" data-link href="${BASE}/bounties">Bounties</a><a class="button" data-link href="${BASE}/weapons">Weapons</a></div></section>`;
  } catch (error) {
    return `${pageHead("ITSMAASTER SMP", "The universe is yours.", "Explore the players. Track the competition. Put a price on a target.")}<div class="panel">${errorBox(error)}<p class="subtitle" style="margin-top:12px">Live server information will appear here after the API and Paper plugin are configured.</p></div>`;
  }
}

function bountyCard(item) {
  const target = item.target || { username: item.targetUsername || "Unknown player", uuid: item.targetUuid };
  const href = `${BASE}/bounties/${encodeURIComponent(item.id)}`;
  return `<a data-link class="bounty-card" href="${href}"><div class="bounty-top"><div class="bounty-target">${avatar(target)}<span><span class="bounty-name">${esc(target.username)}</span><span class="bounty-label">WANTED</span></span></div>${pill(item.status || "active")}</div><strong class="reward">${fmt(item.totalValue)}</strong><span class="reward-caption">${esc(item.currency || "Currency unavailable")} reward pool</span><div class="bounty-meta"><span>${fmt(item.contributorCount)} contributors</span><span>${esc(item.expiresAt ? `Ends ${date(item.expiresAt)}` : `Placed ${since(item.createdAt)}`)}</span></div><span class="text-link">Inspect bounty ↗</span></a>`;
}

function activityRow(item) {
  const icons = { kill: "✦", bounty_placed: "◇", bounty_claimed: "⌁", player_joined: "·", player_left: "·", milestone: "✧", weapon: "⌑" };
  const actor = item.actor || (item.actorUsername ? { username: item.actorUsername, uuid: item.actorUuid } : null);
  const target = item.target || (item.targetUsername ? { username: item.targetUsername, uuid: item.targetUuid } : null);
  const description = item.description || activityDescription(item, actor, target);
  return `<div class="activity-row"><span class="activity-mark" aria-hidden="true">${icons[item.type] || "✧"}</span><div><div class="activity-desc">${esc(description)}${actor?.username ? ` <a data-link href="${playerPath(actor)}">${esc(actor.username)}</a>` : ""}${target?.username ? ` → <a data-link href="${playerPath(target)}">${esc(target.username)}</a>` : ""}</div><div class="activity-time"><time datetime="${esc(item.createdAt || "")}">${esc(since(item.createdAt))}</time></div></div></div>`;
}
function activityDescription(item) {
  return ({ kill: "Player defeated", bounty_placed: "Bounty placed on", bounty_claimed: "Bounty claimed for", player_joined: "Player joined", player_left: "Player left", milestone: "Player reached a milestone", weapon: "Weapon record" })[item.type] || "Server activity";
}

const qs = (values) => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== "" && v != null)).toString();

async function playersPage(version, query = {}) {
  const params = new URLSearchParams(location.search);
  const search = query.search ?? params.get("search") ?? "";
  const sort = query.sort ?? params.get("sort") ?? "kills";
  const online = query.online ?? params.get("online") ?? "all";
  const page = Math.max(1, Number(query.page ?? params.get("page") ?? 1));
  try {
    const data = await api(`/players?${qs({ search, sort, online, page, limit: 20 })}`);
    if (version !== routeVersion) return "";
    return `${pageHead("DIRECTORY", "Players", "Search the UUID-linked records tracked by the server.")}
      <div class="toolbar"><label class="sr-only" for="player-search">Search players</label><input class="field" id="player-search" type="search" value="${esc(search)}" placeholder="Search a Minecraft username…" autocomplete="off"><label class="sr-only" for="player-sort">Sort players</label><select class="select" id="player-sort"><option value="kills" ${sort === "kills" ? "selected" : ""}>Most kills</option><option value="playtime" ${sort === "playtime" ? "selected" : ""}>Most playtime</option><option value="killstreak" ${sort === "killstreak" ? "selected" : ""}>Highest killstreak</option><option value="kd" ${sort === "kd" ? "selected" : ""}>Best qualifying K/D</option><option value="bountyClaims" ${sort === "bountyClaims" ? "selected" : ""}>Most bounty claims</option></select><label class="sr-only" for="player-online">Filter online status</label><select class="select" id="player-online"><option value="all" ${online === "all" ? "selected" : ""}>All tracked</option><option value="online" ${online === "online" ? "selected" : ""}>Currently online</option><option value="offline" ${online === "offline" ? "selected" : ""}>Currently offline</option></select></div>
      ${data.onlineFilterUnavailable ? `<div class="notice" style="margin-bottom:12px">Current online status is unavailable until the Paper server sends a fresh heartbeat.</div>` : ""}<div class="table-wrap"><table><thead><tr><th scope="col">Player</th><th scope="col">Status</th><th scope="col">Kills</th><th scope="col">Deaths</th><th scope="col">K/D</th><th scope="col">Playtime</th><th scope="col">Best streak</th><th scope="col">Active bounty</th></tr></thead><tbody>${data.items?.length ? data.items.map(playerRow).join("") : `<tr><td colspan="8">${empty(data.onlineFilterUnavailable ? "Online status unavailable" : search ? "No players match that search" : "No tracked players yet", data.onlineFilterUnavailable ? "This filter needs a recent server heartbeat." : search ? "Try another username." : "Player records will appear after the Paper plugin sends its first verified statistics update.")}</td></tr>`}</tbody></table></div>
      ${pagination(data, page)}`;
  } catch (error) { return `${pageHead("DIRECTORY", "Players", "Search the UUID-linked records tracked by the server.")}<div class="panel">${errorBox(error)}</div>`; }
}
function playerRow(player) {
  const status = player.online === true ? `<span class="online-label is-online">Online</span>` : player.online === false ? `<span class="online-label">Offline</span>` : `<span class="online-label">Unavailable</span>`;
  return `<tr><td><a class="table-player" data-link href="${playerPath(player)}">${avatar(player)}<span>${esc(player.username)}</span></a></td><td>${status}</td><td>${fmt(player.kills)}</td><td>${fmt(player.deaths)}</td><td>${esc(player.kd == null ? ratio(player.kills, player.deaths) : Number(player.kd).toFixed(2))}</td><td>${esc(playtime(player.playtimeSeconds))}</td><td>${fmt(player.bestStreak)}</td><td>${player.activeBountyValue == null || !player.currency ? "—" : `${fmt(player.activeBountyValue)} ${esc(player.currency)}`}</td></tr>`;
}
function pagination(data, page) {
  const total = Number(data.total || 0), limit = Number(data.limit || 20), pages = Math.max(1, Math.ceil(total / limit));
  return `<div class="pagination"><span>${total ? `Page ${page} of ${pages} · ${fmt(total)} players` : "No results"}</span><div class="page-controls"><button class="button ghost" data-page="${Math.max(1, page - 1)}" ${page <= 1 ? "disabled" : ""}>Previous</button><button class="button ghost" data-page="${Math.min(pages, page + 1)}" ${page >= pages ? "disabled" : ""}>Next</button></div></div>`;
}

async function playerPage(identity, version) {
  const page = Math.max(1, Number(new URLSearchParams(location.search).get("page") || 1));
  try {
    const data = await api(`/players/${encodeURIComponent(identity)}?page=${page}&limit=20`);
    if (version !== routeVersion) return "";
    const p = data.player || {}, s = data.statistics || p.statistics || {};
    const details = [
      ["PvP kills", fmt(s.playerKills ?? p.kills)], ["PvP deaths", fmt(s.playerDeaths ?? p.deaths)], ["K/D ratio", s.kd == null ? ratio(s.playerKills ?? p.kills, s.playerDeaths ?? p.deaths) : Number(s.kd).toFixed(2)],
      ["Best killstreak", fmt(s.bestStreak ?? p.bestStreak)], ["Current killstreak", fmt(s.currentStreak ?? p.currentStreak)], ["Playtime", playtime(s.playtimeSeconds ?? p.playtimeSeconds)],
      ["Mob kills", fmt(s.mobKills)], ["Blocks mined", fmt(s.blocksMined)], ["Distance travelled", s.distanceTravelled == null ? "—" : `${fmt(s.distanceTravelled)} blocks`],
      ["Bounties claimed", fmt(s.bountiesClaimed)], ["Rewards earned", s.bountyRewardsEarned == null ? "—" : s.currency ? `${fmt(s.bountyRewardsEarned)} ${s.currency}` : "Currency unavailable"], ["Bounty value placed", s.bountyValuePlaced == null ? "—" : s.currency ? `${fmt(s.bountyValuePlaced)} ${s.currency}` : "Currency unavailable"]
    ];
    return `${pageHead("PLAYER PROFILE", p.username || "Player", "A record built from verified server activity.")}
      <section class="profile-head">${avatar(p)}<div><div class="profile-name">${esc(p.username || "Unknown player")}</div><div class="profile-meta">${p.online == null ? "Status unavailable" : p.online ? "Online now" : "Offline"}<span>First seen ${esc(date(p.firstSeen))}</span><span>Last active ${esc(p.lastSeen ? since(p.lastSeen) : "Unavailable")}</span>${p.rank ? `<span>Season rank ${esc(p.rank)}</span>` : ""}</div></div></section>
      <div class="profile-stats">${[["PvP kills", s.playerKills ?? p.kills], ["PvP deaths", s.playerDeaths ?? p.deaths], ["K/D ratio", s.kd == null ? ratio(s.playerKills ?? p.kills, s.playerDeaths ?? p.deaths) : Number(s.kd).toFixed(2)], ["Best streak", s.bestStreak ?? p.bestStreak]].map(([label, value]) => `<div class="profile-stat"><label>${label}</label><strong>${esc(String(value ?? "—"))}</strong></div>`).join("")}</div>
      <div class="grid-2 section"><section class="panel"><h2>Statistics</h2><p class="subtitle">K/D is PvP kills ÷ PvP deaths. Zero deaths is shown as N/A.</p><div class="profile-bio">${details.map(([label, value]) => `<div class="key-value"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`).join("")}</div></section>
      <section class="panel"><h2>Recent history</h2><div class="activity-list">${data.history?.length ? data.history.map(activityRow).join("") : empty("No public history yet", "Verified milestones and bounty records will appear here.")}</div>${pagination(data.historyPage || { total: data.historyTotal || 0, limit: 20 }, page)}</section></div>`;
  } catch (error) {
    const notFound = error.status === 404;
    return `${pageHead("PLAYER PROFILE", notFound ? "Player not found" : "Player profile", notFound ? "This player is not in the tracked server records." : "A record built from verified server activity.")}<div class="panel">${notFound ? empty("No matching player record", "Check the username or return to the player directory.") : errorBox(error)}<a class="button" data-link href="${BASE}/players">Player directory</a></div>`;
  }
}

const LEADERBOARDS = [
  ["kills", "Most player kills"], ["deaths", "Most player deaths"], ["kd", "Best qualifying K/D"],
  ["killstreak", "Highest killstreak"], ["mobKills", "Most mob kills"], ["playtime", "Total playtime"], ["bountyClaims", "Bounties claimed"],
  ["bountyEarned", "Bounty rewards earned"], ["bountiesPlaced", "Bounties placed"], ["bountyPlacedValue", "Bounty value placed"], ["largestClaim", "Largest bounty claimed"]
];
async function leaderboardsPage(version, category = "kills", page = 1) {
  try {
    category = new URLSearchParams(location.search).get("category") || category;
    page = Math.max(1, Number(new URLSearchParams(location.search).get("page") || page));
    const data = await api(`/leaderboards?${qs({ category, period: "all_time", page, limit: 25 })}`);
    if (version !== routeVersion) return "";
    const rows = (data.items || []).map((item, index) => `<tr><td>${fmt(item.rank ?? ((page - 1) * 25 + index + 1))}</td><td><a class="table-player" data-link href="${playerPath(item.player || item)}">${avatar(item.player || item)}<span>${esc((item.player || item).username || "Unknown")}</span></a></td><td>${esc(item.displayValue ?? leaderboardValue(category, item))}</td></tr>`).join("");
    const categories = [...LEADERBOARDS, ...(data.weaponCategories || []).map((w) => [w.category, `${w.name} kills`])];
    return `${pageHead("COMPETITION", "Leaderboards", "Compare verified all-time records. Categories appear as their source data becomes available.")}
      <div class="toolbar"><label class="sr-only" for="leader-category">Leaderboard category</label><select id="leader-category" class="select">${categories.map(([id, title]) => `<option value="${id}" ${category === id ? "selected" : ""}>${title}</option>`).join("")}</select><span class="pill">All time</span><span class="pill">K/D requires 10+ PvP kills</span></div>
      <div class="table-wrap">${rows ? `<table><thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">${esc(categories.find(([id]) => id === category)?.[1] || "Record")}</th></tr></thead><tbody>${rows}</tbody></table>` : empty("No qualifying records yet", "This category needs verified statistics before it can be ranked.")}</div>${pagination(data, page)}`;
  } catch (error) { return `${pageHead("COMPETITION", "Leaderboards", "Compare verified all-time records.")}<div class="panel">${errorBox(error)}</div>`; }
}
function leaderboardValue(category, item) {
  if (category === "playtime") return playtime(item.value ?? item.playtimeSeconds);
  if (category === "kd") return item.value == null ? ratio(item.kills, item.deaths) : Number(item.value).toFixed(2);
  const v = item.value ?? item[category];
  return item.currency && v != null ? `${fmt(v)} ${item.currency}` : fmt(v);
}

async function bountiesPage(version) {
  try {
    const params = new URLSearchParams(location.search);
    const [data, me] = await Promise.all([api(`/bounties?${qs({ sort: params.get("sort") || "highest_reward", minValue: params.get("minValue") || "", nearExpiry: params.get("nearExpiry") || "", page: params.get("page") || 1, limit: 24 })}`), api("/me").catch(() => null)]);
    if (version !== routeVersion) return "";
    const items = data.items || [];
    const sort = params.get("sort") || "highest_reward";
    const minValue = params.get("minValue") || ""; const nearExpiry = params.get("nearExpiry") || "";
    const transactions = me?.player ? await api("/me/transactions?limit=5").catch(() => ({ items: [] })) : { items: [] };
    const auth = me?.player ? placementForm(me.player, data.players || [], data.currency || "", data.minimumAmount, data.maximumAmount, transactions.items || []) : `<div class="panel auth-panel"><div class="panel-heading-inline"><div><h2>Place a bounty</h2><p class="subtitle">Link your Minecraft identity in game to request a contribution securely.</p></div><span class="pill">UUID verified in game</span></div><form id="link-form" class="toolbar" style="margin:16px 0 0"><label class="sr-only" for="link-code">One-time link code</label><input class="field" id="link-code" name="code" placeholder="One-time in-game code" autocomplete="one-time-code" maxlength="24" required><button class="button primary" type="submit">Connect account</button></form><p class="stat-note" style="margin-top:11px">In Minecraft, run <code>/bounty link</code> and enter the short-lived code here. Never enter a Microsoft password.</p></div>`;
    return `${pageHead("MAASTERBOUNTY", "Wanted across the universe.", "Every target has a price. A confirmed bounty pool is paid to one eligible hunter after a verified in-game kill.", `<a class="button" data-link href="${BASE}/bounties/history">Bounty history</a>`)}
      <section class="section">${auth}</section><section class="section"><div class="toolbar"><label class="sr-only" for="bounty-sort">Sort bounty board</label><select id="bounty-sort" class="select"><option value="highest_reward" ${sort === "highest_reward" ? "selected" : ""}>Highest reward</option><option value="newest" ${sort === "newest" ? "selected" : ""}>Newest</option><option value="oldest" ${sort === "oldest" ? "selected" : ""}>Oldest</option><option value="contributors" ${sort === "contributors" ? "selected" : ""}>Most contributors</option><option value="expiring" ${sort === "expiring" ? "selected" : ""}>Time remaining</option></select><label class="sr-only" for="bounty-min-value">Minimum reward amount</label><input id="bounty-min-value" class="field" style="min-width:145px;width:165px" type="number" min="0" step="1" value="${esc(minValue)}" placeholder="Minimum reward"><label class="sr-only" for="bounty-expiry">Expiry filter</label><select id="bounty-expiry" class="select"><option value="" ${!nearExpiry ? "selected" : ""}>Any expiry</option><option value="24h" ${nearExpiry === "24h" ? "selected" : ""}>Expires within 24h</option><option value="72h" ${nearExpiry === "72h" ? "selected" : ""}>Expires within 72h</option></select><span class="pill">Active · confirmed only</span></div>${items.length ? `<div class="bounty-grid">${items.map(bountyCard).join("")}</div>${pagination(data, Number(data.page || 1))}` : `<div class="panel">${empty("No active bounties", "Confirmed bounty pools will appear here after the Paper server processes them.")}</div>`}</section>`;
  } catch (error) { return `${pageHead("MAASTERBOUNTY", "Wanted across the universe.", "Confirmed bounty pools and contribution history.")}<div class="panel">${errorBox(error)}</div>`; }
}

function placementForm(me, players, currency, minimum, maximum, transactions) {
  const pending = transactions.filter((tx) => tx.type === "placement" && ["requested", "processing"].includes(tx.status));
  const latest = transactions[0];
  const currencyReady = Boolean(currency);
  return `<div class="panel"><div class="panel-heading-inline"><div><h2>Place a bounty</h2><p class="subtitle">Signed in as ${esc(me.username)}. The Paper server verifies your balance and confirms the charge.</p></div><button class="button ghost" id="logout-button" type="button">Disconnect</button></div>
    ${pending.length ? `<div class="notice" style="margin-top:14px" role="status">A placement request is ${esc(pending[0].status)}. It will appear on the board only after the server confirms the charge. <a data-link class="text-link" href="${BASE}/bounties/history">View records</a></div>` : latest?.type === "placement" ? `<div class="notice ${latest.status === "completed" ? "success" : latest.status === "failed" ? "error" : ""}" style="margin-top:14px" role="status">Latest placement request: ${esc(latest.status)}${latest.targetUsername ? ` · ${esc(latest.targetUsername)}` : ""}.</div>` : ""}
    ${!currencyReady ? `<div class="notice" style="margin-top:14px">Bounty requests are disabled until the server owner configures the active economy currency.</div>` : ""}<form id="bounty-form" class="toolbar" data-currency="${esc(currency || "")}" style="margin:16px 0 0"><label class="sr-only" for="bounty-target">Target player</label><select id="bounty-target" class="select" required ${pending.length || !currencyReady ? "disabled" : ""}><option value="">Choose a target…</option>${players.filter((p) => p.uuid !== me.uuid).map((p) => `<option value="${esc(p.uuid)}">${esc(p.username)}</option>`).join("")}</select><label class="sr-only" for="bounty-amount">Contribution amount</label><input id="bounty-amount" class="field" style="min-width:150px;width:170px" type="number" min="${esc(minimum ?? 1)}" max="${esc(maximum ?? "")}" step="1" placeholder="Amount in ${esc(currency || "currency")}" required ${pending.length || !currencyReady ? "disabled" : ""}><button class="button primary" type="submit" ${players.filter((p) => p.uuid !== me.uuid).length && !pending.length && currencyReady ? "" : "disabled"}>Review request</button></form>${currencyReady ? `<p class="stat-note" style="margin-top:10px">Contribution range: ${fmt(minimum)}–${fmt(maximum)} ${esc(currency)}. The server checks your balance before any charge.</p>` : ""}<div id="bounty-result" aria-live="polite" style="margin-top:10px"></div></div>`;
}

async function bountyHistoryPage(version) {
  const params = new URLSearchParams(location.search), status = params.get("status") || "", search = params.get("search") || "", from = params.get("from") || "", to = params.get("to") || "";
  try {
    const data = await api(`/bounties/history?${qs({ status, search, from, to, page: params.get("page") || 1, limit: 20 })}`);
    if (version !== routeVersion) return "";
    const items = data.items || [];
    return `${pageHead("MAASTERBOUNTY", "Bounty history", "Completed, expired, cancelled and under-review records remain part of the public history.", `<a class="button" data-link href="${BASE}/bounties">Active board</a>`)}
      <div class="toolbar"><label class="sr-only" for="history-status">Filter bounty status</label><select class="select" id="history-status"><option value="">All statuses</option>${["claimed", "expired", "cancelled", "under_review"].map((s) => `<option value="${s}" ${status === s ? "selected" : ""}>${s.replaceAll("_", " ")}</option>`).join("")}</select><label class="sr-only" for="history-search">Search target or hunter</label><input id="history-search" class="field" value="${esc(search)}" placeholder="Target or hunter…"><label class="sr-only" for="history-from">Created from</label><input id="history-from" class="select" type="date" value="${esc(from)}"><label class="sr-only" for="history-to">Created through</label><input id="history-to" class="select" type="date" value="${esc(to)}"></div>
      <div class="table-wrap">${items.length ? `<table><thead><tr><th scope="col">Target</th><th scope="col">Hunter</th><th scope="col">Reward pool</th><th scope="col">Placed</th><th scope="col">Completed</th><th scope="col">Status</th></tr></thead><tbody>${items.map((b) => `<tr><td><a data-link href="${BASE}/bounties/${encodeURIComponent(b.id)}">${esc(b.target?.username || "Unknown")}</a></td><td>${b.hunter ? `<a data-link href="${playerPath(b.hunter)}">${esc(b.hunter.username)}</a>` : "—"}</td><td>${fmt(b.totalValue)} ${esc(b.currency || "Currency unavailable")}</td><td>${esc(dateTime(b.createdAt))}</td><td>${esc(dateTime(b.claimedAt || b.updatedAt))}</td><td>${pill(b.status)}</td></tr>`).join("")}</tbody></table>` : empty("No bounty history yet", "Claimed, expired and cancelled bounties will remain listed here.")}</div>${pagination(data, Number(data.page || 1))}`;
  } catch (error) { return `${pageHead("MAASTERBOUNTY", "Bounty history", "Confirmed public records.")}<div class="panel">${errorBox(error)}</div>`; }
}

async function bountyDetailPage(id, version) {
  try {
    const data = await api(`/bounties/${encodeURIComponent(id)}`);
    if (version !== routeVersion) return "";
    const b = data.bounty || data, target = b.target || { username: "Unknown target" };
    return `${pageHead("MAASTERBOUNTY / RECORD", `Bounty on ${target.username || "target"}`, "A public record of the confirmed pool and its contribution history.", `<a class="button" data-link href="${BASE}/bounties">Back to board</a>`)}
      <div class="detail-grid"><section class="panel"><div class="detail-title">${avatar(target)}<div><h2>${esc(target.username || "Unknown target")}</h2><p class="subtitle">${pill(b.status)} <span style="margin-left:8px">${b.expiresAt ? `Expires ${esc(dateTime(b.expiresAt))}` : "No expiry configured"}</span></p></div></div><span class="amount-large">${fmt(b.totalValue)}</span><p class="subtitle">${esc(b.currency || "Currency unavailable")} reward pool · ${fmt(b.contributorCount)} contributors</p><div class="profile-bio"><div class="key-value"><span>Created</span><strong>${esc(dateTime(b.createdAt))}</strong></div><div class="key-value"><span>Claimed</span><strong>${esc(b.claimedAt ? dateTime(b.claimedAt) : "Not claimed")}</strong></div>${b.hunter ? `<div class="key-value"><span>Hunter</span><strong><a data-link href="${playerPath(b.hunter)}">${esc(b.hunter.username)}</a></strong></div>` : ""}<div class="key-value"><span>Payment</span><strong>${esc(b.paymentStatus || "Unavailable")}</strong></div></div></section>
      <section class="panel"><h2>Contributions</h2><p class="subtitle">Individual contribution amounts are shown only when the backend marks them public.</p><div class="profile-bio">${data.contributions?.length ? data.contributions.map((c) => `<div class="contribution-row"><a data-link href="${playerPath(c.player || c)}">${esc(c.player?.username || c.username || "Player")}</a><strong>${fmt(c.amount)} ${esc(b.currency || "Currency unavailable")}</strong></div>`).join("") : empty("Contribution details unavailable", "No public contribution records have been returned.")}</div></section></div>`;
  } catch (error) {
    return `${pageHead("MAASTERBOUNTY", error.status === 404 ? "Bounty not found" : "Bounty details", "The backend could not return this record.")}<div class="panel">${error.status === 404 ? empty("No matching bounty", "Return to the board to see active targets.") : errorBox(error)}<a data-link class="button" href="${BASE}/bounties">Bounty board</a></div>`;
  }
}

async function weaponsPage(version) {
  try {
    const data = await api("/weapons?page=1&limit=30");
    if (version !== routeVersion) return "";
    const items = data.items || [];
    return `${pageHead("ARMORY", "Custom weapons", "Weapon names and mechanics are published only when configured by the server owner.")}${items.length ? `<div class="weapon-grid">${items.map((w) => `<article class="weapon-card"><span class="weapon-glyph" aria-hidden="true">⌑</span><h3>${esc(w.name)}</h3><p>${esc(w.description || "No public description configured.")}</p><div class="weapon-data"><span>${esc(w.category || "Category unavailable")}</span><strong>${w.kills == null ? "Stats unavailable" : `${fmt(w.kills)} kills`}</strong></div>${w.cooldownSeconds != null ? `<div class="weapon-data"><span>Cooldown</span><strong>${fmt(w.cooldownSeconds)}s</strong></div>` : ""}</article>`).join("")}</div>` : `<div class="panel">${empty("No weapons configured", "The server owner can publish custom weapon details after confirming their names and mechanics.")}</div>`}`;
  } catch (error) { return `${pageHead("ARMORY", "Custom weapons", "Server-confirmed catalogue and statistics.")}<div class="panel">${errorBox(error)}</div>`; }
}

async function activityPage(version) {
  const page = Math.max(1, Number(new URLSearchParams(location.search).get("page") || 1));
  try {
    const data = await api(`/activity?${qs({ page, limit: 30 })}`);
    if (version !== routeVersion) return "";
    return `${pageHead("SERVER RECORD", "Recent discoveries", "A public feed of real player and bounty activity.")}
      <div class="panel activity-list">${data.items?.length ? data.items.map(activityRow).join("") : empty("No activity recorded yet", "The feed will populate after verified server events arrive.")}</div>${pagination(data, page)}`;
  } catch (error) { return `${pageHead("SERVER RECORD", "Recent discoveries", "A public feed of verified activity.")}<div class="panel">${errorBox(error)}</div>`; }
}

async function statusPage(version) {
  try {
    const data = await api("/status");
    if (version !== routeVersion) return "";
    const server = data.gameServer || {}, backend = data.backend || {};
    const cards = [
      ["Minecraft server", server.status || "unavailable", server.lastHeartbeat ? `Last heartbeat ${since(server.lastHeartbeat)}` : "No heartbeat received"],
      ["Players", server.onlinePlayers == null || server.maxPlayers == null ? "Unavailable" : `${fmt(server.onlinePlayers)} / ${fmt(server.maxPlayers)}`, "Current / maximum"],
      ["Edition and version", [server.edition, server.version].filter(Boolean).join(" · ") || "Unavailable", server.name || "Server name not configured"],
      ["Website API", backend.status || "Unavailable", backend.checkedAt ? `Checked ${since(backend.checkedAt)}` : "Health probe unavailable"],
      ["Database", backend.databaseStatus || "Unavailable", "Connection state only; no infrastructure details"],
      ["Paper metrics", server.tps == null && server.mspt == null ? "Unavailable" : `TPS ${fmt(server.tps)} · MSPT ${fmt(server.mspt)}`, "Metrics are reported by the Paper plugin"]
    ];
    return `${pageHead("SYSTEM STATUS", "Server status", "Minecraft uptime and website API health are separate signals. Sensitive operational details are never shown here.")}
      <div class="status-grid">${cards.map(([label, value, note]) => `<div class="status-card"><label>${esc(label)}</label><strong>${esc(value)}</strong><p>${esc(note)}</p></div>`).join("")}</div>
      <section class="panel section"><h2>Connection details</h2><div class="profile-bio"><div class="key-value"><span>Server address</span><strong>${esc(server.address || "Unavailable")}</strong></div><div class="key-value"><span>Last statistics update</span><strong>${esc(server.lastStatisticsUpdate ? dateTime(server.lastStatisticsUpdate) : "Unavailable")}</strong></div><div class="key-value"><span>Backend build</span><strong>${esc(backend.version || "Unavailable")}</strong></div></div></section>`;
  } catch (error) { return `${pageHead("SYSTEM STATUS", "Server status", "The backend health endpoint is unavailable.")}<div class="panel">${errorBox(error)}</div>`; }
}

function bindPage(path, version) {
  document.querySelectorAll("[data-copy-address]").forEach((button) => button.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(button.dataset.copyAddress); toast("Server address copied."); }
    catch { toast("Could not access clipboard. Select the address and copy it manually."); }
  }));
  const search = document.querySelector("#player-search");
  let searchTimer;
  search?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const value = search.value; const cursor = search.selectionStart ?? value.length;
    searchTimer = setTimeout(() => { const p = new URLSearchParams(location.search); p.set("search", value); p.delete("page"); restoreSearchCursor = cursor; navigate(`${BASE}/players?${p}`, true); }, 350);
  });
  document.querySelector("#player-sort")?.addEventListener("change", (e) => navigate(`${BASE}/players?${qs({ sort: e.target.value, search: document.querySelector("#player-search")?.value || "", online: document.querySelector("#player-online")?.value || "all" })}`, true));
  document.querySelector("#player-online")?.addEventListener("change", (e) => navigate(`${BASE}/players?${qs({ sort: document.querySelector("#player-sort")?.value || "kills", search: document.querySelector("#player-search")?.value || "", online: e.target.value })}`, true));
  document.querySelector("#leader-category")?.addEventListener("change", (e) => navigate(`${BASE}/leaderboards?category=${encodeURIComponent(e.target.value)}`, true));
  document.querySelector("#bounty-sort")?.addEventListener("change", (e) => { const p = new URLSearchParams(location.search); p.set("sort", e.target.value); p.delete("page"); navigate(`${BASE}/bounties?${p}`, true); });
  const applyBountyFilters = () => { const p = new URLSearchParams(location.search); p.set("minValue", document.querySelector("#bounty-min-value")?.value || ""); p.set("nearExpiry", document.querySelector("#bounty-expiry")?.value || ""); p.delete("page"); navigate(`${BASE}/bounties?${p}`, true); };
  document.querySelector("#bounty-min-value")?.addEventListener("keydown", (e) => { if (e.key === "Enter") applyBountyFilters(); });
  document.querySelector("#bounty-expiry")?.addEventListener("change", applyBountyFilters);
  const applyHistoryFilters = () => {
    const params = new URLSearchParams(location.search);
    params.set("status", document.querySelector("#history-status")?.value || "");
    params.set("search", document.querySelector("#history-search")?.value || "");
    params.set("from", document.querySelector("#history-from")?.value || "");
    params.set("to", document.querySelector("#history-to")?.value || ""); params.delete("page");
    navigate(`${BASE}/bounties/history?${params}`, true);
  };
  document.querySelector("#history-status")?.addEventListener("change", applyHistoryFilters);
  document.querySelector("#history-search")?.addEventListener("keydown", (e) => { if (e.key === "Enter") applyHistoryFilters(); });
  document.querySelector("#history-from")?.addEventListener("change", applyHistoryFilters);
  document.querySelector("#history-to")?.addEventListener("change", applyHistoryFilters);
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => {
    const params = new URLSearchParams(location.search); params.set("page", button.dataset.page); navigate(`${location.pathname}?${params}`, true);
  }));
  document.querySelector("#link-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]"); button.disabled = true;
    try {
      await api("/auth/link", { method: "POST", body: JSON.stringify({ code: document.querySelector("#link-code").value.trim() }) });
      toast("Minecraft identity linked. You can review a bounty request now."); render();
    } catch (error) { toast(error.message || "Account link failed."); button.disabled = false; }
  });
  document.querySelector("#logout-button")?.addEventListener("click", async () => {
    try { const me = await api("/me"); await api("/auth/logout", { method: "POST", headers: { "X-CSRF-Token": me.csrfToken || "" }, body: "{}" }); toast("Account disconnected."); render(); }
    catch (error) { toast(error.message || "Could not disconnect account."); }
  });
  document.querySelector("#bounty-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const target = document.querySelector("#bounty-target"), amount = document.querySelector("#bounty-amount");
    if (!target.value || !amount.value || !Number.isSafeInteger(Number(amount.value)) || Number(amount.value) < 1) { toast("Choose a target and enter a whole number amount."); return; }
    const button = form.querySelector("button[type=submit]");
    confirmBounty(target.selectedOptions[0].textContent, Number(amount.value), form.dataset.currency || "Currency unavailable", async () => {
      button.disabled = true; transactionInFlight = true;
      let waitForConfirmation = false;
      try {
        const me = await api("/me");
        const fingerprint = `${target.value}:${Number(amount.value)}`;
        if (!placementIdempotencyKey || placementFingerprint !== fingerprint) { placementFingerprint = fingerprint; placementIdempotencyKey = crypto.randomUUID(); }
        const result = await api("/bounties", { method: "POST", headers: { "X-CSRF-Token": me.csrfToken || "", "Idempotency-Key": placementIdempotencyKey }, body: JSON.stringify({ targetUuid: target.value, amount: Number(amount.value) }) });
        const status = result.transaction?.status || result.status || "requested";
        document.querySelector("#bounty-result").innerHTML = `<div class="notice">Request ${esc(result.transaction?.id || "submitted")} is <strong>${esc(status)}</strong>. The amount is not shown as contributed until the Paper server confirms the charge.</div>`;
        placementIdempotencyKey = null; placementFingerprint = "";
        if (["requested", "processing"].includes(status)) {
          waitForConfirmation = true;
          form.querySelectorAll("input, select, button[type=submit]").forEach((control) => { control.disabled = true; });
          setTimeout(() => { if (route() === `${BASE}/bounties`) render(); }, 4500);
        }
        amount.value = ""; toast(status === "completed" ? "Bounty contribution confirmed by the server." : "Request submitted; waiting for server confirmation.");
        if (status === "completed") setTimeout(() => render(), 1000);
      } catch (error) { document.querySelector("#bounty-result").innerHTML = `<div class="notice error">${esc(error.message || "The request was not confirmed.")} Check your bounty history before trying again.</div>`; }
      finally { transactionInFlight = false; if (!waitForConfirmation) button.disabled = false; }
    });
  });
}

function setupAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    const active = document.activeElement;
    if (transactionInFlight || document.visibilityState !== "visible" || document.querySelector(".modal-backdrop") || (active && active.matches("input, select, textarea, button"))) return;
    render();
  }, 30000);
}

function confirmBounty(target, amount, currency, onConfirm) {
  const node = document.createElement("div"); node.className = "modal-backdrop";
  node.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><p class="eyebrow">MAASTERBOUNTY</p><h2 id="confirm-title">Review contribution</h2><p>Request <strong>${esc(fmt(amount))} ${esc(currency)}</strong> for a bounty on <strong>${esc(target)}</strong>? The server will validate your balance and target. No contribution is counted until the Paper plugin confirms it.</p><div class="modal-actions"><button class="button" data-cancel type="button">Go back</button><button class="button primary" data-confirm type="button">Submit request</button></div></section>`;
  document.body.append(node);
  const close = () => node.remove();
  node.querySelector("[data-cancel]").focus();
  node.addEventListener("click", (e) => { if (e.target === node || e.target.closest("[data-cancel]")) close(); });
  node.querySelector("[data-confirm]").addEventListener("click", () => { close(); onConfirm(); });
  node.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

/* A small canvas starfield keeps the space background recognisable without hundreds of DOM nodes. */
function startSpace() {
  const canvas = document.querySelector("#starfield"), ctx = canvas?.getContext("2d"), glow = document.querySelector("#mouse-glow");
  if (!canvas || !ctx || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const stars = [];
  let width = 0, height = 0, frame = 0, scrollOffset = 0, meteor = null, nextMeteor = performance.now() + 6000;
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5); width = innerWidth; height = innerHeight;
    canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(height * dpr); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars.length = 0; const count = Math.min(180, Math.round(width * height / 6800));
    for (let i = 0; i < count; i++) stars.push({ x: Math.random() * width, y: Math.random() * height, r: Math.random() * 1.05 + .2, a: .14 + Math.random() * .58, phase: Math.random() * 7, speed: .3 + Math.random() * .45, depth: .004 + Math.random() * .032 });
  };
  const draw = (now) => {
    frame = requestAnimationFrame(draw); ctx.clearRect(0, 0, width, height);
    const t = now / 1000;
    for (const star of stars) { const y = ((star.y - (scrollOffset * star.depth % height)) + height) % height; ctx.globalAlpha = star.a * (.74 + Math.sin(t * star.speed + star.phase) * .24); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(star.x, y, star.r, 0, Math.PI * 2); ctx.fill(); }
    if (!meteor && now >= nextMeteor) meteor = { x: Math.random() * width * .7, y: Math.random() * height * .33, dx: 130 + Math.random() * 150, dy: 75 + Math.random() * 95, start: now, duration: 850 + Math.random() * 350 };
    if (meteor) {
      const p = (now - meteor.start) / meteor.duration;
      if (p >= 1) { meteor = null; nextMeteor = now + 5000 + Math.random() * 10000; }
      else {
        const x = meteor.x + meteor.dx * p, y = meteor.y + meteor.dy * p;
        const opacity = p < .15 ? p / .15 : p > .83 ? (1 - p) / .17 : 1;
        const gradient = ctx.createLinearGradient(x - 85, y - 52, x, y);
        gradient.addColorStop(0, "rgba(160,190,255,0)"); gradient.addColorStop(.85, `rgba(205,220,255,${.5 * opacity})`); gradient.addColorStop(1, `rgba(255,255,255,${.9 * opacity})`);
        ctx.globalAlpha = 1; ctx.strokeStyle = gradient; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 85, y - 52); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = `rgba(255,255,255,${opacity})`; ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };
  resize(); frame = requestAnimationFrame(draw); addEventListener("resize", resize, { passive: true });
  addEventListener("scroll", () => { scrollOffset = window.scrollY || 0; }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelAnimationFrame(frame); else frame = requestAnimationFrame(draw); });
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    pointer = { x: e.clientX, y: e.clientY };
    if (glow) { glow.style.left = `${pointer.x}px`; glow.style.top = `${pointer.y}px`; }
  }, { passive: true });
}

startSpace();
render();
