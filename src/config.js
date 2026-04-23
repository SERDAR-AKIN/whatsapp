// ============================================
// WhatsApp Otonom Ajan Sistemi — Yapılandırma
// ============================================

const CONFIG = {
    // Bot Sahibi Bilgileri
    owner: {
        name: 'Serdar Akın',
        shortName: 'Serdar',  // Sohbetlerde kullanılacak kısa isim
    },

    // Gemini CLI Ayarları
    gemini: {
        model: 'gemini-2.5-flash', // Veya istediğiniz model adı
    },

    // Görev Varsayılan Ayarları
    mission: {
        defaultTimeout: 24 * 60 * 60 * 1000,    // 24 saat (ms)
        defaultMaxMessages: 20,                // Maksimum mesaj sayısı
        defaultRetryInterval: null,            // Periyodik tekrar (null = yok)
        defaultMaxRetries: 10,                 // Maksimum tekrar sayısı
        maxFollowUpDelay: 24 * 60 * 60 * 1000, // Maksimum takip bekleme: 24 saat
    },

    // Kontrol Etiketleri
    tags: {
        completed: '[GÖREV_TAMAMLANDI]',
        failed: '[GÖREV_BAŞARISIZ]',
    },

    // Komut Prefiksleri
    commands: {
        ai: '!ai',
        stop: '!stop',
        status: '!durum',
        list: '!liste',
    },

    // Loglama
    logging: {
        saveToFile: true,
        logDir: './logs',
    },

    // Dil
    language: 'tr',
};

module.exports = CONFIG;
