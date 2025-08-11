import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { EventEmitter } from 'events';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  REST,
  Routes,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';

// ==== ESM utils ====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==== Storage (JSON) ====
const DATA_DIR = path.join(__dirname, 'data');
const CUSTOM_FILE = path.join(DATA_DIR, 'custom-commands.json');

// in-memory cache: { [guildId]: { [commandName]: response } }
let CUSTOM = {};
async function loadCustom() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(CUSTOM_FILE, 'utf8').catch(() => '{}');
    CUSTOM = JSON.parse(raw);
  } catch (e) {
    console.error('Erreur loadCustom:', e);
    CUSTOM = {};
  }
}
async function saveCustom() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CUSTOM_FILE, JSON.stringify(CUSTOM, null, 2), 'utf8');
  } catch (e) {
    console.error('Erreur saveCustom:', e);
  }
}
function getGuildMap(guildId) {
  if (!CUSTOM[guildId]) CUSTOM[guildId] = {};
  return CUSTOM[guildId];
}

// Commandes perso "!" : autoriser tout nom sans espace, 1–32 chars
const CUSTOM_NAME_RE = /^\S{1,32}$/;
function isValidCustomName(name) {
  return CUSTOM_NAME_RE.test(name);
}

// ==== Discord Bot ====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', async () => {
  console.log(`✅ Connecté comme ${client.user.tag}`);
  await loadCustom();
  try {
    await upsertBuiltinSlashForAllGuilds();
  } catch (e) {
    console.error('Erreur upsert builtin slash:', e);
  }
});

// Push des commandes built-in quand le bot rejoint un nouveau serveur
client.on('guildCreate', async (guild) => {
  try {
    await upsertBuiltinSlashForGuild(guild.id);
  } catch (e) {
    console.error('Erreur upsert guildCreate:', e);
  }
});

// Gestion du préfixe "!" pour commandes perso + log des messages
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Log simple message
  try {
    console.log(`[MESSAGE] ${message.author.tag} (${message.author.id}) @ ${message.guild?.name || 'DM'}/#${message.channel?.name || 'dm'} : ${message.content}`);
  } catch (_) {}

  const content = message.content.trim();

  // Déclencheur custom: "!nom"
  if (content.startsWith('!') && content.length > 1) {
    const name = content.slice(1).split(/\s+/)[0];
    const map = getGuildMap(message.guild?.id || 'dm');
    const reply = map[name];
    if (reply) {
      console.log(`[CUSTOM USE] !${name} @ ${message.guild?.name || message.guildId}`);
      await message.channel.send({
        content: reply,
        allowedMentions: { parse: [] }
      });
      return;
    }
  }

  // Petit test
  if (content.toLowerCase() === 'ping') {
    await message.channel.send({ content: 'pong 🏓', allowedMentions: { parse: [] } });
  }
});

client.login(process.env.DISCORD_TOKEN);

// ==== Built-in slash commands (/add, /list, /remove) ====
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
  {
    name: 'list',
    description: 'Lister les commandes perso de ce serveur',
    default_member_permissions: null,
    dm_permission: false
  },
  {
    name: 'remove',
    description: 'Supprimer une commande perso',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    dm_permission: false,
    options: [
      { type: 3, name: 'commande', description: 'Nom (sans "!")', required: true }
    ]
  }
];

async function upsertBuiltinSlashForGuild(guildId) {
  if (!APPLICATION_ID) throw new Error('APPLICATION_ID manquant (.env)');
  await rest.put(Routes.applicationGuildCommands(APPLICATION_ID, guildId), { body: BUILTIN_COMMANDS });
  console.log(`✅ Slash built-in déployés sur ${guildId}`);
}

async function upsertBuiltinSlashForAllGuilds() {
  if (!APPLICATION_ID) throw new Error('APPLICATION_ID manquant (.env)');
  const guildIds = client.guilds.cache.map(g => g.id);
  for (const gid of guildIds) {
    await upsertBuiltinSlashForGuild(gid);
  }
}

