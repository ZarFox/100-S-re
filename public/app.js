// ===== CONFIG =====
const API_KEY = "Caca1234"; // doit == DASHBOARD_API_KEY (.env)

// ===== ELEMENTS =====
const $ = (id) => document.getElementById(id);

// Status / message
const refreshBtn = $('refresh');
const guildSelect = $('guildSelect');
const channelSelect = $('channelSelect');
const sendBtn = $('send');
const messageInput = $('message');

// Custom commands
const customGuildSel = $('customGuild');
const customName = $('customName');
const customResponse = $('customResponse');
const customAddBtn = $('customAdd');
const customReloadBtn = $('customReload');
const customResult = $('customResult');
const customListBox = $('customList');

// Slash commands (génériques)
const scopeSel = document.getElementById('slashScope');
const slashGuildSel = document.getElementById('slashGuild');
const slashRefreshBtn = document.getElementById('slashRefresh');
const cmdName = document.getElementById('cmdName');
const cmdDesc = document.getElementById('cmdDesc');
const optionsBox = document.getElementById('optionsBox');
const deployBtn = document.getElementById('deployCmd');
const deployResult = document.getElementById('deployResult');
const cmdList = document.getElementById('cmdList');

// ===== API helper =====
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur API');
  return data;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ===== STATUT / GUILDS / CHANNELS =====
async function refresh() {
  const s = await api('/api/status');
  $('online').textContent     = s.online ? 'Oui ✅' : 'Non ❌';
  $('userTag').textContent    = s.userTag || '—';
  $('guildCount').textContent = s.guildCount ?? '—';
  $('wsPing').textContent     = `${s.wsPingMs} ms`;
  await loadGuilds();
  await hydrateCustomGuildSelect();
}

async function loadGuilds() {
  const { guilds } = await api('/api/guilds');

  guildSelect.innerHTML = `<option value="">— Choisir un serveur —</option>` +
    guilds.map(g => `<option value="${g.id}">${escapeHtml(g.name)} (${g.id})</option>`).join('');
  guildSelect.disabled = guilds.length === 0;
  setChannels([]);

  slashGuildSel.innerHTML = `<option value="">— Serveur pour le scope guild —</option>` +
    guilds.map(g => `<option value="${g.id}">${escapeHtml(g.name)} (${g.id})</option>`).join('');
  updateSlashControls();

  const customGuild = customGuildSel;
  customGuild.innerHTML = `<option value="">— Choisir un serveur —</option>` +
    guilds.map(g => `<option value="${g.id}">${escapeHtml(g.name)} (${g.id})</option>`).join('');
}

async function loadChannels(guildId) {
  if (!guildId) return setChannels([]);
  const { channels } = await api(`/api/channels?guildId=${encodeURIComponent(guildId)}`);
  setChannels(channels);
}

function setChannels(channels) {
  if (!channels || channels.length === 0) {
    channelSelect.innerHTML = `<option value="">— Choisir un salon —</option>`;
    channelSelect.disabled = true;
    return;
  }
  channelSelect.innerHTML = `<option value="">— Choisir un salon —</option>` +
    channels.map(ch => {
      const label = ch.parent ? `${escapeHtml(ch.parent)} / #${escapeHtml(ch.name)}` : `#${escapeHtml(ch.name)}`;
      return `<option value="${ch.id}">${label}</option>`;
    }).join('');
  channelSelect.disabled = false;
}

// ===== CUSTOM COMMANDS (!) =====
const CUSTOM_NAME_RE = /^\S{1,32}$/;

async function hydrateCustomGuildSelect() {
  const gid = customGuildSel.value;
  if (gid) await loadCustomList(gid);
}

async function loadCustomList(guildId) {
  if (!guildId) { customListBox.innerHTML = ''; return; }
  const { commands } = await api(`/api/custom/list?guildId=${encodeURIComponent(guildId)}`);
  renderCustomList(commands);
}

function renderCustomList(items) {
  if (!items || items.length === 0) {
    customListBox.innerHTML = `<div class="text-slate-400">Aucune commande perso.</div>`;
    return;
  }
  customListBox.innerHTML = items.map(it => `
    <div class="flex items-center justify-between rounded-lg bg-slate-800 border border-slate-700 px-3 py-2">
      <div class="truncate">
        <span class="font-medium">!${escapeHtml(it.name)}</span>
        <span class="text-slate-400">— ${escapeHtml(it.response)}</span>
      </div>
      <button data-name="${escapeHtml(it.name)}" class="px-2 py-1 rounded bg-red-600 hover:bg-red-500">Supprimer</button>
    </div>
  `).join('');

  [...customListBox.querySelectorAll('button[data-name]')].forEach(btn => {
    btn.addEventListener('click', async () => {
      const gid = customGuildSel.value;
      const name = btn.getAttribute('data-name');
      if (!gid) return alert('Choisis un serveur.');
      try {
        await api('/api/custom/remove', { method: 'DELETE', body: JSON.stringify({ guildId: gid, name }) });
        await loadCustomList(gid);
      } catch (e) {
        alert(`Suppression impossible: ${e.message}`);
      }
    });
  });
}

