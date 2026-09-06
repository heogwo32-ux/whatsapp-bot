'use strict';

require('dotenv').config();

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN  = process.env.BOT_TOKEN;
const ADMIN_ID   = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const CHECK_CONCURRENCY = Math.max(1, Number(process.env.CHECK_CONCURRENCY || 7));
const CHECK_DELAY_MS    = Math.max(0, Number(process.env.CHECK_DELAY_MS    || 400));
const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || './sessions');
const LOCK_FILE    = path.resolve(process.env.LOCK_FILE    || './bot.lock');
const MAX_NUMBERS  = 500;
const MAX_PER_PREFIX = 100;

if (!BOT_TOKEN)  { console.error('❌  BOT_TOKEN env var is required.'); process.exit(1); }
if (!ADMIN_ID || Number.isNaN(ADMIN_ID)) {
  console.error('❌  ADMIN_ID env var is required (numeric Telegram user id).');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lock
// ─────────────────────────────────────────────────────────────────────────────

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (pid && pid !== process.pid) {
        let alive = false, isOurBot = false;
        try {
          process.kill(pid, 0); alive = true;
          try {
            const cl = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
            isOurBot = cl.includes('node') && cl.includes('index.js');
          } catch (_) {}
        } catch (_) {}
        if (alive && isOurBot) {
          console.error(`❌  بوت آخر يعمل بالفعل (PID ${pid}). أوقفه أولًا.`);
          process.exit(1);
        }
        console.warn(`⚠️  Stale lock from PID ${pid}, taking over.`);
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (e) { console.error('Lock error:', e.message); process.exit(1); }
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) {}
}
acquireLock();

// ─────────────────────────────────────────────────────────────────────────────
// Country codes
// ─────────────────────────────────────────────────────────────────────────────

const COUNTRY_CODES = [
  '1','7','20','27','30','31','32','33','34','36','39','40','41','43','44','45',
  '46','47','48','49','51','52','53','54','55','56','57','58','60','61','62',
  '63','64','65','66','81','82','84','86','90','91','92','93','94','95','98',
  '211','212','213','216','218','220','221','222','223','224','225','226','227',
  '228','229','230','231','232','233','234','235','236','237','238','239','240',
  '241','242','243','244','245','246','247','248','249','250','251','252','253',
  '254','255','256','257','258','260','261','262','263','264','265','266','267',
  '268','269','290','291','297','298','299','350','351','352','353','354','355',
  '356','357','358','359','370','371','372','373','374','375','376','377','378',
  '379','380','381','382','383','385','386','387','389','420','421','423','500',
  '501','502','503','504','505','506','507','508','509','590','591','592','593',
  '594','595','596','597','598','599','670','672','673','674','675','676','677',
  '678','679','680','681','682','683','685','686','687','688','689','690','691',
  '692','800','808','850','852','853','855','856','870','878','880','881','882',
  '883','886','888','960','961','962','963','964','965','966','967','968','970',
  '971','972','973','974','975','976','977','979','992','993','994','995','996',
  '998','1242','1246','1264','1268','1284','1340','1345','1441','1473','1649',
  '1664','1670','1671','1684','1721','1758','1767','1784','1787','1809','1829',
  '1849','1868','1869','1876','1939',
];
const SORTED_CC = [...new Set(COUNTRY_CODES)].sort((a, b) => b.length - a.length);

