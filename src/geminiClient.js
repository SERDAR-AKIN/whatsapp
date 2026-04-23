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
     * @description Sistem seviyesinde kurulu olan Gemini CLI aracıyla Node.js `child_process.spawn` üzerinden
     * asenkron ve headless (arka plan) iletişim kurar. Bu sayede lokal bir LLM veya API anahtarına 
     * ihtiyaç duymadan Google Gemini'ın gücü kullanılabilir.
     * 
     * @param {Array<{role: string, content: string}>} messages - Gönderilecek mesaj geçmişi ve sistem promptu dizisi.
     * @param {boolean} useJson - Sistemin dönüşünün zorunlu JSON formatında olmasını sağlar (Prompt'a gizli emir ekler).
     * @returns {Promise<string>} - Gemini CLI'dan dönen standart çıktı (stdout).
     * @throws {Error} CLI komutu başarısız olursa veya bulunamazsa hata fırlatır.
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
