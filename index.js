import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  REST,
  Routes,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';

/* =======================
   BASICS & STORAGE
======================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const CUSTOM_FILE = path.join(DATA_DIR, 'custom-commands.json');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const CUSTOM_NAME_RE = /^\S{1,32}$/;
const isValidCustomName = (n) => CUSTOM_NAME_RE.test(n);
const norm = (s) => String(s || '').toLowerCase();

let CUSTOM = {};
async function loadCustom() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(CUSTOM_FILE, 'utf8').catch(() => '{}');
    CUSTOM = JSON.parse(raw);
  } catch {
    CUSTOM = {};
  }
}
async function saveCustom() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CUSTOM_FILE, JSON.stringify(CUSTOM, null, 2), 'utf8');
}
function getGuildMap(gid) {
  if (!CUSTOM[gid]) CUSTOM[gid] = {};
  return CUSTOM[gid];
}

/* =======================
   EVENTS (console + JSONL)
======================= */
const eventBus = new EventEmitter();
const EVENT_BUFFER = [];
const EVENT_BUFFER_MAX = 1000;

const nowIso = () => new Date().toISOString();
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const eventLogPathFor = (date = new Date()) => path.join(DATA_DIR, `events-${dayKey(date)}.jsonl`);
let currentStream = null, currentDay = null;

function rotateEventStreamIfNeeded() {
  const today = dayKey();
  if (currentDay !== today) {
    if (currentStream) currentStream.end();
    currentStream = createWriteStream(eventLogPathFor(), { flags: 'a' });
    currentDay = today;
  }
}
function pushEvent(evt) {
  evt.ts = evt.ts || nowIso();
  EVENT_BUFFER.push(evt);
  if (EVENT_BUFFER.length > EVENT_BUFFER_MAX) EVENT_BUFFER.shift();
  rotateEventStreamIfNeeded();
  try { currentStream.write(JSON.stringify(evt) + '\n'); } catch {}
  eventBus.emit('evt', evt);
}

/* =======================
   DISCORD BOT
======================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', async () => {
  console.log(`✅ Connecté comme ${client.user.tag}`);
  await loadCustom();
  try { await upsertBuiltinSlashForAllGuilds(); } catch (e) { console.error('Erreur upsert builtin slash:', e); }
});
client.on('guildCreate', async (guild) => {
  try { await upsertBuiltinSlashForGuild(guild.id); } catch (e) { console.error('Erreur upsert guildCreate:', e); }
});

// Réactions: préfixe "!" (case-insensitive) + mots-clés
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const guildId = message.guild?.id || 'dm';
  const map = getGuildMap(guildId);

  const content = message.content.trim();
  const lower = content.toLowerCase();

  // log + event
  try { console.log(`[MESSAGE] ${message.author.tag} @ ${message.guild?.name || 'DM'}/#${message.channel?.name || 'dm'} : ${content}`); } catch {}
  pushEvent({
    type: 'message',
    guildId,
    guildName: message.guild?.name || 'DM',
    channelName: message.channel?.name || 'dm',
    userId: message.author.id,
    userTag: message.author.tag,
    content
  });

  // 1) Préfixe "!"
  if (lower.startsWith('!') && lower.length > 1) {
    const rawName = lower.slice(1).split(/\s+/)[0];
    const key = norm(rawName);
    const reply = map[key];
    if (reply) {
      pushEvent({
        type: 'custom', action: 'use',
        guildId, guildName: message.guild?.name || 'DM',
        channelName: message.channel?.name || 'dm',
        userId: message.author.id, userTag: message.author.tag,
        commandName: key, content: reply
      });
      await message.channel.send({ content: reply, allowedMentions: { parse: [] } });
      return;
    }
  }

  // 2) Mot-clé inclus
  const names = Object.keys(map);
  if (names.length) {
    const sorted = names.sort((a, b) => b.length - a.length); // plus spécifique d'abord
    const found = sorted.find(n => lower.includes(n));
    if (found) {
      pushEvent({
        type: 'custom', action: 'hit',
        guildId, guildName: message.guild?.name || 'DM',
        channelName: message.channel?.name || 'dm',
        userId: message.author.id, userTag: message.author.tag,
        commandName: found, content: map[found]
      });
      await message.reply({ content: map[found], allowedMentions: { parse: [] } });
      return;
    }
  }

  if (lower === 'ping') {
    await message.channel.send({ content: 'pong 🏓', allowedMentions: { parse: [] } });
  }
});

client.login(process.env.DISCORD_TOKEN);

/* =======================
   SLASH COMMANDS
======================= */
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
const APPLICATION_ID = process.env.APPLICATION_ID;

