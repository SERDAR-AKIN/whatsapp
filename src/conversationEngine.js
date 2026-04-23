// ============================================
// WhatsApp Otonom Ajan Sistemi — Sohbet Motoru
// ============================================

const GeminiClient = require('./geminiClient');
const CONFIG = require('./config');

const aiClient = new GeminiClient();

class ConversationEngine {
    /**
     * Görev için system prompt oluşturur.
     * @param {Object} mission - Görev objesi
     * @returns {string}
     */
    buildSystemPrompt(mission) {
        const completionNote = mission.options.completionCondition
            ? `\n- Tamamlanma Koşulu: ${mission.options.completionCondition}`
            : '';

        const basePrompt = `Sen ${CONFIG.owner.name}'ın dijital WhatsApp asistanısın.
Görevlendirildiğin kişiyle onun adına iletişim kuruyorsun. Gerçek bir asistan gibi profesyonel, ancak WhatsApp'a uygun bir doğallıkta konuş.

## Görevin:
${mission.taskDescription}

## İletişim Kuralları:
1. İlk mesajında kendini asistan olarak tanıt ve seni ${CONFIG.owner.shortName}'ın görevlendirdiğini MUTLAKA belirt.
2. ${mission.options.tone} bir üslup kullan. Uzun paragraflar yerine WhatsApp tarzı kısa, öz ve net mesajlar yaz. Emojileri dozunda kullan.
3. Temsil ettiğin kişiden bahsederken her zaman "${CONFIG.owner.shortName}" ismini açıkça kullan ("o" veya "seni seven kişi" gibi belirsiz ifadeler kullanma).
4. Karşı taraf konuyu dağıtırsa, nazikçe asıl görev konunuza geri dön.

## Zaman ve Mantık Farkındalığı:
- Her mesajın başında göreceğin [SAAT: ...] etiketi anlık zamanı belirtir.
- Karşı tarafın verdiği süreleri ve sözleri bu saate göre değerlendir.
- Mantıksız veya çok uzun süreler (örn. "aylar sonra", "seneye") verilirse kabul etme; nazikçe daha yakın bir tarih/çözüm talep et.
- Süresi dolmuş bir eylem varsa (örn. "5 dakika geçti, halledebildin mi?"), bunu doğal bir dille hatırlat.
- ASLA kendi göndereceğin mesajda [SAAT: ...] etiketi kullanma.

## ÇIKTI FORMATI:
Yanıtını sadece aşağıdaki JSON formatında vermelisin. Başka hiçbir açıklama metni veya markdown bloku ekleme:
{
  "reply": "Karşı tarafa göndereceğin mesaj metni",
  "status": "active",
  "memberStatus": { "Kişi1": "Durumu" }
}

Durum (status) Kuralları:
- Görev devam ediyorsa "active".
- Karşı taraf işin KESİN OLARAK YAPILDIĞINI teyit ederse "completed" (Sözler "active" kalır).
- Görev KESİN REDDEDİLDİYSE "failed".
${completionNote}`;

        if (mission.isGroup) {
            let groupInstruction = `
## GRUP SOHBETİ BİLGİLENDİRMESİ (ÇOK ÖNEMLİ):
Şu an birebir bir sohbette değil, BİR GRUP SOHBETİNDESİN.
- Grupta birden fazla kişi olabilir. Sana gelen mesajların başında konuşan kişinin ismi yazacaktır (Örn: "[Ali]: Selam").
- Yanıt verirken ilgili kişiye İSMİYLE HİTAP ET.
- Asla sadece tek bir kişiye odaklanıp grubun diğer üyelerini yok sayma.
`;
            return basePrompt + groupInstruction;
        }

        return basePrompt;
    }

