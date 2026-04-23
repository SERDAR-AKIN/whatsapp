/**
 * @file ollamaClient.js
 * @description Local Ollama API servisiyle haberleşen eski istemci sınıfı.
 * (Not: Mevcut mimaride Gemini CLI tercih edilmektedir, bu dosya geriye dönük uyumluluk veya 
 * tamamen yerel LLM senaryoları için tutulmaktadır).
 */
const CONFIG = require('./config');

class OllamaClient {
    constructor() {
        this.baseUrl = CONFIG.ollama.baseUrl;
        this.model = CONFIG.ollama.model;
    }

    /**
     * @description Localhost'ta çalışan Ollama sunucusunun `/api/chat` endpoint'ine HTTP POST isteği gönderir.
     * 
     * @param {Array<{role: string, content: string}>} messages - Gönderilecek sohbet geçmişi.
     * @param {boolean} useJson - Modelin sadece JSON dönmesini zorlar (Ollama'nın native `format: "json"` desteğini kullanır).
     * @returns {Promise<string>} - LLM'in ürettiği metin.
     * @throws {Error} - Sunucu yanıt vermezse veya 200 harici bir kod dönerse hata fırlatır.
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
     * @description Ollama sunucusunun erişilebilir olup olmadığını test eder. (Main gateway başlatılırken kullanılır).
     * @returns {Promise<boolean>} Başarılıysa true, ulaşılamıyorsa false.
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
