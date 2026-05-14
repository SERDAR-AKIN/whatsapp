// ============================================
// WhatsApp Otonom Ajan Sistemi — LID Çözümleyici
// ============================================
// 
// WhatsApp Business/Bağlı Cihaz (Linked Device) mesajları
// @lid formatında gelir ve gerçek telefon numarasını içermez.
// Bu modül, LID → Telefon eşleşmesini merkezi, cache'li
// ve restart-dayanıklı biçimde yönetir.
//
// Mimari:
// ┌─────────────────────────────────────────────┐
// │              LidResolver                     │
// │  ┌─────────┐   ┌──────────┐   ┌──────────┐ │
// │  │RAM Cache│──▶│Puppeteer │──▶│Disk Cache│ │
// │  │  (Map)  │   │ Resolve  │   │  (JSON)  │ │
// │  └─────────┘   └──────────┘   └──────────┘ │
// └─────────────────────────────────────────────┘

const fs = require('fs');
const path = require('path');

class LidResolver {
    /**
     * @param {Object} whatsappClient - whatsapp-web.js Client instance
     */
    constructor(whatsappClient) {
        this.client = whatsappClient;

        /** @type {Map<string, string>} lid → phoneNumber */
        this.cache = new Map();

        // İstatistik sayaçları
        this.stats = { hits: 0, misses: 0, puppeteerCalls: 0, errors: 0 };

        // Kalıcı cache dosyası
        this.dataDir = path.resolve('./data');
        this.cacheFile = path.join(this.dataDir, 'lid_mappings.json');

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * @description Verilen chatId bir @lid ise gerçek telefon numarasını çözer.
     * Önce RAM cache'e, sonra Puppeteer'a başvurur. Başarılı çözümler
     * hem RAM'e hem diske yazılır.
     * 
     * @param {string} chatId - Gelen mesajın chatId'si (örn: "197646123819107@lid")
     * @returns {Promise<string|null>} - Telefon numarası (örn: "905xxxxxxxxxx") veya null
     */
    async resolve(chatId) {
        // @lid değilse çözümleme gereksiz
        if (!chatId || !chatId.endsWith('@lid')) {
            return null;
        }

        // ─────────────────────────────────────────────
        // 1. RAM Cache kontrolü (O(1))
        // ─────────────────────────────────────────────
        if (this.cache.has(chatId)) {
            this.stats.hits++;
            const cached = this.cache.get(chatId);
            console.log(`🧠 [LID Cache HIT]: ${chatId} → ${cached}`);
            return cached;
        }

        // ─────────────────────────────────────────────
        // 2. Puppeteer ile WhatsApp dahili API çözümlemesi
        // ─────────────────────────────────────────────
        this.stats.misses++;
        const phoneNumber = await this._puppeteerResolve(chatId);

        if (phoneNumber) {
            // Cache'e yaz (RAM + Disk)
            this.cache.set(chatId, phoneNumber);
            this._saveToDisk();
            console.log(`🧠 [LID Çözüldü]: ${chatId} → ${phoneNumber} (cache'e yazıldı)`);
            return phoneNumber;
        }

        console.log(`⚠️ [LID Çözülemedi]: ${chatId} — Puppeteer ile eşleşme bulunamadı.`);
        return null;
    }

    /**
     * @description Verilen chatId'yi normalize eder. @lid ise @c.us formatına dönüştürür.
     * @c.us veya @g.us ise olduğu gibi bırakır.
     * 
     * @param {string} chatId - Ham chatId
     * @returns {Promise<string>} - Normalize edilmiş chatId (çözülemediyse orijinal döner)
     */
    async normalize(chatId) {
        if (!chatId) return chatId;
        if (chatId.endsWith('@c.us') || chatId.endsWith('@g.us')) {
            return chatId;
        }

        const phone = await this.resolve(chatId);
        return phone ? `${phone}@c.us` : chatId;
    }

    /**
     * @description WhatsApp Web'in dahili (internal) API'lerini Puppeteer üzerinden
     * sorgulayarak LID'i gerçek telefon numarasına çevirir.
     * 
     * İki aşamalı çözümleme:
     * 1. WAWebApiContact.getPhoneNumber — Yerel Wid cache'den arama
     * 2. WAWebQueryExistsJob.queryWidExists — Sunucu sorgulama (cache miss'te)
     * 
     * @private
     * @param {string} lidChatId - @lid formatındaki chatId
     * @returns {Promise<string|null>} - Telefon numarası veya null
     */
    async _puppeteerResolve(lidChatId) {
        this.stats.puppeteerCalls++;

        // Puppeteer sayfası hazır değilse çözümleme yapılamaz
        if (!this.client || !this.client.pupPage) {
            console.warn('⚠️ [LID Çözücü]: Puppeteer sayfası henüz hazır değil.');
            return null;
        }

        try {
            const phoneStr = await this.client.pupPage.evaluate(async (lidStr) => {
                try {
                    const wid = window.require('WAWebWidFactory').createWid(lidStr);

                    // Aşama 1: Yerel Wid cache'den oku
                    let phoneWid = window.require('WAWebApiContact').getPhoneNumber(wid);

                    // Aşama 2: Yerel cache'de yoksa sunucudan sorgula
                    if (!phoneWid) {
                        const queryResult = await window.require('WAWebQueryExistsJob').queryWidExists(wid);
                        if (queryResult && queryResult.wid) {
                            phoneWid = window.require('WAWebApiContact').getPhoneNumber(queryResult.wid);
                        }
                    }

                    return phoneWid ? phoneWid._serialized : null;
                } catch (err) {
                    return null;
                }
            }, lidChatId);

            if (phoneStr) {
                // "905xxxxxxxxxx@c.us" → "905xxxxxxxxxx"
                return phoneStr.split('@')[0];
            }

            return null;
        } catch (error) {
            this.stats.errors++;
            console.error(`⚠️ [LID Çözücü Hatası]: ${error.message}`);
            return null;
        }
    }

    /**
     * @description Uygulama başlatıldığında disk cache'ini RAM'e yükler.
     * Bu sayede restart sonrası daha önce çözülmüş LID'ler
     * tekrar Puppeteer'a sormadan kullanılır.
     */
    loadFromDisk() {
        if (!fs.existsSync(this.cacheFile)) {
            console.log('🧠 [LID Cache]: Disk cache bulunamadı, boş cache ile başlanıyor.');
            return;
        }

        try {
            const data = fs.readFileSync(this.cacheFile, 'utf-8');
            const mappings = JSON.parse(data);

            let count = 0;
            for (const [lid, phone] of Object.entries(mappings)) {
                this.cache.set(lid, phone);
                count++;
            }

            console.log(`🧠 [LID Cache]: Diskten ${count} eşleşme yüklendi.`);
        } catch (error) {
            console.error('⚠️ [LID Cache]: Disk cache okunamadı:', error.message);
        }
    }

    /**
     * @description RAM cache'ini diske yazar (atomik write).
     * Her yeni çözümlemede çağrılır.
     * @private
     */
    _saveToDisk() {
        try {
            const mappings = {};
            for (const [lid, phone] of this.cache.entries()) {
                mappings[lid] = phone;
            }

            const tempFile = this.cacheFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(mappings, null, 2), 'utf-8');
            fs.renameSync(tempFile, this.cacheFile); // Atomik yazma
        } catch (error) {
            console.error('⚠️ [LID Cache]: Diske yazılamadı:', error.message);
        }
    }

    /**
     * @description Cache istatistiklerini döndürür (debug ve monitoring amaçlı).
     * @returns {{ cacheSize: number, hits: number, misses: number, puppeteerCalls: number, errors: number }}
     */
    getStats() {
        return {
            cacheSize: this.cache.size,
            ...this.stats,
        };
    }
}

module.exports = LidResolver;