// Handler slash (built-in + exemples ping/say + fallback) + LOGS
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // LOG détaillé
  const where = `${interaction.guild?.name || 'DM'}${interaction.channel?.name ? `/#${interaction.channel.name}` : ''}`;
  const optsStr = (interaction.options?.data || [])
    .map(o => `${o.name}=${JSON.stringify(o.value)}`).join(', ');
  console.log(`[SLASH] ${interaction.user.tag} (${interaction.user.id}) → /${interaction.commandName} @ ${where}${optsStr ? ` | ${optsStr}` : ''}`);

  try {
    // Built-in
    if (interaction.commandName === 'add') {
      const name = (interaction.options.getString('commande', true) || '').trim();
      const msg  = interaction.options.getString('message', true);
      if (!isValidCustomName(name)) {
        return interaction.reply({
          content: '❌ Nom invalide. Pas d’espace, 1–32 caractères.',
          flags: MessageFlags.Ephemeral
        });
      }
      const map = getGuildMap(interaction.guildId);
      map[name] = msg;
      await saveCustom();
      console.log(`[CUSTOM] ADD !${name} @ ${interaction.guild?.name || interaction.guildId}`);
      return interaction.reply({ content: `✅ Ajouté: \`!${name}\``, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'list') {
      const map = getGuildMap(interaction.guildId);
      const entries = Object.entries(map);
      if (!entries.length) {
        return interaction.reply({ content: 'Aucune commande perso ici.', flags: MessageFlags.Ephemeral });
      }
      const list = entries
        .slice(0, 50)
        .map(([k, v]) => `• \`!${k}\` → ${v.slice(0,60)}${v.length>60?'…':''}`)
        .join('\n');
      console.log(`[CUSTOM] LIST (${entries.length}) @ ${interaction.guild?.name || interaction.guildId}`);
      return interaction.reply({ content: `**Commandes perso (${entries.length})**\n${list}`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'remove') {
      const name = (interaction.options.getString('commande', true) || '').trim();
      const map = getGuildMap(interaction.guildId);
      if (!map[name]) {
        return interaction.reply({ content: `❌ \`!${name}\` n’existe pas.`, flags: MessageFlags.Ephemeral });
      }
      delete map[name];
      await saveCustom();
      console.log(`[CUSTOM] REMOVE !${name} @ ${interaction.guild?.name || interaction.guildId}`);
      return interaction.reply({ content: `🗑️ Supprimé: \`!${name}\``, flags: MessageFlags.Ephemeral });
    }

    // Exemples existants
    if (interaction.commandName === 'ping') {
      const ws = client.ws.ping;
      return interaction.reply({ content: `pong 🏓 (WS ~${ws}ms)`, flags: MessageFlags.Ephemeral });
    }
    if (interaction.commandName === 'say') {
      const m = interaction.options.getString('message', true);
      await interaction.reply({ content: '✅ Envoyé !', flags: MessageFlags.Ephemeral });
      return interaction.channel.send({ content: m, allowedMentions: { parse: [] } });
    }

    // Fallback générique
    const parts = [];
    for (const opt of interaction.options.data) if (opt?.value) parts.push(String(opt.value));
    const text = parts.join(' ').trim() || '(aucun texte)';
    await interaction.reply({ content: `🛠️ /${interaction.commandName} — reçu: ${text}`, flags: MessageFlags.Ephemeral });

  } catch (err) {
    console.error('❌ Erreur handler slash:', err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: '❌ Oups, une erreur est survenue.', flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: '❌ Oups, une erreur est survenue.', flags: MessageFlags.Ephemeral });
    }
  }
});

// ==== Express Web Server ====
const app = express();
const PORT = process.env.PORT || 3000;

// Fichiers statiques + JSON
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Bus de logs + patch console pour SSE ---
const logBus = new EventEmitter();
const origLog = console.log;
const origErr = console.error;
function fmtLog(args) {
  const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const ts = new Date().toISOString();
  return `[${ts}] ${s}`;
}
console.log = (...args) => { const m = fmtLog(args); logBus.emit('msg', m); origLog(...args); };
console.error = (...args) => { const m = fmtLog(args); logBus.emit('msg', m); origErr(...args); };

// Protection API (header x-api-key ; et pour /api/logs/stream, accepte aussi ?key=)
console.log(
  process.env.DASHBOARD_API_KEY
    ? `🔐 API key activée (len=${process.env.DASHBOARD_API_KEY.length})`
    : '⚠️ Aucune API key définie (DASHBOARD_API_KEY)'
);
app.use('/api', (req, res, next) => {
  const required = process.env.DASHBOARD_API_KEY;
  if (!required) return next();
  const isLogsStream = req.path.startsWith('/logs/stream');
  const received = req.header('x-api-key') || (isLogsStream ? req.query.key : '');
  if (received !== required) return res.status(401).json({ error: 'API key invalide' });
  next();
});

// --- API: statut bot ---
app.get('/api/status', (_req, res) => {
  const data = {
    online: client.ws.status === 0,
    userTag: client.user?.tag || null,
    guildCount: client.guilds.cache.size,
    wsPingMs: client.ws.ping,
    uptimeMs: client.uptime ?? 0
  };
  res.json(data);
});

// --- API: guilds ---
app.get('/api/guilds', (_req, res) => {
  const guilds = client.guilds.cache
    .map(g => ({ id: g.id, name: g.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  res.json({ guilds });
});

// --- API: channels texte ---
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Échec récupération channels' });
  }
});

