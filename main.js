// ============================================
// WhatsApp Otonom Ajan Sistemi — Ana Giriş Noktası
// ============================================

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const MissionManager = require('./src/missionManager');
const GeminiClient = require('./src/geminiClient');
const { parseCommand, parseStopCommand, parseUtilityCommand } = require('./src/commandParser');
const CONFIG = require('./src/config');

// WhatsApp Client oluştur
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
        ],
    },
});

// Görev Yöneticisi
const missionManager = new MissionManager(client);

// Gemini bağlantı kontrolü
const aiClient = new GeminiClient();

// ============================================
// WhatsApp Olayları
// ============================================

client.on('qr', (qr) => {
    console.log('📲 QR Code taratın:');
    qrcode.generate(qr, { small: true });
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Yükleniyor: %${percent} — ${message}`);
});

client.once('ready', async () => {
    const myNumber = client.info.wid.user;
    missionManager.setMyNumber(myNumber);

    // Gemini sunucu/CLI kontrolü
    const aiOk = await aiClient.healthCheck();
    console.log(aiOk
        ? '🧠 Gemini CLI bağlantısı başarılı ve hazır.'
        : '⚠️ Gemini CLI ulaşılamıyor veya kurulu değil! Görevler başlatılamayacak.'
    );

    // Kalıcı hafızayı geri yükle
    missionManager.restoreMissions();

    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  ✅ WhatsApp Otonom Ajan Sistemi Hazır!');
    console.log('═══════════════════════════════════════════');
    console.log(`  📱 Hesap : ${myNumber}`);
    console.log(`  🧠 Model : ${CONFIG.gemini?.model || 'Varsayılan'}`);
    console.log(`  🌐 Gemini: ${aiOk ? 'Bağlı ✅' : 'Bağlantı Yok ❌'}`);
    console.log('');
    console.log('  Komutlar:');
    console.log('  !ai <numara> <görev>  → Yeni görev başlat');
    console.log('  !stop [id]            → Görevi durdur');
    console.log('  !durum                → Aktif görevleri listele');
    console.log('  !liste                → Aktif görevleri listele');
    console.log('  !ping                 → Bağlantı testi');
    console.log('═══════════════════════════════════════════');
    console.log('');
});

client.on('authenticated', () => {
    console.log('🔐 Kimlik doğrulama başarılı, senkronize ediliyor...');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Kimlik doğrulama hatası:', msg);
});

client.on('disconnected', (reason) => {
    console.log('🔌 Bağlantı kesildi:', reason);
});

// ============================================
// Mesaj İşleme (Ana Router)
// ============================================

/**
 * Gelen mesajı aktif görevlere yönlendirir.
 * @param {Object} message - WhatsApp Web JS mesaj objesi
 * @param {string} overrideChatId - (Opsiyonel) Zorunlu chatId (self-test için)
 */
async function routeToMission(message, overrideChatId = null) {
    const senderChatId = overrideChatId || message.from;
    const body = message.body;

    let contactNumber = null;
    let senderName = null;
    try {
        const contact = await message.getContact();
        if (contact) {
            if (contact.number) contactNumber = contact.number;
            senderName = contact.pushname || contact.name || contact.shortName || contact.number;
        }
    } catch (e) {
        // Hata olursa null kalır
    }

    const handled = await missionManager.handleIncomingMessage(senderChatId, body, contactNumber, senderName);
    if (handled) {
        console.log(`📥 [GÖREV YÖNLENDİRİLDİ] (${senderChatId}): ${body}`);
        return true;
    }
    return false;
}

// ─────────────────────────────────────────────
// message_create: Tüm mesajlar (giden + gelen)
// Kullanıcının kendi !ai komutlarını yakalar
// ─────────────────────────────────────────────
client.on('message_create', async (message) => {
    const myChatId = `${missionManager.myNumber}@c.us`;
    const fromMe = message.fromMe;
    const chatId = message.from;
    const body = message.body;

    // Bot hazır değilse veya boş mesajsa atla
    if (!missionManager.myNumber || !body || body.trim() === '') return;

    // ─────────────────────────────────────
    // 1. Kendi kendime mesaj (Komut Modu)
    // ─────────────────────────────────────
    if (fromMe && chatId === myChatId) {

        // --- !ai komutu: Yeni görev başlat ---
        if (body.startsWith('!ai ')) {
            console.log(`\n🎯 Yeni görev komutu alındı: ${body}`);

            const mission = await parseCommand(body, client);

            if (!mission) return;
            if (mission.error) {
                await client.sendMessage(myChatId, mission.error);
                return;
            }

            const statusMsg = await missionManager.startMission(mission);
            await client.sendMessage(myChatId, statusMsg);
            return;
        }

        // --- !stop komutu: Görevi durdur ---
        const stopId = parseStopCommand(body);
        if (stopId !== null) {
            const result = missionManager.stopMission(stopId);
            await client.sendMessage(myChatId, result);
            return;
        }

        // --- Yardımcı komutlar ---
        const utilCmd = parseUtilityCommand(body);
        if (utilCmd === 'status' || utilCmd === 'list') {
            const report = missionManager.getStatusReport();
            await client.sendMessage(myChatId, report);
            return;
        }

        // --- !ping komutu: Bağlantı testi ---
        if (body.trim().toLowerCase() === '!ping') {
            await message.reply('pong 🏓');
            return;
        }

        // ─────────────────────────────────────
        // Komut değilse: Belki kendi numaramıza
        // yönelik aktif bir görev vardır (self-test)
        // ─────────────────────────────────────
        const routed = await routeToMission(message, myChatId);
        if (routed) return;

        return; // Diğer kendi mesajlarımı işleme
    }
});

// ─────────────────────────────────────────────
// message: Sadece gelen mesajlar (dışarıdan)
// Hedef kişiden gelen cevapları yakalar
// ─────────────────────────────────────────────
client.on('message', async (message) => {
    // Bot hazır değilse veya boş mesajsa atla
    if (!missionManager.myNumber || !message.body || message.body.trim() === '') return;

    const senderChatId = message.from;
    const body = message.body;

    // Konsol logu
    try {
        const chat = await message.getChat();
        console.log(`\n📨 Gelen mesaj: ${chat.name} (${senderChatId}): ${body}`);
    } catch {
        console.log(`\n📨 Gelen mesaj: (${senderChatId}): ${body}`);
    }

    // Görev yöneticisine yönlendir
    await routeToMission(message);
});

// ============================================
// Başlat
// ============================================
console.log('');
console.log('🚀 WhatsApp Otonom Ajan Sistemi başlatılıyor...');
console.log('');
client.initialize();