const BUILTIN_COMMANDS = [
  {
    name: 'add',
    description: 'Ajouter une commande perso (!nom → message)',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    dm_permission: false,
    options: [
      { type: 3, name: 'commande', description: 'Nom (sans "!") — pas d’espace, max 32', required: true },
      { type: 3, name: 'message', description: 'Message renvoyé par !commande', required: true }
    ]
  },
  { name: 'list', description: 'Lister les commandes perso de ce serveur', default_member_permissions: null, dm_permission: false },
  {
    name: 'remove',
    description: 'Supprimer une commande perso',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    dm_permission: false,
    options: [{ type: 3, name: 'commande', description: 'Nom (sans "!")', required: true }]
  },
  { name: 'randomcustom', description: 'Publie au hasard une commande perso (!...) de ce serveur', default_member_permissions: null, dm_permission: false }
];

async function upsertBuiltinSlashForGuild(gid) {
  if (!APPLICATION_ID) throw new Error('APPLICATION_ID manquant (.env)');
  await rest.put(Routes.applicationGuildCommands(APPLICATION_ID, gid), { body: BUILTIN_COMMANDS });
  console.log(`✅ Slash built-in déployés sur ${gid}`);
}
async function upsertBuiltinSlashForAllGuilds() {
  if (!APPLICATION_ID) throw new Error('APPLICATION_ID manquant (.env)');
  const guildIds = client.guilds.cache.map(g => g.id);
  for (const gid of guildIds) await upsertBuiltinSlashForGuild(gid);
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const optsStr = (interaction.options?.data || []).map(o => `${o.name}=${JSON.stringify(o.value)}`).join(', ');
  pushEvent({
    type: 'slash', action: 'invoke',
    guildId: interaction.guildId || 'dm',
    guildName: interaction.guild?.name || 'DM',
    channelName: interaction.channel?.name || 'dm',
    userId: interaction.user.id, userTag: interaction.user.tag,
    commandName: interaction.commandName, content: optsStr
  });

  try {
    if (interaction.commandName === 'add') {
      const raw = (interaction.options.getString('commande', true) || '').trim();
      const name = norm(raw);
      const msg  = interaction.options.getString('message', true);
      if (!isValidCustomName(raw)) {
        return interaction.reply({ content: '❌ Nom invalide. Pas d’espace, 1–32 caractères.', flags: MessageFlags.Ephemeral });
      }
      const map = getGuildMap(interaction.guildId);
      map[name] = msg;
      await saveCustom();
      return interaction.reply({ content: `✅ Ajouté: \`!${raw}\` (insensible à la casse)`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'list') {
      const map = getGuildMap(interaction.guildId);
      const entries = Object.entries(map);
      if (!entries.length) {
        return interaction.reply({ content: 'Aucune commande perso ici.', flags: MessageFlags.Ephemeral });
      }
      const list = entries.slice(0, 50).map(([k, v]) => `• \`!${k}\` → ${v.slice(0,60)}${v.length>60?'…':''}`).join('\n');
      return interaction.reply({ content: `**Commandes perso (${entries.length})**\n${list}`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'remove') {
      const raw = (interaction.options.getString('commande', true) || '').trim();
      const name = norm(raw);
      const map = getGuildMap(interaction.guildId);
      if (!map[name]) {
        return interaction.reply({ content: `❌ \`!${raw}\` n’existe pas.`, flags: MessageFlags.Ephemeral });
      }
      delete map[name];
      await saveCustom();
      return interaction.reply({ content: `🗑️ Supprimé: \`!${raw}\``, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'randomcustom') {
      const map = getGuildMap(interaction.guildId);
      const names = Object.keys(map);
      if (!names.length) {
        return interaction.reply({ content: 'Aucune commande perso sur ce serveur.', flags: MessageFlags.Ephemeral });
      }
      const pick = names[Math.floor(Math.random() * names.length)];
      const resp = map[pick];
      await interaction.reply({ content: `🎲 \`!${pick}\``, flags: MessageFlags.Ephemeral });
      await interaction.channel?.send({ content: resp, allowedMentions: { parse: [] } });
      pushEvent({ type:'custom', action:'random', guildId:interaction.guildId, guildName:interaction.guild?.name, userId:interaction.user.id, userTag:interaction.user.tag, commandName:pick, content:resp });
      return;
    }

    if (interaction.commandName === 'ping') {
      const ws = client.ws.ping;
      return interaction.reply({ content: `pong 🏓 (WS ~${ws}ms)`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'say') {
      const m = interaction.options.getString('message', true);
      await interaction.reply({ content: '✅ Envoyé !', flags: MessageFlags.Ephemeral });
      return interaction.channel.send({ content: m, allowedMentions: { parse: [] } });
    }

    const parts = [];
    for (const opt of interaction.options.data) if (opt?.value) parts.push(String(opt.value));
    const text = parts.join(' ').trim() || '(aucun texte)';
    await interaction.reply({ content: `🛠️ /${interaction.commandName} — reçu: ${text}`, flags: MessageFlags.Ephemeral });

  } catch (err) {
    pushEvent({ type:'error', content: String(err?.message || err), userId: interaction.user?.id, userTag: interaction.user?.tag, guildId: interaction.guildId, guildName: interaction.guild?.name });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '❌ Oups, une erreur est survenue.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: '❌ Oups, une erreur est survenue.', flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
});

/* =======================
   PANEL AVEC MOT DE PASSE
======================= */
const app = express();
const PORT = process.env.PORT || 3000;

// --- mini "session" via cookie signé en mémoire (simple)
const SESSIONS = new Map(); // token -> { exp }
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 7);
function createToken() {
  const token = crypto.randomBytes(24).toString('base64url');
  const exp = Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  SESSIONS.set(token, { exp });
  return token;
}
function parseCookies(req) {
  const h = req.headers.cookie;
  if (!h) return {};
  return Object.fromEntries(h.split(';').map(v => v.trim().split('=').map(decodeURIComponent)));
}
function isAuthed(req) {
  const { panel } = parseCookies(req);
  if (!panel) return false;
  const s = SESSIONS.get(panel);
  if (!s) return false;
  if (Date.now() > s.exp) { SESSIONS.delete(panel); return false; }
  return true;
}
function authGuard(req, res, next) {
  // Autoriser librement la page login et le POST /api/login
  if (req.path === '/login' || req.path === '/api/login') return next();
  // Autoriser fichiers publics MINIMAUX utiles à /login (aucun chez nous)
  // Tout le reste nécessite une session
  if (!isAuthed(req)) return res.redirect('/login');
  next();
}

app.use(express.json());

// --- Page de login (HTML minimal intégré)
app.get('/login', (req, res) => {
  // si déjà connecté, on redirige
  if (isAuthed(req)) return res.redirect('/');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Connexion • Panel</title>
<style>
  body{background:#0f172a;color:#e2e8f0;font-family:system-ui,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{background:#0b1220;border:1px solid #1e293b;border-radius:16px;padding:24px;width:320px;box-shadow:0 10px 30px rgba(0,0,0,.3)}
  h1{font-size:18px;margin:0 0 12px}
  input{width:100%;padding:10px;border-radius:10px;border:1px solid #334155;background:#0a0f1c;color:#e2e8f0;margin:8px 0}
  button{width:100%;padding:10px;border-radius:10px;border:1px solid #4f46e5;background:#6366f1;color:#fff;font-weight:600;cursor:pointer}
  .err{color:#fca5a5;font-size:12px;min-height:18px}
</style>
</head>
<body>
  <div class="card">
    <h1>Connexion au panel</h1>
    <div class="err" id="err"></div>
    <input id="pw" type="password" placeholder="Mot de passe"/>
    <button id="go">Se connecter</button>
  </div>
<script>
  const btn = document.getElementById('go');
  const pw  = document.getElementById('pw');
  const err = document.getElementById('err');
  btn.onclick = async () => {
    err.textContent = '';
    const res = await fetch('/api/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ password: pw.value })
    });
    if (res.ok) location.href = '/';
    else err.textContent = (await res.json().catch(()=>({error:'Accès refusé'}))).error || 'Accès refusé';
  };
  pw.addEventListener('keydown', (e)=>{ if(e.key==='Enter') btn.click(); });
</script>
</body>
</html>`);
});

// --- API: login / logout
app.post('/api/login', (req, res) => {
  const provided = String(req.body?.password || '');
  const expected = String(process.env.PANEL_PASSWORD || '');
  if (!expected) return res.status(500).json({ error: 'PANEL_PASSWORD manquant côté serveur' });
  if (provided !== expected) return res.status(401).json({ error: 'Mot de passe incorrect' });

  const token = createToken();
  res.cookie
    ? res.cookie('panel', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_DAYS*24*60*60*1000 })
    : res.setHeader('Set-Cookie', `panel=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS*24*60*60}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const { panel } = parseCookies(req);
  if (panel) SESSIONS.delete(panel);
  res.setHeader('Set-Cookie', `panel=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

// --- Tout ce qui suit est protégé
app.use(authGuard);

// Fichiers statiques du dashboard (protégés)
app.use('/public', express.static(path.join(__dirname, 'public')));

// API protégée (plus de x-api-key, tout passe par la session)
app.get('/api/status', (_req, res) => {
  res.json({
    online: client.ws.status === 0,
    userTag: client.user?.tag || null,
    guildCount: client.guilds.cache.size,
    wsPingMs: client.ws.ping,
    uptimeMs: client.uptime ?? 0
  });
});
app.get('/api/guilds', (_req, res) => {
  const guilds = client.guilds.cache
    .map(g => ({ id: g.id, name: g.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  res.json({ guilds });
});
app.get('/api/channels', async (req, res) => {
  try {
    const guildId = req.query.guildId;
    if (!guildId) return res.status(400).json({ error: 'guildId requis' });
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild introuvable' });
    const channels = await guild.channels.fetch();
    const textChannels = [...channels.values()]
      .filter(ch => ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement))
      .map(ch => ({ id: ch.id, name: ch.name, parent: ch.parent?.name || null }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    res.json({ channels: textChannels });
  } catch { res.status(500).json({ error: 'Échec récupération channels' }); }
});
app.post('/api/send', async (req, res) => {
  try {
    const { channelId, message } = req.body || {};
    if (!channelId || !message) return res.status(400).json({ error: 'channelId et message requis' });
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return res.status(404).json({ error: 'Salon introuvable ou non textuel' });
    await channel.send({ content: message, allowedMentions: { parse: [] } });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Échec envoi message' }); }
});

// Custom commands API (normalisées)
app.get('/api/custom/list', (req, res) => {
  const guildId = req.query.guildId;
  if (!guildId) return res.status(400).json({ error: 'guildId requis' });
  const map = getGuildMap(guildId);
  const list = Object.entries(map).map(([name, response]) => ({ name, response }));
  res.json({ commands: list });
});
app.post('/api/custom/add', async (req, res) => {
  try {
    const { guildId, name, response } = req.body || {};
    if (!guildId || !name || !response) return res.status(400).json({ error: 'guildId, name, response requis' });
    if (!isValidCustomName(name)) return res.status(400).json({ error: 'Nom invalide: pas d’espace, 1–32' });
    const key = norm(name);
    const map = getGuildMap(guildId);
    map[key] = String(response);
    await saveCustom();
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Échec ajout commande' }); }
});
app.delete('/api/custom/remove', async (req, res) => {
  try {
    const { guildId, name } = req.body || {};
    if (!guildId || !name) return res.status(400).json({ error: 'guildId et name requis' });
    const key = norm(name);
    const map = getGuildMap(guildId);
    if (!map[key]) return res.status(404).json({ error: 'Commande introuvable' });
    delete map[key];
    await saveCustom();
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Échec suppression commande' }); }
});

// Slash management
app.get('/api/slash/list', async (req, res) => {
  try {
    if (!APPLICATION_ID) return res.status(500).json({ error: 'APPLICATION_ID manquant' });
    const guildId = (req.query.guildId ?? '').trim();
    const route = guildId
      ? Routes.applicationGuildCommands(APPLICATION_ID, guildId)
      : Routes.applicationCommands(APPLICATION_ID);
    const cmds = await rest.get(route);
    res.json({ commands: cmds });
  } catch (e) { res.status(500).json({ error: e.rawError?.message || e.message || 'Échec listage' }); }
});
app.post('/api/slash/create', async (req, res) => {
  try {
    if (!APPLICATION_ID) return res.status(500).json({ error: 'APPLICATION_ID manquant' });
    let { scope = 'guild', guildId = '', name, description, options = [] } = req.body || {};
    guildId = String(guildId).trim();
    const NAME_RE = /^[a-z0-9_-]{1,32}$/;
    const normalize = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'-').replace(/[^a-z0-9_-]/g,'').slice(0,32);
    name = normalize(name);
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Nom invalide (a-z 0 9 _ -, 1–32)' });
    const cleanOptions = (options||[]).map(o => {
      const on = normalize(o.name); if (!NAME_RE.test(on)) throw new Error(`Option name invalide: ${o.name}`);
      const od = String(o.description||'').slice(0,100) || 'option';
      return { type: 3, name: on, description: od, required: !!o.required };
    });
    const isGuild = scope === 'guild';
    if (isGuild && !guildId) return res.status(400).json({ error: 'guildId requis pour scope guild' });
    const route = isGuild ? Routes.applicationGuildCommands(APPLICATION_ID, guildId) : Routes.applicationCommands(APPLICATION_ID);
    const existing = await rest.get(route);
    const filtered = existing.filter(c => c.name !== name);
    const newCmd = { name, description: String(description||'').slice(0,100) || 'cmd', dm_permission: false, options: cleanOptions };
    await rest.put(route, { body: [...filtered, newCmd] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.rawError?.message || e.message || 'Échec création' }); }
});
app.delete('/api/slash/delete', async (req, res) => {
  try {
    if (!APPLICATION_ID) return res.status(500).json({ error: 'APPLICATION_ID manquant' });
    const { scope='guild', guildId='', commandId } = req.body || {};
    if (!commandId) return res.status(400).json({ error: 'commandId requis' });
    const isGuild = scope === 'guild';
    if (isGuild && !guildId) return res.status(400).json({ error: 'guildId requis pour scope guild' });
    const route = isGuild ? Routes.applicationGuildCommands(APPLICATION_ID, String(guildId).trim()) : Routes.applicationCommands(APPLICATION_ID);
    const existing = await rest.get(route);
    await rest.put(route, { body: existing.filter(c => c.id !== commandId) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.rawError?.message || e.message || 'Échec suppression' }); }
});

// SSE console (redirige console.log / console.error) — protégé
const logBus = new EventEmitter();
const origLog = console.log, origErr = console.error;
function fmtLog(args) {
  const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const ts = nowIso();
  return `[${ts}] ${s}`;
}
console.log = (...args) => { const m = fmtLog(args); logBus.emit('msg', m); origLog(...args); };
console.error = (...args) => { const m = fmtLog(args); logBus.emit('msg', m); origErr(...args); };

app.get('/api/logs/stream', (req, res) => {
  res.set({ 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive' });
  res.flushHeaders?.();
  const send = (m) => res.write(`data: ${m}\n\n`);
  const onMsg = (m) => send(m);
  const keep = setInterval(() => res.write(': keepalive\n\n'), 15000);
  logBus.on('msg', onMsg);
  send('--- session ouverte ---');
  req.on('close', () => { clearInterval(keep); logBus.off('msg', onMsg); });
});

// SSE événements structurés — protégé
app.get('/api/events/stream', (req, res) => {
  res.set({ 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive' });
  res.flushHeaders?.();
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const onEvt = (evt) => send(evt);
  const keep = setInterval(() => res.write(': keepalive\n\n'), 15000);
  eventBus.on('evt', onEvt);
  send({ ts: nowIso(), type: 'info', content: 'stream opened' });
  req.on('close', () => { clearInterval(keep); eventBus.off('evt', onEvt); });
});

// Historique — protégé
app.get('/api/events/files', async (_req, res) => {
  const files = (await fs.readdir(DATA_DIR))
    .filter(f => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  res.json({ files });
});
app.get('/api/events/file', async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error:'date invalide (YYYY-MM-DD)' });
  const p = path.join(DATA_DIR, `events-${date}.jsonl`);
  try { const data = await fs.readFile(p, 'utf8'); res.type('text/plain').send(data); }
  catch { res.status(404).json({ error: 'fichier introuvable' }); }
});
app.get('/api/events/query', (req, res) => {
  const { type, guildId, userId, limit='200' } = req.query;
  let items = EVENT_BUFFER.slice(-Number(limit));
  if (type) items = items.filter(e => e.type === type);
  if (guildId) items = items.filter(e => e.guildId === guildId);
  if (userId) items = items.filter(e => e.userId === userId);
  res.json({ events: items });
});

// Dashboard (index) — protégé
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
app.listen(PORT, () => {
  rotateEventStreamIfNeeded();
  console.log(`🌐 http://localhost:${PORT}`);
});
