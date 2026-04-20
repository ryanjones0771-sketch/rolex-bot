
import express from "express";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { Telegraf } from "telegraf";
import yts from "yt-search";
import youtubedl from "yt-dlp-exec";

// --- Configuration ---
const BOT_NAME = "R☉LEX bot";
const PORT = Number(process.env.PORT || 3000);
const PREFIX = process.env.PREFIX || ".";
const AUTH_DIR = process.env.AUTH_DIR || "./auth";
const TEMP_DIR = "./temp";
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || "").replace(/\D/g, "");
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const ADMIN_FILE = path.join(AUTH_DIR, "bot_admins.json");

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

let botAdmins = new Set();
let sock = null;
let tgBot = null;

function loadAdmins() {
  try {
    if (fs.existsSync(ADMIN_FILE)) {
      const data = JSON.parse(fs.readFileSync(ADMIN_FILE));
      botAdmins = new Set(data);
    }
    if (PAIRING_NUMBER) botAdmins.add(`${PAIRING_NUMBER}@s.whatsapp.net`);
  } catch (e) { console.error("Admin Load Error:", e); }
}

function saveAdmins() {
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify([...botAdmins]));
  } catch (e) { console.error("Admin Save Error:", e); }
}

async function sendTgLog(text) {
  if (tgBot && TELEGRAM_CHAT_ID) {
    try {
      await tgBot.telegram.sendMessage(TELEGRAM_CHAT_ID, `📝 *[${BOT_NAME} LOG]*\n\n${text}`, { parse_mode: 'Markdown' });
    } catch (e) { console.error("TG Log Error:", e.message); }
  }
}

const app = express();
app.get("/", (_, res) => res.send(`${BOT_NAME} v2 is active.`));
app.listen(PORT, () => console.log(`Server on ${PORT}`));

const normalizeJid = (jid) => jid ? jidNormalizedUser(jid) : jid;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  loadAdmins();

  if (TELEGRAM_BOT_TOKEN) {
    tgBot = new Telegraf(TELEGRAM_BOT_TOKEN);
    tgBot.launch().catch(e => console.error("TG Launch Error:", e.message));
  }

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: !PAIRING_NUMBER,
    logger: pino({ level: "silent" }),
    browser: [BOT_NAME, "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      const botNum = normalizeJid(sock.user.id);
      await sendTgLog(`🚀 *R☉LEX bot Connected!*\nUser: ${botNum}`);
      await sock.sendMessage(botNum, { text: `👑 *${BOT_NAME} V2 Active!* \nType ${PREFIX}play to start music.` });
    }
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    }
  });

  // Pairing via TG
  if (PAIRING_NUMBER && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIRING_NUMBER);
        await sendTgLog(`🔑 *Pairing Code Needed!*\nNumber: ${PAIRING_NUMBER}\nCode: \`${code}\``);
      } catch (e) { console.error("Pairing Error:", e.message); }
    }, 5000);
  }

  // Welcome Feature
  sock.ev.on("group-participants.update", async (update) => {
    if (update.action !== "add") return;
    try {
      const groupMetadata = await sock.groupMetadata(update.id);
      for (const user of update.participants) {
        let ppUrl;
        try { ppUrl = await sock.profilePictureUrl(user, 'image'); } 
        catch { ppUrl = 'https://i.ibb.co/3S0kMhy/welcome-default.jpg'; }

        await sock.sendMessage(update.id, {
          image: { url: ppUrl },
          caption: `👋 *Welcome @${user.split("@")[0]}*\n\nTo: *${groupMetadata.subject}*\n👑 Powered by *${BOT_NAME}*`,
          mentions: [user]
        });
      }
    } catch (err) { console.error("Welcome Error:", err.message); }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const sender = normalizeJid(msg.key.participant || jid);
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();

    if (!text.startsWith(PREFIX)) return;
    if (!botAdmins.has(sender)) return;

    const [cmd, ...args] = text.slice(PREFIX.length).split(/\s+/);
    const command = cmd.toLowerCase();
    const query = args.join(" ");

    await sendTgLog(`💬 *Command:* ${command}\n*Query:* ${query || 'None'}\n*By:* @${sender.split("@")[0]}`);

    if (command === "menu" || command === "help") {
      const menu = `👑 *${BOT_NAME} V2 MENU* 👑\n\n` +
        `🎵 *Music & Video:*\n` +
        `• ${PREFIX}play <query> - Download Audio\n` +
        `• ${PREFIX}video <query> - Download Video\n\n` +
        `🛡️ *Admin:*\n` +
        `• ${PREFIX}addbotadmin @user\n` +
        `• ${PREFIX}kick / mute / unmute\n\n` +
        `📊 *System:*\n` +
        `• ${PREFIX}ping / info`;
      return sock.sendMessage(jid, { text: menu }, { quoted: msg });
    }

    // --- YT Download Logic ---
    if (command === "play" || command === "song" || command === "video") {
      if (!query) return sock.sendMessage(jid, { text: `Kripya search query dein! (e.g. ${PREFIX}play faded)` });
      
      await sock.sendMessage(jid, { text: `⏳ Searching for "${query}"...` });
      
      try {
        const search = await yts(query);
        const vid = search.videos[0];
        if (!vid) return sock.sendMessage(jid, { text: "Koi result nahi mila!" });

        const isVideo = command === "video";
        const fileName = `${TEMP_DIR}/${Date.now()}.${isVideo ? 'mp4' : 'mp3'}`;
        
        await sendTgLog(`📥 *Downloading:* ${vid.title}\nFormat: ${isVideo ? 'Video' : 'Audio'}`);

        // yt-dlp execution
        await youtubedl(vid.url, {
          output: fileName,
          format: isVideo ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best' : 'bestaudio/best',
          postprocessorArgs: isVideo ? [] : ['-extract-audio', '--audio-format', 'mp3']
        });

        if (isVideo) {
          await sock.sendMessage(jid, { 
            video: { url: fileName }, 
            caption: `✅ *${vid.title}*\n⏱️ Duration: ${vid.timestamp}`, 
          }, { quoted: msg });
        } else {
          await sock.sendMessage(jid, { 
            audio: { url: fileName }, 
            mimetype: 'audio/mpeg',
            fileName: `${vid.title}.mp3`
          }, { quoted: msg });
        }

        // Cleanup
        if (fs.existsSync(fileName)) fs.unlinkSync(fileName);
        await sendTgLog(`✅ *Sent:* ${vid.title}`);

      } catch (err) {
        console.error(err);
        await sock.sendMessage(jid, { text: `❌ Error: ${err.message}` });
        await sendTgLog(`❌ *Download Error:* ${err.message}`);
      }
    }

    // Other Management Commands
    if (command === "ping") await sock.sendMessage(jid, { text: `*${BOT_NAME}* Speed: ⚡ 0.02ms` });

    if (command === "addbotadmin") {
      const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (target) {
        botAdmins.add(target);
        saveAdmins();
        await sock.sendMessage(jid, { text: `✅ New admin added.` });
      }
    }

    if (command === "kick") {
      const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (target) await sock.groupParticipantsUpdate(jid, [target], "remove");
    }
  });
}

startBot();
