/**
 * @file main.js
 * @description Otonom WhatsApp Ajanı'nın (Gemini Destekli) ana giriş noktasıdır.
 * `whatsapp-web.js` kütüphanesini kullanarak WhatsApp Web oturumunu başlatır, 
 * QR kod ile kimlik doğrulamayı yönetir ve gelen tüm mesaj olaylarını (events) 
 * katmanlı bir middleware pipeline üzerinden işler.
 * 
 * Mimari (Faz 2A):
 * ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
 * │  Guard   │──▶│ Contact   │──▶│   LID    │──▶│  Media   │──▶│ Command/ │
 * │ Filter   │   │ Resolver  │   │ Resolver │   │ Handler  │   │ Mission  │
 * └──────────┘   └───────────┘   └──────────┘   └──────────┘   └──────────┘
 * 
 * @module MainGateway
 */
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const MissionManager = require('./src/missionManager');
const GeminiClient = require('./src/geminiClient');
const LidResolver = require('./src/lidResolver');
const { parseCommand, parseStopCommand, parseUtilityCommand } = require('./src/commandParser');
const {
    MessagePipeline,
    createContactResolverMiddleware,
    createLidResolverMiddleware,
    createMediaHandlerMiddleware,
    createGuardMiddleware,
    createCommandRouterMiddleware,
    createMissionRouterMiddleware,
    createIncomingLoggerMiddleware,
} = require('./src/messagePipeline');
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

// LID Çözümleyici (Merkezi @lid → telefon eşleşme cache'i)
const lidResolver = new LidResolver(client);

// Gemini bağlantı kontrolü
const aiClient = new GeminiClient();

// ════════════════════════════════════════════════════════
// Middleware Pipeline'ları (Faz 2A)
// ════════════════════════════════════════════════════════

// Pipeline 1: Gelen mesajlar (dışarıdan)
const incomingPipeline = new MessagePipeline();
incomingPipeline
    .use('guard', createGuardMiddleware(missionManager))
    .use('logger', createIncomingLoggerMiddleware())
    .use('contactResolver', createContactResolverMiddleware())
    .use('lidResolver', createLidResolverMiddleware(lidResolver))
    .use('mediaHandler', createMediaHandlerMiddleware())
    .use('missionRouter', createMissionRouterMiddleware(missionManager));

// Pipeline 2: Kendi mesajlarım (komut modu)
const selfPipeline = new MessagePipeline();
selfPipeline
    .use('guard', createGuardMiddleware(missionManager))
    .use('commandRouter', createCommandRouterMiddleware({
        client,
        missionManager,
        parseCommand,
        parseStopCommand,
        parseUtilityCommand,
    }))
    .use('selfMissionRouter', createMissionRouterMiddleware(missionManager));

// ════════════════════════════════════════════════════════
// EventEmitter Dinleyicileri (Faz 2C)
// ════════════════════════════════════════════════════════

missionManager.on('mission:started', (data) => {
    console.log(`📡 [EVENT] Görev başladı: #${data.missionId} → ${data.target}`);
});

missionManager.on('mission:completed', (data) => {
    console.log(`📡 [EVENT] Görev tamamlandı: #${data.missionId} (${data.status})`);
});

missionManager.on('mission:stopped', (data) => {
    console.log(`📡 [EVENT] Görev durduruldu: #${data.missionId}`);
});

missionManager.on('mission:reply_sent', (data) => {
    if (data.relevance === 'off_topic') {
        console.log(`📡 [EVENT] Off-topic yanıt: #${data.missionId}`);
    }
});

// ============================================
// WhatsApp Olayları
// ============================================

let readyFired = false;
let authTimeout = null;
let isRestarting = false;

client.on('qr', (qr) => {
    console.log('📲 QR Code taratın:');
    qrcode.generate(qr, { small: true });
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Yükleniyor: %${percent} — ${message}`);
});

client.once('ready', async () => {
    readyFired = true;
    if (authTimeout) clearTimeout(authTimeout);
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

    // LID cache'ini diskten yükle
    lidResolver.loadFromDisk();

    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  ✅ WhatsApp Otonom Ajan Sistemi Hazır!');
    console.log('═══════════════════════════════════════════');
    console.log(`  📱 Hesap : ${myNumber}`);
    console.log(`  🧠 Model : ${CONFIG.gemini?.model || 'Varsayılan'}`);
    console.log(`  🌐 Gemini: ${aiOk ? 'Bağlı ✅' : 'Bağlantı Yok ❌'}`);
    console.log(`  🔧 Pipeline: incoming[${incomingPipeline.list().length}] + self[${selfPipeline.list().length}] middleware`);
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
    if (readyFired || isRestarting) return;
    console.log('🔐 Kimlik doğrulama başarılı, senkronize ediliyor...');
    
    if (authTimeout) clearTimeout(authTimeout);
    
    // WhatsApp-web.js'te bilinen bir sorun: İlk girişte ready eventi bazen tetiklenmiyor.
    // Kullanıcının manuel olarak Ctrl+C yapıp tekrar başlatmasını otomatikleştiriyoruz.
    authTimeout = setTimeout(async () => {
        if (!readyFired && !isRestarting) {
            isRestarting = true;
            console.log('⚠️ Senkronizasyon çok uzun sürdü (ready event alınamadı).');
            console.log('🔄 İstemci otomatik olarak arka planda yeniden başlatılıyor...');
            try {
                await client.destroy();
                // Tarayıcının kapanması için kısa bir süre bekle
                await new Promise(resolve => setTimeout(resolve, 2000));
                isRestarting = false;
                client.initialize();
            } catch (err) {
                console.error('❌ Yeniden başlatma başarısız oldu:', err);
                isRestarting = false;
            }
        }
    }, 15000); // 15 saniye bekle
});

client.on('auth_failure', (msg) => {
    console.error('❌ Kimlik doğrulama hatası:', msg);
});

client.on('disconnected', (reason) => {
    console.log('🔌 Bağlantı kesildi:', reason);
});

// ============================================
// Mesaj İşleme (Pipeline Tabanlı — Faz 2A)
// ============================================

// ─────────────────────────────────────────────
// message_create: Tüm mesajlar (giden + gelen)
// Kullanıcının kendi !ai komutlarını yakalar
// ─────────────────────────────────────────────
client.on('message_create', async (message) => {
    const fromMe = message.fromMe;
    const chatId = message.from;
    const body = message.body;

    // Sadece kendi mesajlarım (komut modu)
    if (!fromMe) return;
    const myChatId = `${missionManager.myNumber}@c.us`;
    if (chatId !== myChatId) return;

    // Pipeline context oluştur
    const context = {
        message,
        chatId,
        body: body || '',
        fromMe: true,
        contactNumber: null,
        senderName: null,
        media: null,
        hasMedia: false,
        handled: false,
    };

    await selfPipeline.process(context);
});

// ─────────────────────────────────────────────
// message: Sadece gelen mesajlar (dışarıdan)
// Hedef kişiden gelen cevapları yakalar
// ─────────────────────────────────────────────
client.on('message', async (message) => {
    // Pipeline context oluştur
    const context = {
        message,
        chatId: message.from,
        body: message.body || '',
        fromMe: false,
        contactNumber: null,
        senderName: null,
        media: null,
        hasMedia: false,
        handled: false,
    };

    await incomingPipeline.process(context);
});

// ============================================
// Başlat
// ============================================
console.log('');
console.log('🚀 WhatsApp Otonom Ajan Sistemi başlatılıyor...');
console.log('');
client.initialize();