function stripCountryCode(digits) {
  for (const cc of SORTED_CC) {
    if (digits.startsWith(cc) && digits.length > cc.length) return digits.slice(cc.length);
  }
  return digits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Number utilities
// ─────────────────────────────────────────────────────────────────────────────

function cleanNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

function parseNumberList(text) {
  if (!text) return [];
  const tokens = text.split(/[\s,;،\n\r\t]+/);
  const seen = new Set(), out = [];
  for (const t of tokens) {
    const n = cleanNumber(t);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

/**
 * Group numbers by their 3-digit local prefix (after stripping country code).
 * e.g. 771, 772, 773, 701, 711 ...
 * Returns { prefix: [numbers], ... }
 */
function groupByPrefix(numbers) {
  const groups = {};
  for (const n of numbers) {
    const local = stripCountryCode(n);
    const prefix = local.slice(0, 3);
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(n);
  }
  return groups;
}

/** Fisher-Yates shuffle (in-place, returns array) */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions = new Map();

function getSession(userId) { return sessions.get(userId) || null; }
function setSession(userId, patch) {
  const cur = sessions.get(userId) || { userId };
  const next = { ...cur, ...patch };
  sessions.set(userId, next);
  return next;
}
function deleteSession(userId) { sessions.delete(userId); }

async function wipeSessionFolder(userId) {
  const dir = path.join(SESSIONS_DIR, `session-user-${userId}`);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function hasSessionFolder(userId) {
  const dir = path.join(SESSIONS_DIR, `session-user-${userId}`);
  return fs.existsSync(dir);
}

function statusLabel(state) {
  switch (state) {
    case 'connecting':   return '🟡 جاري الاتصال';
    case 'waiting_qr':   return '🟠 بانتظار QR';
    case 'waiting_code': return '🟠 بانتظار رمز';
    case 'linked':       return '🟢 مربوط';
    case 'failed':       return '🔴 فشل الربط';
    default:             return '⚪️ غير مربوط';
  }
}

function fmtDuration(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp client
// ─────────────────────────────────────────────────────────────────────────────

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-features=site-per-process,TranslateUI,BlinkGenPropertyTrees',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',
];

function resolveChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  try {
    const { execSync } = require('child_process');
    const found = execSync('command -v chromium chromium-browser google-chrome 2>/dev/null | head -1', { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch (_) {}
  return undefined;
}

const CHROMIUM_PATH = resolveChromiumPath();
console.log(CHROMIUM_PATH ? `  • Chromium             : ${CHROMIUM_PATH}` : '  • Chromium             : (using puppeteer bundled)');

function buildClient(userId) {
  return new Client({
    authStrategy: new LocalAuth({ clientId: `user-${userId}`, dataPath: SESSIONS_DIR }),
    puppeteer: {
      headless: true,
      args: PUPPETEER_ARGS,
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    },
    qrMaxRetries: 5,
    takeoverOnConflict: true,
  });
}

async function destroyClient(client) {
  if (!client) return;
  try { await client.destroy(); } catch (_) {}
}

/**
 * mode: 'qr' | 'code' | 'restore'
 * restore = re-use existing session folder, no wipe
 */
async function startLinking(userId, mode, phoneNumber, telegramChatId, loadingMessageId = null) {
  const existing = getSession(userId);
  if (existing && existing.client) await destroyClient(existing.client);

  // Only wipe on fresh link (not restore)
  if (mode !== 'restore') await wipeSessionFolder(userId);

  const client = buildClient(userId);
  setSession(userId, {
    userId, client, mode,
    state: 'connecting',
    chatId: telegramChatId,
    startedAt: Date.now(),
    linkedAt: null,
    accountName: null,
    accountNumber: null,
    pairingCode: null,
    qrMessageId: null,
    loadingMessageId: loadingMessageId || null,
    lastError: null,
  });

  let pairingDelivered = false, qrSeen = false;

  client.on('qr', async (qr) => {
    const firstQr = !qrSeen;
    qrSeen = true;
    if (firstQr && (mode === 'qr' || mode === 'restore')) {
      try { qrcodeTerminal.generate(qr, { small: true }); } catch (_) {}
    }

    if (mode === 'qr' || mode === 'restore') {
      setSession(userId, { state: 'waiting_qr' });
      try {
        const png = await qrcode.toBuffer(qr, { type: 'png', width: 512, margin: 2 });
        const sent = await bot.sendPhoto(telegramChatId, png, {
          caption: '📱 امسح هذا الكود من واتساب → الأجهزة المرتبطة → ربط جهاز.\nالكود صالح لفترة قصيرة فقط.',
        });
        setSession(userId, { qrMessageId: sent.message_id });
      } catch (e) {
        await bot.sendMessage(telegramChatId, `⚠️ تعذر إرسال صورة QR: ${e.message || e}`).catch(() => {});
      }
    } else if (mode === 'code') {
      setSession(userId, { state: 'waiting_code' });
    }
  });

  if (mode === 'code') {
    (async () => {
      const deadline = Date.now() + 25_000;
      while (!qrSeen && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      if (!qrSeen) return;

      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await new Promise((r) => setTimeout(r, attempt === 1 ? 600 : 1500));
          const s = getSession(userId);
          if (!s || s.client !== client) return;
          if (s.state === 'linked' || pairingDelivered) return;

          const code = await client.requestPairingCode(phoneNumber, true);
          if (!code || typeof code !== 'string' || code.length < 6)
            throw new Error(`Invalid response: ${JSON.stringify(code)}`);

          const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
          pairingDelivered = true;
          setSession(userId, { pairingCode: pretty });

          if (loadingMessageId) {
            await bot.editMessageText('🟢 تم تجهيز رمز الربط بنجاح.', {
              chat_id: telegramChatId, message_id: loadingMessageId,
            }).catch(() => {});
          }
          await bot.sendMessage(
            telegramChatId,
            `🔑 *رمز الربط الخاص بك*\n\n\`${pretty}\`\n\n📋 المس الرمز أعلاه لنسخه، ثم افتح:\nواتساب ← الأجهزة المرتبطة ← ربط برقم الهاتف.\n\n⏱ الرمز صالح لفترة قصيرة فقط.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: `📋 نسخ: ${pretty}`, callback_data: `copycode:${pretty}` }],
                  [{ text: '🔙 رجوع', callback_data: 'menu:main' }],
                ],
              },
            }
          ).catch(() => {});
          return;
        } catch (e) {
          lastErr = e;
          console.error(`[pairing attempt ${attempt}/3] ${e.message}`);
        }
      }

      if (!pairingDelivered) {
        const rawMsg = (lastErr && (lastErr.message || String(lastErr))) || 'unknown';
        const isWaRejection = /^t$|^\w$/.test(rawMsg.trim());
        const explain = isWaRejection
          ? 'واتساب رفض طلب رمز الربط. الأسباب الشائعة:\n• الرقم غير مسجّل على واتساب.\n• حد مؤقت من واتساب.\n• ميزة الربط بالرمز غير متاحة لهذا الحساب.'
          : `سبب فني: \`${rawMsg}\``;

        setSession(userId, { state: 'failed', lastError: rawMsg });
        if (loadingMessageId) {
          await bot.editMessageText('🔴 تعذّر تجهيز رمز الربط.', {
            chat_id: telegramChatId, message_id: loadingMessageId,
          }).catch(() => {});
        }
        await bot.sendMessage(
          telegramChatId,
          `❌ *تعذّر توليد رمز الربط.*\n\n${explain}\n\n👈 *الحل الأفضل:* استخدم *📷 ربط عبر QR Code*.`,
          { parse_mode: 'Markdown', reply_markup: linkMenu() }
        ).catch(() => {});
        try { await client.destroy(); } catch (_) {}
        await wipeSessionFolder(userId);
        deleteSession(userId);
      }
    })().catch((e) => console.error('[pairing loop crashed]', e));
  }

  client.on('authenticated', () => setSession(userId, { state: 'connecting' }));

  client.on('auth_failure', async (msg) => {
    setSession(userId, { state: 'failed', lastError: msg || 'auth_failure' });
    await bot.sendMessage(telegramChatId, `❌ فشل المصادقة: ${msg || 'سبب غير معروف'}`).catch(() => {});
    await destroyClient(client);
    await wipeSessionFolder(userId);
    deleteSession(userId);
  });

  client.on('ready', async () => {
    let name = 'Unknown', number = 'Unknown';
    try {
      const info = client.info || {};
      name   = info.pushname || (info.wid && info.wid.user) || 'Unknown';
      number = (info.wid && info.wid.user) ? `+${info.wid.user}` : 'Unknown';
    } catch (_) {}
    setSession(userId, { state: 'linked', linkedAt: Date.now(), accountName: name, accountNumber: number });
    await bot.sendMessage(
      telegramChatId,
      `✅ *تم الربط بنجاح*\n\n👤 الاسم: \`${name}\`\n📞 الرقم: \`${number}\``,
      { parse_mode: 'Markdown', reply_markup: mainMenu(userId) }
    ).catch(() => {});
  });

  client.on('disconnected', async (reason) => {
    setSession(userId, { state: 'not_linked', lastError: String(reason || '') });
    await bot.sendMessage(telegramChatId, `⚠️ انقطع الاتصال: ${reason || 'سبب غير معروف'}\n\nيمكنك استعادة الجلسة من زر *🔗 ربط الحساب*.`, { parse_mode: 'Markdown' }).catch(() => {});
    await destroyClient(client);
    deleteSession(userId);
    // لا نمسح مجلد الجلسة عند الانقطاع حتى يمكن الاستعادة لاحقًا
  });

  try {
    await client.initialize();
  } catch (e) {
    console.error('[client.initialize] failed:', e && e.stack ? e.stack : e);
    setSession(userId, { state: 'failed', lastError: e.message });
    await bot.sendMessage(telegramChatId, `❌ فشل بدء جلسة واتساب: ${e.message || e}`).catch(() => {});
    await destroyClient(client);
    if (mode !== 'restore') await wipeSessionFolder(userId);
    deleteSession(userId);
  }
}

async function logoutUser(userId) {
  const s = getSession(userId);
  if (s && s.client) {
    try { await s.client.logout(); } catch (_) {}
    await destroyClient(s.client);
  }
  await wipeSessionFolder(userId);
  deleteSession(userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Number checking — with rate-limit-friendly delay
// ─────────────────────────────────────────────────────────────────────────────

async function checkOne(client, number) {
  try {
    if (CHECK_DELAY_MS > 0) {
      const jitter = Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, CHECK_DELAY_MS + jitter));
    }
    const id = await client.getNumberId(number);
    return { number, registered: !!id };
  } catch (e) {
    return { number, registered: null, error: e.message };
  }
}

async function runWithConcurrency(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let cursor = 0, done = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  });
  await Promise.all(runners);
  return results;
}

function formatResults(results) {
  const ok  = results.filter((r) => r.registered === true);
  const bad = results.filter((r) => r.registered === false);
  const err = results.filter((r) => r.registered === null);

  const lines = [];
  lines.push(`📊 *ملخص النتائج*`);
  lines.push(`✅ مسجّل: ${ok.length}  |  ❌ غير مسجّل: ${bad.length}  |  ⚠️ خطأ: ${err.length}`);
  lines.push('━━━━━━━━━━━━━');

  if (ok.length) {
    lines.push(`✅ *مسجّل في واتساب [ ${ok.length} ]*`);
    for (const r of ok) lines.push(`✅ \`${r.number}\``);
  } else {
    lines.push('— لا توجد أرقام مسجّلة —');
  }

  lines.push('━━━━━━━━━━━━━');
  lines.push(`❌ *غير مسجّل [ ${bad.length} ]*`);
  for (const r of bad) {
    const local = stripCountryCode(r.number);
    lines.push(`❌ \`${local}\``);
  }

  if (err.length) {
    lines.push('━━━━━━━━━━━━━');
    lines.push(`⚠️ *أخطاء [ ${err.length} ]*`);
    for (const r of err) lines.push(`⚠️ \`${r.number}\``);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// File download helper
// ─────────────────────────────────────────────────────────────────────────────

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram bot
// ─────────────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const userInputMode  = new Map(); // userId -> { kind }
const userFilePending = new Map(); // userId -> { groups: {prefix:[numbers]}, total }

function isAdmin(userId) { return Number(userId) === ADMIN_ID; }

function mainMenu(userId) {
  const rows = [
    [{ text: '🔗 ربط الحساب', callback_data: 'menu:link' }],
    [{ text: '📊 حالة الجلسة', callback_data: 'menu:status' }],
    [{ text: '🔢 فحص الأرقام (نص)', callback_data: 'menu:check' }],
    [{ text: '📂 فحص من ملف', callback_data: 'menu:file' }],
    [{ text: '❓ مساعدة', callback_data: 'menu:help' }],
  ];
  return { inline_keyboard: rows };
}

function statusMenu(userId) {
  const s = getSession(userId);
  const rows = [];
  if (s && s.state === 'linked') {
    rows.push([{ text: '🚪 تسجيل خروج من الجلسة', callback_data: 'menu:logout' }]);
  }
  rows.push([{ text: '🔙 رجوع', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

function backMenu() {
  return { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'menu:main' }]] };
}

function linkMenu(userId) {
  const hasSaved = userId && hasSessionFolder(userId);
  const rows = [
    [{ text: '📷 ربط عبر QR Code', callback_data: 'link:qr' }],
    [{ text: '📞 ربط عبر رقم الهاتف', callback_data: 'link:code' }],
  ];
  if (hasSaved) {
    rows.push([{ text: '🔄 استعادة الجلسة المحفوظة', callback_data: 'link:restore' }]);
  }
  rows.push([{ text: '🔙 رجوع', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

const HELP_TEXT =
  '*📖 دليل الاستخدام*\n\n' +
  '🔗 *ربط الحساب* — ربط واتساب عبر QR أو رمز أو استعادة جلسة محفوظة.\n' +
  '📊 *حالة الجلسة* — معلومات الحساب المربوط.\n' +
  '🔢 *فحص الأرقام (نص)* — أرسل أرقامًا مباشرةً (حتى 500).\n' +
  '📂 *فحص من ملف* — أرسل ملف .txt وسيسألك عن البادئة (77، 78...) ليفحص أول 100 رقم منها.\n\n' +
  '*الأوامر:*\n' +
  '/start — القائمة الرئيسية\n' +
  '/link — ربط حساب\n' +
  '/check — فحص أرقام (نص)\n' +
  '/file — فحص من ملف\n' +
  '/status — حالة الجلسة\n' +
  '/help — هذه الرسالة\n' +
  '/logout — تسجيل خروج (أدمن)\n';

function statusText(userId) {
  const s = getSession(userId);
  const hasSaved = hasSessionFolder(userId);
  if (!s) {
    return (
      `*حالة الجلسة:* ${statusLabel('not_linked')}\n\n` +
      (hasSaved
        ? '💾 يوجد جلسة محفوظة — اضغط *🔗 ربط الحساب* ثم *🔄 استعادة الجلسة المحفوظة*.'
        : 'استخدم زر *🔗 ربط الحساب* للبدء.')
    );
  }
  const lines = [
    `*حالة الجلسة:* ${statusLabel(s.state)}`,
    s.accountName   ? `👤 الاسم: \`${s.accountName}\``   : null,
    s.accountNumber ? `📞 الرقم: \`${s.accountNumber}\`` : null,
    s.startedAt     ? `🕒 وقت البدء: \`${new Date(s.startedAt).toLocaleString('ar-EG')}\`` : null,
    s.linkedAt      ? `⏱️ مدة الاتصال: \`${fmtDuration(Date.now() - s.linkedAt)}\`` : null,
    hasSaved        ? `💾 جلسة محفوظة: نعم` : null,
    s.lastError     ? `⚠️ آخر خطأ: \`${s.lastError}\`` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Command bar
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await bot.setMyCommands([
      { command: 'start',  description: 'القائمة الرئيسية' },
      { command: 'link',   description: 'ربط حساب واتساب' },
      { command: 'check',  description: 'فحص أرقام (نص)' },
      { command: 'file',   description: 'فحص من ملف نصي' },
      { command: 'status', description: 'حالة الجلسة' },
      { command: 'help',   description: 'المساعدة' },
    ]);
    if (ADMIN_ID) {
      await bot.setMyCommands(
        [
          { command: 'start',  description: 'القائمة الرئيسية' },
          { command: 'link',   description: 'ربط حساب واتساب' },
          { command: 'check',  description: 'فحص أرقام (نص)' },
          { command: 'file',   description: 'فحص من ملف نصي' },
          { command: 'status', description: 'حالة الجلسة' },
          { command: 'help',   description: 'المساعدة' },
          { command: 'logout', description: 'تسجيل خروج (أدمن)' },
        ],
        { scope: { type: 'chat', chat_id: ADMIN_ID } }
      );
    }
  } catch (e) { console.warn('setMyCommands failed:', e.message); }
})();

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function sendMain(chatId, userId) {
  await bot.sendMessage(chatId, '👋 *أهلًا بك في بوت فحص أرقام واتساب*\nاختر من القائمة:', {
    parse_mode: 'Markdown',
    reply_markup: mainMenu(userId),
  });
}

bot.onText(/^\/start\b/, async (msg) => { await sendMain(msg.chat.id, msg.from.id); });
bot.onText(/^\/help\b/,  async (msg) => {
  await bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown', reply_markup: backMenu() });
});
bot.onText(/^\/status\b/, async (msg) => {
  await bot.sendMessage(msg.chat.id, statusText(msg.from.id), { parse_mode: 'Markdown', reply_markup: statusMenu(msg.from.id) });
});
bot.onText(/^\/link\b/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🔗 *اختر طريقة الربط:*', { parse_mode: 'Markdown', reply_markup: linkMenu(msg.from.id) });
});
bot.onText(/^\/check\b/, async (msg) => { await beginCheckFlow(msg.chat.id, msg.from.id); });
bot.onText(/^\/file\b/,  async (msg) => { await beginFileFlow(msg.chat.id, msg.from.id); });
bot.onText(/^\/logout\b/, async (msg) => {
  await logoutUser(msg.from.id);
  await bot.sendMessage(msg.chat.id, '🚪 تم تسجيل الخروج وحذف الجلسة.', { reply_markup: mainMenu(msg.from.id) });
});

async function beginCheckFlow(chatId, userId) {
  const s = getSession(userId);
  if (!s || s.state !== 'linked') {
    await bot.sendMessage(chatId, '⚠️ يجب ربط حسابك أولًا. استخدم زر *🔗 ربط الحساب*.', {
      parse_mode: 'Markdown', reply_markup: backMenu(),
    });
    return;
  }
  userInputMode.set(userId, { kind: 'awaiting_numbers' });
  await bot.sendMessage(
    chatId,
    `🔢 أرسل قائمة الأرقام (من 1 إلى ${MAX_NUMBERS}).\nيمكنك فصلها بفواصل أو مسافات أو أسطر — مع أو بدون +.`,
    { reply_markup: backMenu() }
  );
}

async function beginFileFlow(chatId, userId) {
  const s = getSession(userId);
  if (!s || s.state !== 'linked') {
    await bot.sendMessage(chatId, '⚠️ يجب ربط حسابك أولًا. استخدم زر *🔗 ربط الحساب*.', {
      parse_mode: 'Markdown', reply_markup: backMenu(),
    });
    return;
  }
  userInputMode.set(userId, { kind: 'awaiting_file' });
  await bot.sendMessage(
    chatId,
    '📂 أرسل الملف النصي (.txt) الذي يحتوي على الأرقام.\nسأحلّله وأسألك عن البادئة التي تريد فحصها (77، 78، 70، 71...).',
    { reply_markup: backMenu() }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback query handler
// ─────────────────────────────────────────────────────────────────────────────

bot.on('callback_query', async (q) => {
  const userId = q.from.id;
  const chatId = q.message.chat.id;
  const data   = q.data || '';

  try {
    // ── prefix check from file ──────────────────────────────────────────────
    if (data.startsWith('pfx:')) {
      const prefix  = data.slice(4);
      const pending = userFilePending.get(userId);
      if (!pending || !pending.groups[prefix]) {
        await bot.answerCallbackQuery(q.id, { text: '⚠️ انتهت صلاحية الاختيار. أرسل الملف مجددًا.', show_alert: true });
        return;
      }
      const session = getSession(userId);
      if (!session || session.state !== 'linked' || !session.client) {
        await bot.answerCallbackQuery(q.id, { text: '⚠️ الجلسة غير مربوطة.', show_alert: true });
        return;
      }

      // تهيئة مجموعة المفحوصين لهذه البادئة إن لم تكن موجودة
      if (!pending.checked) pending.checked = {};
      if (!pending.checked[prefix]) pending.checked[prefix] = new Set();
      const checkedSet = pending.checked[prefix];

      // الأرقام المتبقية (غير المفحوصة بعد)
      const remaining = pending.groups[prefix].filter((n) => !checkedSet.has(n));

      if (remaining.length === 0) {
        await bot.answerCallbackQuery(q.id, { text: '✅ تم فحص جميع أرقام هذه البادئة من قبل!', show_alert: true });
        return;
      }

      // اختيار 100 رقم عشوائي من المتبقين
      const picked = shuffle([...remaining]).slice(0, MAX_PER_PREFIX);
      for (const n of picked) checkedSet.add(n);

      const leftAfter = remaining.length - picked.length;

      await bot.answerCallbackQuery(q.id).catch(() => {});

      // إظهار عدد المتبقين بعد هذه الجولة
      await bot.sendMessage(
        chatId,
        `🎲 جولة عشوائية من البادئة *${prefix}*\n📦 ${picked.length} رقم للفحص | 🔁 متبقٍ: ${leftAfter} رقم`,
        { parse_mode: 'Markdown' }
      );

      await runCheckAndReport(chatId, userId, picked, session.client);

      // لو لا تزال هناك أرقام متبقية، أعد عرض الأزرار
      if (leftAfter > 0) {
        await bot.sendMessage(chatId, `♻️ يمكنك الضغط على نفس الزر للحصول على ${Math.min(leftAfter, MAX_PER_PREFIX)} رقم جديد.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: `🔁 جولة جديدة من ${prefix} (${leftAfter} متبقٍ)`, callback_data: `pfx:${prefix}` }],
              [{ text: '🔙 رجوع للقائمة', callback_data: 'menu:main' }],
            ],
          },
        });
      }
      return;
    }

    // ── copycode ────────────────────────────────────────────────────────────
    if (data.startsWith('copycode:')) {
      const code = data.slice('copycode:'.length);
      await bot.answerCallbackQuery(q.id, { text: `الرمز: ${code}`, show_alert: true });
      return;
    }

    // ── menu actions ────────────────────────────────────────────────────────
    switch (data) {
      case 'menu:main':
        await bot.editMessageReplyMarkup(mainMenu(userId), { chat_id: chatId, message_id: q.message.message_id })
          .catch(async () => sendMain(chatId, userId));
        break;
      case 'menu:link':
        await bot.sendMessage(chatId, '🔗 *اختر طريقة الربط:*', { parse_mode: 'Markdown', reply_markup: linkMenu(userId) });
        break;
      case 'menu:status':
        await bot.sendMessage(chatId, statusText(userId), { parse_mode: 'Markdown', reply_markup: statusMenu(userId) });
        break;
      case 'menu:help':
        await bot.sendMessage(chatId, HELP_TEXT, { parse_mode: 'Markdown', reply_markup: backMenu() });
        break;
      case 'menu:check':
        await beginCheckFlow(chatId, userId);
        break;
      case 'menu:file':
        await beginFileFlow(chatId, userId);
        break;
      case 'menu:logout':
        await logoutUser(userId);
        await bot.sendMessage(chatId, '🚪 تم تسجيل الخروج وحذف الجلسة.', { reply_markup: mainMenu(userId) });
        break;

      // ── link methods ──────────────────────────────────────────────────────
      case 'link:qr':
        await bot.sendMessage(chatId, '🟡 جاري تحضير QR Code...');
        await startLinking(userId, 'qr', null, chatId);
        break;

      case 'link:code':
        userInputMode.set(userId, { kind: 'awaiting_phone' });
        await bot.sendMessage(chatId, '📞 أرسل رقم هاتفك بصيغة دولية (مثال: 9677XXXXXXXX) بدون + ولا مسافات.', { reply_markup: backMenu() });
        break;

      case 'link:restore':
        if (!hasSessionFolder(userId)) {
          await bot.sendMessage(chatId, '❌ لا توجد جلسة محفوظة. استخدم ربطًا جديدًا.', { reply_markup: linkMenu(userId) });
        } else {
          await bot.sendMessage(chatId, '🔄 جاري استعادة الجلسة المحفوظة...');
          await startLinking(userId, 'restore', null, chatId);
        }
        break;
    }

    await bot.answerCallbackQuery(q.id).catch(() => {});
  } catch (e) {
    await bot.answerCallbackQuery(q.id, { text: `خطأ: ${e.message}`, show_alert: true }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Text message handler
// ─────────────────────────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const mode   = userInputMode.get(userId);
  if (!mode) return;

  // ── awaiting phone number ─────────────────────────────────────────────────
  if (mode.kind === 'awaiting_phone') {
    userInputMode.delete(userId);
    const phone = cleanNumber(msg.text);
    if (!phone) {
      await bot.sendMessage(chatId, '❌ رقم غير صالح. حاول مجددًا.', { parse_mode: 'Markdown', reply_markup: backMenu() });
      return;
    }
    const loadingMsg = await bot.sendMessage(chatId, '🟡 جاري تجهيز رمز الربط...');
    await startLinking(userId, 'code', phone, chatId, loadingMsg.message_id);
    return;
  }

  // ── awaiting numbers list ─────────────────────────────────────────────────
  if (mode.kind === 'awaiting_numbers') {
    userInputMode.delete(userId);
    const numbers = parseNumberList(msg.text);
    if (numbers.length === 0) {
      await bot.sendMessage(chatId, '❌ لم أتمكن من استخراج أرقام صالحة.', { reply_markup: backMenu() });
      return;
    }
    if (numbers.length > MAX_NUMBERS) {
      await bot.sendMessage(chatId, `❌ الحد الأقصى ${MAX_NUMBERS} رقمًا في كل دفعة.`, { reply_markup: backMenu() });
      return;
    }
    const session = getSession(userId);
    if (!session || session.state !== 'linked' || !session.client) {
      await bot.sendMessage(chatId, '⚠️ الجلسة غير مربوطة الآن.', { reply_markup: backMenu() });
      return;
    }
    await runCheckAndReport(chatId, userId, numbers, session.client);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Document (file) handler
// ─────────────────────────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.document) return;
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const mode   = userInputMode.get(userId);
  if (!mode || mode.kind !== 'awaiting_file') return;

  userInputMode.delete(userId);

  const doc = msg.document;
  const name = (doc.file_name || '').toLowerCase();
  if (!name.endsWith('.txt') && !name.endsWith('.csv')) {
    await bot.sendMessage(chatId, '❌ يُقبل فقط ملفات .txt أو .csv.', { reply_markup: backMenu() });
    return;
  }
  if (doc.file_size > 5 * 1024 * 1024) {
    await bot.sendMessage(chatId, '❌ حجم الملف كبير جدًا (الحد الأقصى 5 MB).', { reply_markup: backMenu() });
    return;
  }

  const session = getSession(userId);
  if (!session || session.state !== 'linked' || !session.client) {
    await bot.sendMessage(chatId, '⚠️ الجلسة غير مربوطة. ارتبط أولًا.', { reply_markup: backMenu() });
    return;
  }

  const processingMsg = await bot.sendMessage(chatId, '⏳ جاري قراءة الملف وتحليل الأرقام...');

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const buf      = await downloadBuffer(fileLink);
    const text     = buf.toString('utf8');
    const numbers  = parseNumberList(text);

    if (numbers.length === 0) {
      await bot.editMessageText('❌ لم أجد أرقامًا صالحة داخل الملف.', {
        chat_id: chatId, message_id: processingMsg.message_id,
      }).catch(() => {});
      return;
    }

    const groups  = groupByPrefix(numbers);
    const prefixes = Object.keys(groups).sort();

    if (prefixes.length === 0) {
      await bot.editMessageText('❌ لم أستطع تحديد البادئات.', {
        chat_id: chatId, message_id: processingMsg.message_id,
      }).catch(() => {});
      return;
    }

    // حفظ البيانات للمستخدم
    userFilePending.set(userId, { groups, total: numbers.length });

    // بناء أزرار البادئات (كل زر يعرض البادئة الثلاثية وعدد أرقامها)
    const prefixButtons = prefixes.map((p) => [{
      text: `📞 ${p}  —  ${groups[p].length} رقم  🎲 100 عشوائي/جولة`,
      callback_data: `pfx:${p}`,
    }]);
    prefixButtons.push([{ text: '🔙 رجوع', callback_data: 'menu:main' }]);

    await bot.editMessageText(
      `📂 *تم تحليل الملف*\n\n📊 إجمالي الأرقام: *${numbers.length}*\n🔢 عدد البادئات: *${prefixes.length}*\n\n👇 اختر البادئة (ثلاثة أرقام) للفحص:\nكل ضغطة = 100 رقم عشوائي جديد بدون تكرار`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: prefixButtons },
      }
    ).catch(async () => {
      await bot.sendMessage(chatId,
        `📂 *تم تحليل الملف* — ${numbers.length} رقم\n\n👇 اختر البادئة:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: prefixButtons } }
      );
    });
  } catch (e) {
    console.error('[file handler]', e);
    await bot.editMessageText(`❌ خطأ في قراءة الملف: ${e.message || e}`, {
      chat_id: chatId, message_id: processingMsg.message_id,
    }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared check + report
// ─────────────────────────────────────────────────────────────────────────────

async function runCheckAndReport(chatId, userId, numbers, client) {
  const progressMsg = await bot.sendMessage(chatId, `⏳ جاري الفحص: 0 / ${numbers.length}`);
  let lastEdit = 0;
  let finished = false; // يوقف تحديثات التقدم بعد انتهاء الفحص

  const onProgress = (done, total) => {
    if (finished) return;
    const now = Date.now();
    if (now - lastEdit > 1500 || done === total) {
      lastEdit = now;
      bot.editMessageText(`⏳ جاري الفحص: ${done} / ${total}`, {
        chat_id: chatId, message_id: progressMsg.message_id,
      }).catch(() => {});
    }
  };

  try {
    const results = await runWithConcurrency(numbers, CHECK_CONCURRENCY, (n) => checkOne(client, n), onProgress);

    // أوقف أي تحديث تقدم معلّق قبل الكتابة النهائية
    finished = true;
    await new Promise((r) => setTimeout(r, 300));

    const text = formatResults(results);

    // حذف رسالة التقدم وإرسال النتائج كرسالة جديدة (يتجنب تعارض التعديلات)
    await bot.deleteMessage(chatId, progressMsg.message_id).catch(() => {});
    await sendChunked(chatId, text, { parse_mode: 'Markdown', reply_markup: mainMenu(userId) });

  } catch (e) {
    finished = true;
    await bot.editMessageText(`❌ فشل الفحص: ${e.message}`, {
      chat_id: chatId, message_id: progressMsg.message_id,
    }).catch(() => {});
  }
}

async function sendChunked(chatId, text, opts) {
  const MAX = 3800;
  if (text.length <= MAX) return bot.sendMessage(chatId, text, opts);
  const parts = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > MAX) { parts.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) parts.push(buf);
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    await bot.sendMessage(chatId, parts[i], isLast ? opts : { parse_mode: opts && opts.parse_mode });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

bot.on('polling_error', (err) => {
  if (err && err.code === 'ETELEGRAM' && /409/.test(err.message || '')) {
    console.error('❌  تعارض Telegram (409): يوجد بوت آخر. أوقفه ثم أعد التشغيل.');
    process.exit(2);
  }
  console.warn('polling_error:', err.message || err);
});
bot.on('error', (err) => { console.warn('bot error:', err.message || err); });

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);
  try { await bot.stopPolling({ cancel: true }); } catch (_) {}
  for (const [, s] of sessions) await destroyClient(s.client);
  releaseLock();
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

// ─────────────────────────────────────────────────────────────────────────────
// Banner
// ─────────────────────────────────────────────────────────────────────────────

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  🤖  Telegram ⇄ WhatsApp Number Checker');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  • Admin ID            : ${ADMIN_ID}`);
console.log(`  • Sessions dir        : ${SESSIONS_DIR}`);
console.log(`  • Lock file           : ${LOCK_FILE}`);
console.log(`  • Concurrency         : ${CHECK_CONCURRENCY}`);
console.log(`  • Check delay (ms)    : ${CHECK_DELAY_MS}`);
console.log(`  • Host                : ${os.hostname()}`);
console.log('  • Bot is running. Press Ctrl+C to stop.');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
