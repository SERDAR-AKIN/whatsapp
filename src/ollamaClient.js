// ============================================
// WhatsApp Otonom Ajan Sistemi — Ollama İstemcisi
// ============================================

const CONFIG = require('./config');

class OllamaClient {
    constructor() {
        this.baseUrl = CONFIG.ollama.baseUrl;
        this.model = CONFIG.ollama.model;
    }

    /**
     * Ollama /api/chat endpointine mesaj gönderir.
     * @param {Array} messages - [{ role: 'system'|'user'|'assistant', content: '...' }]
     * @param {boolean} useJson - Çıktının zorunlu JSON formatında dönmesi (true/false)
     * @returns {Promise<string>} - LLM'in cevabı
     */
    async chat(messages, useJson = false) {
        const url = `${this.baseUrl}${CONFIG.ollama.chatEndpoint}`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    messages: messages,
                    stream: false,
                    format: useJson ? 'json' : undefined,
                }),
            });

            if (!response.ok) {
                throw new Error(`Ollama HTTP hatası: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            return data.message?.content || '';
        } catch (error) {
            console.error('❌ Ollama bağlantı hatası:', error.message);
            throw error;
        }
    }

    /**
     * Ollama sunucusunun erişilebilir olup olmadığını kontrol eder.
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);
            return response.ok;
        } catch {
            return false;
        }
    }
}

module.exports = OllamaClient;
