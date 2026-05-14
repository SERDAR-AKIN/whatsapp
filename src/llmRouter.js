// ============================================
// WhatsApp Otonom Ajan Sistemi — LLM Yönlendirici
// ============================================
//
// Birden fazla LLM backend'ini yönetir ve görev
// karmaşıklığına göre otomatik yönlendirme yapar.
//
// ┌──────────────┐
// │  LLMRouter   │
// │  ┌────────┐  │       ┌──────────────┐
// │  │ route()│──┼──────▶│ GeminiClient │
// │  └────────┘  │       │ (flash/pro)  │
// │  ┌────────┐  │       └──────────────┘
// │  │fallback│──┼──────▶│ OllamaClient │ (opsiyonel)
// │  └────────┘  │       └──────────────┘
// └──────────────┘

const GeminiClient = require('./geminiClient');
const CONFIG = require('./config');

class LLMRouter {
    constructor() {
        /** @type {Map<string, GeminiClient>} */
        this.backends = new Map();

        // Varsayılan backend (config'den)
        this.backends.set('default', new GeminiClient());

        // İstatistikler
        this.stats = { totalCalls: 0, byBackend: {} };
    }

    /**
     * @description Yeni bir LLM backend'i kaydeder.
     * @param {string} name - Backend adı (örn: 'fast', 'pro', 'local')
     * @param {Object} client - chat() ve healthCheck() metotlarına sahip istemci
     */
    register(name, client) {
        this.backends.set(name, client);
        console.log(`🧠 [LLM Router]: "${name}" backend'i kaydedildi.`);
    }

    /**
     * @description Mesaj listesini uygun LLM backend'ine yönlendirir.
     * Karmaşıklık seviyesine göre farklı modeller seçilebilir.
     * 
     * @param {Array<{role: string, content: string}>} messages - Mesaj geçmişi
     * @param {boolean} [useJson=false] - JSON formatında yanıt zorunluluğu
     * @param {Object} [options={}] - Yönlendirme opsiyonları
     * @param {string} [options.backend] - Zorunlu backend adı (override)
     * @param {string} [options.complexity] - 'simple' | 'moderate' | 'complex'
     * @returns {Promise<string>} - LLM yanıtı
     */
    async chat(messages, useJson = false, options = {}) {
        const backendName = options.backend || this._selectBackend(messages, options);
        const client = this.backends.get(backendName) || this.backends.get('default');

        // İstatistik güncelle
        this.stats.totalCalls++;
        this.stats.byBackend[backendName] = (this.stats.byBackend[backendName] || 0) + 1;

        try {
            return await client.chat(messages, useJson);
        } catch (error) {
            // Seçilen backend başarısız olursa varsayılana düş
            if (backendName !== 'default') {
                console.warn(`⚠️ [LLM Router]: "${backendName}" başarısız, "default" deneniyor...`);
                return await this.backends.get('default').chat(messages, useJson);
            }
            throw error;
        }
    }

    /**
     * @description Mesaj karmaşıklığına göre backend seçer.
     * @private
     * @param {Array} messages - Mesaj listesi
     * @param {Object} options - Opsiyonlar
     * @returns {string} - Backend adı
     */
    _selectBackend(messages, options = {}) {
        // Kullanıcı karmaşıklık seviyesi belirttiyse
        if (options.complexity === 'complex' && this.backends.has('pro')) {
            return 'pro';
        }
        if (options.complexity === 'simple' && this.backends.has('fast')) {
            return 'fast';
        }

        // Otomatik belirleme: Mesaj sayısına göre
        const totalTokenEstimate = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);

        if (totalTokenEstimate > 8000 && this.backends.has('pro')) {
            return 'pro'; // Uzun bağlam → güçlü model
        }

        return 'default';
    }

    /**
     * @description Tüm backend'lerin sağlık kontrolünü yapar.
     * @returns {Promise<Object<string, boolean>>}
     */
    async healthCheck() {
        const results = {};
        for (const [name, client] of this.backends.entries()) {
            try {
                results[name] = await client.healthCheck();
            } catch {
                results[name] = false;
            }
        }
        return results;
    }

    /**
     * @description Yönlendirme istatistiklerini döndürür.
     * @returns {Object}
     */
    getStats() {
        return { ...this.stats, backendCount: this.backends.size };
    }
}

module.exports = LLMRouter;