// --- API: envoyer un message ---
app.post('/api/send', async (req, res) => {
  try {
    const { channelId, message } = req.body || {};
    if (!channelId || !message) return res.status(400).json({ error: 'channelId et message requis' });
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return res.status(404).json({ error: 'Salon introuvable ou non textuel' });
    await channel.send({ content: message, allowedMentions: { parse: [] } });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Échec envoi message' });
  }
});

// --- API: custom commands (!) ---
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
    const map = getGuildMap(guildId);
    map[name] = String(response);
    await saveCustom();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Échec ajout commande' });
  }
});
app.delete('/api/custom/remove', async (req, res) => {
  try {
    const { guildId, name } = req.body || {};
    if (!guildId || !name) return res.status(400).json({ error: 'guildId et name requis' });
    const map = getGuildMap(guildId);
    if (!map[name]) return res.status(404).json({ error: 'Commande introuvable' });
    delete map[name];
    await saveCustom();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Échec suppression commande' });
  }
});

// ===== SLASH COMMANDS (API dashboard) =====
app.get('/api/slash/list', async (req, res) => {
  try {
    if (!APPLICATION_ID) return res.status(500).json({ error: 'APPLICATION_ID manquant' });
    const guildId = (req.query.guildId ?? '').trim();
    const route = guildId
      ? Routes.applicationGuildCommands(APPLICATION_ID, guildId)
      : Routes.applicationCommands(APPLICATION_ID);
    const cmds = await rest.get(route);
    res.json({ commands: cmds });
  } catch (e) {
    console.error('❌ REST list', e);
    res.status(500).json({ error: e.rawError?.message || e.message || 'Échec listage' });
  }
});

app.post('/api/slash/create', async (req, res) => {
  try {
    if (!APPLICATION_ID) return res.status(500).json({ error: 'APPLICATION_ID manquant' });
    let { scope = 'guild', guildId = '', name, description, options = [] } = req.body || {};
    guildId = String(guildId).trim();

    const NAME_RE = /^[a-z0-9_-]{1,32}$/;
    const normalize = s => String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 32);

    name = normalize(name);
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Nom invalide (a-z 0-9 _ -, 1–32)' });

    const cleanOptions = (options || []).map(o => {
      const on = normalize(o.name);
      if (!NAME_RE.test(on)) throw new Error(`Option name invalide: ${o.name}`);
      const od = String(o.description || '').slice(0, 100) || 'option';
      return { type: 3, name: on, description: od, required: !!o.required };
    });

    const isGuild = scope === 'guild';
    if (isGuild && !guildId) return res.status(400).json({ error: 'guildId requis pour scope guild' });

    const route = isGuild
      ? Routes.applicationGuildCommands(APPLICATION_ID, guildId)
      : Routes.applicationCommands(APPLICATION_ID);

    const existing = await rest.get(route);
    const filtered = existing.filter(c => c.name !== name);
    const newCmd = { name, description: String(description || '').slice(0, 100) || 'cmd', dm_permission: false, options: cleanOptions };

    await rest.put(route, { body: [...filtered, newCmd] });
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ REST create', e);
    res.status(500).json({ error: e.rawError?.message || e.message || 'Échec création' });
  }
});

app.delete('/api/slash/delete', async (req, res) => {
  try {
    if (!APPLICATION_ID) return res.status(500).json({ error: 'APPLICATION_ID manquant' });
    const { scope = 'guild', guildId = '', commandId } = req.body || {};
    if (!commandId) return res.status(400).json({ error: 'commandId requis' });

    const isGuild = scope === 'guild';
    if (isGuild && !guildId) return res.status(400).json({ error: 'guildId requis pour scope guild' });

    const route = isGuild
      ? Routes.applicationGuildCommands(APPLICATION_ID, String(guildId).trim())
      : Routes.applicationCommands(APPLICATION_ID);

    const existing = await rest.get(route);
    await rest.put(route, { body: existing.filter(c => c.id !== commandId) });
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ REST delete', e);
    res.status(500).json({ error: e.rawError?.message || e.message || 'Échec suppression' });
  }
});

// --- SSE: stream des logs ---
app.get('/api/logs/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders?.();

  const send = (m) => res.write(`data: ${m}\n\n`);
  const onMsg = (m) => send(m);
  const keep = setInterval(() => res.write(': keepalive\n\n'), 15000);

  logBus.on('msg', onMsg);
  send('--- session ouverte ---');

  req.on('close', () => {
    clearInterval(keep);
    logBus.off('msg', onMsg);
  });
});

// route racine → public/index.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🌐 http://localhost:${PORT}`);
});