    /**
     * Görev için LLM'den ilk mesajı üretir.
     * @param {Object} mission - Görev objesi
     * @returns {Promise<string>} - Gönderilecek ilk mesaj
     */
    async generateFirstMessage(mission) {
        const systemPrompt = this.buildSystemPrompt(mission);

        const messages = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: 'Şimdi bu kişiyle sohbeti başlat. İlk mesajını yaz. Sadece mesaj metnini yaz, başka bir şey ekleme.',
            },
        ];

        const response = await aiClient.chat(messages, true);
        const { cleanMessage } = this._processResponse(response);

        // Sohbet geçmişine ekle (temiz metin olarak, JSON kirliliği önlenir)
        mission.conversationHistory.push(
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Şimdi bu kişiyle sohbeti başlat. İlk mesajını yaz.' },
            { role: 'assistant', content: cleanMessage }
        );
        mission.messageCount++;

        return cleanMessage;
    }

    /**
     * Hedef kişiden gelen mesaja LLM ile cevap üretir.
     * @param {Object} mission - Görev objesi
     * @param {string} incomingMessage - Hedef kişiden gelen mesaj
     * @returns {Promise<{message: string, status: string, memberStatus: Object}>}
     */
    async generateReply(mission, incomingMessage) {
        // Mevcut saati mesajın başına ekle (zaman farkındalığı)
        const now = new Date();
        const currentTime = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeTaggedMessage = `[SAAT: ${currentTime}] ${incomingMessage}`;

        // Gelen mesajı geçmişe ekle
        mission.conversationHistory.push({
            role: 'user',
            content: timeTaggedMessage,
        });

        const response = await aiClient.chat(mission.conversationHistory, true);
        const { cleanMessage, status, memberStatus } = this._processResponse(response);

        // Cevabı geçmişe ekle (temiz metin olarak, JSON kirliliği önlenir)
        mission.conversationHistory.push({
            role: 'assistant',
            content: cleanMessage,
        });
        mission.messageCount++;

        return { message: cleanMessage, status, memberStatus };
    }

    /**
     * Karşı tarafın mesajını analiz ederek otomatik takip zamanlaması çıkarır.
     * Eğer karşı taraf "5 dakika sonra yaparım" gibi bir süre belirtmişse,
     * o süre sonunda tekrar hatırlatma yapılması için zamanlama bilgisi döner.
     *
     * @param {Object} mission - Görev objesi
     * @returns {Promise<{needsFollowUp: boolean, followUps: Array}>}
     */
    async analyzeForFollowUp(mission) {
        const isGroup = mission.isGroup || false;
        // Sohbet geçmişinden son birkaç mesajı al
        const recentMessages = mission.conversationHistory
            .filter(m => m.role !== 'system' && !m.content.startsWith('[SİSTEM'))
            .slice(-6) // Gruplarda birden fazla kişi olduğu için daha fazla mesaj al
            .map(m => `${m.role === 'assistant' ? 'Ben' : 'Karşı Taraf'}: ${m.content}`)
            .join('\n');

        const now = new Date();
        const currentTime = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

        const analysisPrompt = `Aşağıdaki WhatsApp sohbetini analiz et. Karşı taraf bir eylem gerçekleştireceğine veya iş yapacağına dair söz verdi mi? Verdiyse, ne kadar süre sonra yapacağını tespit et.

ŞU ANKİ ZAMAN: ${currentTime}
GÖREV: Karşı taraf spesifik bir saat veya tarih verdiyse, şu anki zamanla kıyaslayıp aradaki farkı dakika cinsinden hesaplayarak 'delayMinutes' alanına yaz. Eğer belirsiz bir söz varsa (örn: "yaparım", "hallederim") 10-60 dakika arası makul bir bekleme süresi ata.

Sohbet:
${recentMessages}

Çıktı Formatı (SADECE JSON):
{
  "needsFollowUp": true veya false,
  "followUps": [
    {
      "target": "Sözü veren kişinin ismi (Grup değilse 'Kişi' yazabilirsin)",
      "delayMinutes": sayı,
      "isUnreasonable": true veya false,
      "reason": "kısa açıklama"
    }
  ]
}
${isGroup ? '\nÖNEMLİ: Bu bir GRUP sohbetidir. Birden fazla kişinin sözünü ayrı ayrı followUp nesnesi olarak döndür.' : ''}`;

        try {
            const response = await aiClient.chat([
                { role: 'system', content: 'Sen bir analiz asistanısın. Sadece JSON döndür.' },
                { role: 'user', content: analysisPrompt },
            ], true);

            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);

                let followUps = [];
                if (result.needsFollowUp && result.followUps && Array.isArray(result.followUps)) {
                    for (let item of result.followUps) {
                        let delayMs = item.delayMinutes ? item.delayMinutes * 60 * 1000 : 10 * 60 * 1000;
                        const maxDelay = CONFIG.mission.maxFollowUpDelay;
                        if (delayMs > maxDelay) {
                            console.log(`⚠️ Takip süresi sınırlandı (${item.target}): ${item.delayMinutes} dk → ${maxDelay / 60000} dk`);
                            delayMs = maxDelay;
                        }
                        followUps.push({
                            target: item.target || 'Kişi',
                            delayMs: delayMs,
                            isUnreasonable: item.isUnreasonable || false,
                            reason: item.reason || 'Takip gerekli'
                        });
                    }
                }

                return {
                    needsFollowUp: result.needsFollowUp || false,
                    followUps: followUps,
                };
            }
        } catch (error) {
            console.error('⚠️ Takip analizi başarısız:', error.message);
        }

        return { needsFollowUp: false, followUps: [] };
    }

    /**
     * Zamanlayıcı tarafından tetiklenen takip mesajı üretir.
     * @param {Object} mission - Görev objesi
     * @param {string} [followUpReason] - Takibin nedeni
     * @returns {Promise<{message: string, status: string}>}
     */
    async generateFollowUp(mission, followUpReason) {
        const reasonNote = followUpReason
            ? ` Takip nedeni: ${followUpReason}.`
            : '';

        // Mevcut saati hesapla (zaman farkındalığı)
        const now = new Date();
        const currentTime = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });

        // Takip talimatını geçmişe ekle
        mission.conversationHistory.push({
            role: 'user',
            content: `[SİSTEM NOTU — SAAT: ${currentTime}] Karşı tarafın söylediği süre doldu.${reasonNote} Şu anki saati dikkate alarak durumu değerlendir. Eğer karşı taraf daha önce belirli bir saat vermişse (ve o saat geçtiyse), bunu nazikçe hatırlat. Doğal ol, "süreniz doldu" gibi robotik konuşma. Sanki normal bir insan gibi "nasıl oldu, halledebildiniz mi?" tarzında sor. Önceki mesajlarını tekrarlama, farklı bir yaklaşım dene.`,
        });

        const response = await aiClient.chat(mission.conversationHistory, true);
        const { cleanMessage, status, memberStatus } = this._processResponse(response);

        // Cevabı geçmişe ekle (temiz metin olarak)
        mission.conversationHistory.push({
            role: 'assistant',
            content: cleanMessage,
        });
        mission.messageCount++;
        mission.retryCount++;

        return { message: cleanMessage, status, memberStatus };
    }

    /**
     * Görev tamamlandığında kullanıcıya gönderilecek özet raporu LLM ile üretir.
     * @param {Object} mission - Görev objesi
     * @returns {Promise<string>} - Özet rapor
     */
    async generateReport(mission) {
        const statusEmoji = mission.status === 'completed' ? '✅' : '❌';
        const statusText = mission.status === 'completed' ? 'Tamamlandı' : 'Başarısız';

        // Sohbet geçmişinden sadece asistan ve kullanıcı mesajlarını al (sistem hariç)
        const chatSummary = mission.conversationHistory
            .filter(m => m.role !== 'system' && !m.content.startsWith('[SİSTEM'))
            .map(m => `${m.role === 'assistant' ? '🤖 Ajan' : '👤 Kişi'}: ${m.content}`)
            .join('\n');

        try {
            const summaryResponse = await aiClient.chat([
                {
                    role: 'system',
                    content: 'Aşağıdaki WhatsApp sohbetini 1-2 cümleyle özetle. Sadece sonucu ve önemli bilgileri belirt. Türkçe yaz.',
                },
                { role: 'user', content: chatSummary },
            ]);

            const duration = mission.completedAt
                ? this._calculateDuration(mission.createdAt, mission.completedAt)
                : 'Bilinmiyor';

            let memberInfo = '';
            if (mission.isGroup && mission.memberStatus && Object.keys(mission.memberStatus).length > 0) {
                memberInfo = '\n👥 Üye Durumları:';
                for (const [name, status] of Object.entries(mission.memberStatus)) {
                    memberInfo += `\n   • ${name}: ${status}`;
                }
            }

            return `${statusEmoji} Görev ${statusText} (ID: #${mission.id})
📱 ${mission.isGroup ? 'Grup' : 'Kişi'}: ${mission.targetNumber}
📋 Sonuç: ${summaryResponse.trim()}
🔁 Tekrar: ${mission.retryCount} takip mesajı gönderildi
💬 Mesaj: ${mission.messageCount} mesaj
⏱️ Süre: ${duration}${memberInfo}`;
        } catch {
            return `${statusEmoji} Görev ${statusText} (ID: #${mission.id})
📱 Kişi: ${mission.targetNumber}
💬 Toplam ${mission.messageCount} mesaj, ${mission.retryCount} takip`;
        }
    }

    /**
     * LLM cevabındaki kontrol etiketlerini ayıklar.
     * @param {string} response - LLM'in ham cevabı
     * @returns {{cleanMessage: string, status: string}}
     * @private
     */
    _processResponse(response) {
        let status = 'active';
        let cleanMessage = response;
        let memberStatus = {};

        try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.reply !== undefined) {
                    cleanMessage = parsed.reply;
                } else if (parsed.content !== undefined) {
                    cleanMessage = parsed.content;
                } else if (parsed.message !== undefined) {
                    cleanMessage = parsed.message;
                } else {
                    // Eğer beklenen hiçbir anahtar yoksa ham JSON'u gönderme, temizlemeye çalış
                    cleanMessage = response.replace(/[\{\}"]/g, '').trim();
                }
                if (parsed.status) status = parsed.status;
                if (parsed.memberStatus) memberStatus = parsed.memberStatus;
            } else {
                // Fallback: If no JSON is found, treat the whole response as the message
                cleanMessage = response.trim();
            }
        } catch (e) {
            console.error("⚠️ LLM JSON formatında cevap veremedi, ham metin ayrıştırılacak:", e.message);
            cleanMessage = response;
            
            // Eğer string "reply": ile başlıyorsa, içeriğini çıkarmaya çalış
            const replyMatch = response.match(/"reply"\s*:\s*"([\s\S]*?)("(?=\s*,)|"(?=\s*\})|$)/);
            if (replyMatch && replyMatch[1]) {
                cleanMessage = replyMatch[1];
            } else {
                // Temel JSON yapılarını temizle
                cleanMessage = response.replace(/[\{\}]/g, '')
                                       .replace(/"reply"\s*:\s*/g, '')
                                       .replace(/"status"\s*:\s*".*?"/g, '')
                                       .replace(/"memberStatus"\s*:\s*.*/g, '')
                                       .trim();
                
                // Başta ve sonda kalan serseri tırnakları temizle
                if (cleanMessage.startsWith('"')) cleanMessage = cleanMessage.substring(1);
                if (cleanMessage.endsWith('"')) cleanMessage = cleanMessage.slice(0, -1);
            }
        }

        // Geriye dönük uyumluluk veya JSON dışı cevaplar için etiket kontrolü
        if (cleanMessage.includes(CONFIG.tags.completed)) {
            status = 'completed';
            cleanMessage = cleanMessage.replace(CONFIG.tags.completed, '').trim();
        } else if (cleanMessage.includes(CONFIG.tags.failed)) {
            status = 'failed';
            cleanMessage = cleanMessage.replace(CONFIG.tags.failed, '').trim();
        }

        // LLM yine de [SAAT: ...] etiketini cevaba eklediyse temizle
        cleanMessage = cleanMessage.replace(/\[SAAT:\s*\d{2}:\d{2}\]/g, '').trim();

        // Yaygın LLM hatalarını temizle (başta kalan "reply:", "asistan:" vb. etiketleri sil)
        cleanMessage = cleanMessage.replace(/^(reply|asistan|cevap|message|content|bot|assistant)\s*:\s*/i, '').trim();

        return { cleanMessage, status, memberStatus };
    }

    /**
     * İki tarih arasındaki süreyi okunabilir formatta döndürür.
     * @private
     */
    _calculateDuration(startISO, endISO) {
        const diffMs = new Date(endISO) - new Date(startISO);
        const minutes = Math.floor(diffMs / 60000);
        const seconds = Math.floor((diffMs % 60000) / 1000);

        if (minutes < 1) return `${seconds} saniye`;
        if (minutes < 60) return `${minutes} dakika`;
        const hours = Math.floor(minutes / 60);
        const remainMins = minutes % 60;
        return `${hours} saat ${remainMins} dakika`;
    }
}

module.exports = ConversationEngine;
