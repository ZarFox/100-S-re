// register-commands.js
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const { DISCORD_TOKEN, APPLICATION_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !APPLICATION_ID) {
  console.error('❌ DISCORD_TOKEN ou APPLICATION_ID manquant dans .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function main() {
  try {
    if (GUILD_ID) {
      // Guild commands (rapide pour tester)
      await rest.put(
        Routes.applicationGuildCommands(APPLICATION_ID, GUILD_ID),
        { body: commands }
      );
      console.log(`✅ Slash commands (guild) déployées sur ${GUILD_ID}`);
    } else {
      // Global commands (prennent du temps à apparaître)
      await rest.put(
        Routes.applicationCommands(APPLICATION_ID),
        { body: commands }
      );
      console.log('✅ Slash commands (globales) déployées');
    }
  } catch (err) {
    console.error('❌ Erreur déploiement', err);
  }
}

main();