// ===== SLASH COMMANDS (génériques) =====
function addOptionRow() {
  const row = document.createElement('div');
  row.className = 'grid sm:grid-cols-3 gap-2';
  row.innerHTML = `
    <input data-k="name" class="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700" placeholder="Nom de l'option (ex: message)" />
    <input data-k="description" class="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700" placeholder="Description (1–100)" />
    <label class="flex items-center gap-2 text-sm">
      <input data-k="required" type="checkbox" class="accent-indigo-600" /> Obligatoire
      <button data-k="remove" class="ml-auto px-2 py-1 rounded bg-slate-800 border border-slate-700">Suppr</button>
    </label>
  `;
  optionsBox.appendChild(row);
  row.querySelector('[data-k="remove"]').addEventListener('click', () => row.remove());
}
document.getElementById('addOption')?.addEventListener('click', addOptionRow);

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
function normalizeName(s='') {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

function updateSlashControls() {
  const needsGuild = scopeSel.value === 'guild';
  slashGuildSel.disabled = !needsGuild;
  if (slashRefreshBtn) slashRefreshBtn.disabled = needsGuild && !slashGuildSel.value;
}

async function loadCommandsList() {
  const scope = scopeSel.value;
  const guildId = slashGuildSel.value;
  if (scope === 'guild' && !guildId) {
    cmdList.innerHTML = `<div class="text-slate-400">Choisis un serveur pour lister les commandes.</div>`;
    updateSlashControls();
    return;
  }
  const qs = scope === 'guild' ? `?guildId=${encodeURIComponent(guildId)}` : '';
  const { commands } = await api(`/api/slash/list${qs}`);

  cmdList.innerHTML = commands.map(c => `
    <div class="flex items-center justify-between rounded-lg bg-slate-800 border border-slate-700 px-3 py-2">
      <div class="truncate">
        <span class="font-medium">/${escapeHtml(c.name)}</span>
        <span class="text-slate-400">— ${escapeHtml(c.description || '')}</span>
      </div>
      <button data-id="${c.id}" class="px-2 py-1 rounded bg-red-600 hover:bg-red-500">Supprimer</button>
    </div>
  `).join('');

  [...cmdList.querySelectorAll('button[data-id]')].forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const payload = { scope, commandId: btn.getAttribute('data-id') };
        if (scope === 'guild') payload.guildId = guildId;
        await api('/api/slash/delete', { method: 'DELETE', body: JSON.stringify(payload) });
        await loadCommandsList();
      } catch (e) {
        alert(`Suppression impossible: ${e.message}`);
      }
    });
  });
}

// ===== EVENTS =====
refreshBtn?.addEventListener('click', () => refresh().catch(console.error));
guildSelect?.addEventListener('change', (e) => {
  loadChannels(e.target.value).catch((err) => { console.error(err); setChannels([]); alert(`Erreur: ${err.message}`); });
});
sendBtn?.addEventListener('click', async () => {
  const channelId = channelSelect.value;
  const message = messageInput.value.trim();
  if (!channelId) return alert('Choisis un salon.');
  if (!message) return alert('Écris un message.');
  try {
    await api('/api/send', { method: 'POST', body: JSON.stringify({ channelId, message }) });
    $('sendResult').textContent = '✅ Message envoyé';
    messageInput.value = '';
  } catch (e) {
    $('sendResult').textContent = `❌ ${e.message}`;
  }
});
customGuildSel?.addEventListener('change', (e) => loadCustomList(e.target.value).catch(console.error));
customReloadBtn?.addEventListener('click', () => {
  const gid = customGuildSel.value;
  loadCustomList(gid).catch(console.error);
});
customAddBtn?.addEventListener('click', async () => {
  const gid = customGuildSel.value;
  const name = customName.value.trim();
  const response = customResponse.value.trim();
  if (!gid) return alert('Choisis un serveur.');
  if (!name || !CUSTOM_NAME_RE.test(name)) return alert('Nom invalide (pas d’espace, 1–32).');
  if (!response) return alert('Renseigne le message de réponse.');
  try {
    await api('/api/custom/add', { method: 'POST', body: JSON.stringify({ guildId: gid, name, response }) });
    customResult.textContent = `✅ Ajouté: !${name}`;
    customResponse.value = '';
    await loadCustomList(gid);
  } catch (e) {
    customResult.textContent = `❌ ${e.message}`;
  }
});
scopeSel?.addEventListener('change', () => { updateSlashControls(); loadCommandsList().catch(console.error); });
slashGuildSel?.addEventListener('change', () => { updateSlashControls(); loadCommandsList().catch(console.error); });
slashRefreshBtn?.addEventListener('click', () => loadCommandsList().catch(console.error));
deployBtn?.addEventListener('click', async () => {
  try {
    const scope = scopeSel.value;
    const guildId = slashGuildSel.value;
    if (scope === 'guild' && !guildId) return alert('Choisis un serveur pour le scope guild.');

    let name = cmdName.value.trim();
    name = normalizeName(name);
    const description = cmdDesc.value.trim().slice(0, 100);
    if (!/^[a-z0-9_-]{1,32}$/.test(name) || !description) {
      return alert("Nom invalide (a-z 0-9 _ -, 1–32) et description requise (1–100).");
    }

    const opts = [...optionsBox.children].map(row => {
      const oname = normalizeName(row.querySelector('[data-k="name"]').value.trim());
      const odesc = row.querySelector('[data-k="description"]').value.trim().slice(0, 100);
      const required = row.querySelector('[data-k="required"]').checked;
      if (!/^[a-z0-9_-]{1,32}$/.test(oname) || !odesc) return null;
      return { name: oname, description: odesc, required };
    }).filter(Boolean);

    const payload = { scope, name, description, options: opts };
    if (scope === 'guild') payload.guildId = guildId;

    await api('/api/slash/create', { method: 'POST', body: JSON.stringify(payload) });

    deployResult.textContent = '✅ Déployée (global peut prendre un peu de temps).';
    cmdName.value = '';
    cmdDesc.value = '';
    optionsBox.innerHTML = '';
    await loadCommandsList();
  } catch (e) {
    deployResult.textContent = `❌ ${e.message}`;
  }
});

// ===== INIT =====
(async () => {
  try {
    await refresh();
    updateSlashControls();
    await loadCommandsList();
  } catch (e) {
    console.error(e);
    alert(`Erreur init: ${e.message}`);
  }
})();
