# دليل تثبيت بوت WhatsApp على Termux (Android)
## المشروع
بوت تيليغرام يتصل بـ WhatsApp للتحقق من أرقام الهاتف.
- المكتبات: `whatsapp-web.js`, `node-telegram-bot-api`, `puppeteer`
- المتطلبات: Node.js, Chromium, pnpm, pm2

---

## المشاكل التي واجهناها والحلول

| المشكلة | الحل |
|--------|------|
| proot-Ubuntu لا يشغّل Chromium | استخدام proot-Debian بدلاً منه |
| `pnpm` مكسور عند التثبيت | حذف `/usr/lib/node_modules/pnpm` ثم إعادة التثبيت |
| Chromium غير موجود | تثبيته عبر `apt install chromium` |
| `BOT_TOKEN` مطلوب | إنشاء ملف `.env` بالمتغيرات |
| puppeteer يحاول تحميل Chromium خاص به | ضبط `PUPPETEER_SKIP_DOWNLOAD=true` و `PUPPETEER_EXECUTABLE_PATH` |
| مساحة التخزين تحذير أثناء تثبيت Chromium | التثبيت يكتمل رغم التحذير في الغالب |

---

## خطوات التثبيت من الصفر

### الخطوة 1 — في Termux الأساسي
```bash
pkg update -y
pkg install proot-distro -y
proot-distro install debian
proot-distro login debian
```

### الخطوة 2 — داخل Debian: تثبيت الأدوات
```bash
apt update -y
apt install -y nodejs npm chromium
```

### الخطوة 3 — تثبيت pnpm
```bash
# إذا ظهر خطأ ENOTEMPTY، احذف المجلد أولاً:
rm -rf /usr/lib/node_modules/pnpm
npm install -g pnpm
# تحقق:
pnpm --version
```

### الخطوة 4 — تثبيت pm2
```bash
npm install -g pm2
```

### الخطوة 5 — نقل ملفات البوت
```bash
mkdir ~/bot
tar -xzf /sdcard/Download/bot-project.tar.gz -C ~/bot
ls ~/bot
# يجب أن يظهر: index.js  package.json
```

### الخطوة 6 — تثبيت مكتبات البوت
```bash
cd ~/bot
PUPPETEER_SKIP_DOWNLOAD=true pnpm install
```

### الخطوة 7 — إنشاء ملف الإعدادات
```bash
cat > ~/bot/.env << 'EOF'
PUPPETEER_SKIP_DOWNLOAD=true
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
BOT_TOKEN=ضع_توكن_البوت_هنا
ADMIN_ID=ضع_آيدي_التيليغرام_هنا
EOF
```

### الخطوة 8 — تشغيل البوت
```bash
cd ~/bot
export $(grep -v '^#' .env | xargs)
pm2 start index.js --name "whatsapp-bot"
pm2 logs whatsapp-bot
```

### الخطوة 9 — حفظ البوت ليبقى شغّالاً
```bash
# اضغط Ctrl+C للخروج من السجلات أولاً، ثم:
pm2 save
```

---

## التحقق من نجاح التثبيت
بعد `pm2 logs whatsapp-bot` يجب أن يظهر:
```
• Chromium  : /usr/bin/chromium
🤖 Telegram ⇄ WhatsApp Number Checker
• Bot is running. Press Ctrl+C to stop.
```

---

## أوامر مفيدة يومياً
```bash
# الدخول لـ Debian من Termux
proot-distro login debian

# عرض حالة البوت
pm2 status

# عرض السجلات المباشرة
pm2 logs whatsapp-bot

# إعادة تشغيل البوت
pm2 restart whatsapp-bot

# إيقاف البوت
pm2 stop whatsapp-bot
```

---

## ملاحظات مهمة
- لا تشغّل نسختين من البوت بنفس الـ `BOT_TOKEN` في نفس الوقت
- مجلد الجلسات في `~/bot/sessions/` — احتفظ بنسخة منه لتجنب ربط WhatsApp من جديد
- إذا انقطع النت وأعيد الاتصال، pm2 يُشغّل البوت تلقائياً
- الـ `ADMIN_ID` هو آيدي حسابك في تيليغرام (رقم) — احصل عليه من @userinfobot
