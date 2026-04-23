// ============================================
// WhatsApp Otonom Ajan Sistemi — Gemini İstemcisi
// ============================================

const { spawn } = require('child_process');
const CONFIG = require('./config');

class GeminiClient {
    constructor() {
        this.model = CONFIG.gemini ? CONFIG.gemini.model : undefined;
    }

    /**
     * Gemini CLI üzerinden headless olarak mesaj gönderir.
     * @param {Array} messages - [{ role: 'system'|'user'|'assistant', content: '...' }]
     * @param {boolean} useJson - Çıktının zorunlu JSON formatında dönmesi (true/false)
     * @returns {Promise<string>} - LLM'in cevabı
     */
    async chat(messages, useJson = false) {
        // Mesaj geçmişini tek bir prompt olarak birleştir
        let promptText = messages.map(m => {
            const role = m.role === 'assistant' ? 'Asistan' : m.role === 'system' ? 'Sistem' : 'Kullanıcı';
            return `[${role}]:\n${m.content}`;
        }).join('\n\n');

        if (useJson) {
            promptText += '\n\nÖNEMLİ: Lütfen cevabını SADECE geçerli bir JSON objesi olarak ver. Başında veya sonunda markdown kod bloğu (```json) kullanma, sadece ham JSON metni döndür.';
        }

        const args = ['-p', promptText];
        if (this.model) {
            args.push('-m', this.model);
        }

        return new Promise((resolve, reject) => {
            const child = spawn('gemini', args);

            let stdoutData = '';
            let stderrData = '';

            child.stdout.on('data', (data) => {
                stdoutData += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderrData += data.toString();
            });

            child.on('close', (code) => {
                // Eğer kod 0 değilse ve stdout boşsa hata fırlat
                if (code !== 0 && !stdoutData.trim()) {
                    reject(new Error(`Gemini CLI hatası (Kodu: ${code}): ${stderrData}`));
                    return;
                }

                let result = stdoutData.trim();

                // JSON isteniyorsa markdown kod bloklarını temizle
                if (useJson) {
                    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
                    if (jsonMatch) {
                        result = jsonMatch[1].trim();
                    }
                }

                resolve(result);
            });

            child.on('error', (err) => {
                console.error('❌ Gemini CLI başlatılamadı:', err.message);
                reject(err);
            });
        });
    }

    /**
     * Gemini CLI'ın erişilebilir olup olmadığını kontrol eder.
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        return new Promise((resolve) => {
            const child = spawn('gemini', ['-v']);
            child.on('close', (code) => {
                resolve(code === 0);
            });
            child.on('error', () => {
                resolve(false);
            });
        });
    }
}

module.exports = GeminiClient;
