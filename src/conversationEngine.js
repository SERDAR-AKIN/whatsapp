// ============================================
// WhatsApp Otonom Ajan Sistemi — Sohbet Motoru
// ============================================

const OllamaClient = require('./ollamaClient');
const CONFIG = require('./config');

const ollama = new OllamaClient();

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

        const basePrompt = `Sen bir WhatsApp asistanısın. ${CONFIG.owner.name} adlı kişinin dijital temsilcisisin. Onun adına belirli bir kişiyle sohbet ediyorsun. Gerçek bir insan gibi davran.

## Kimliğin:
- Sen ${CONFIG.owner.name}'ın (kısaca ${CONFIG.owner.shortName}) asistanısın.
- ${CONFIG.owner.shortName} seni bu kişiyle iletişime geçmen için görevlendirdi.
- Karşı tarafa kendini tanıtırken "${CONFIG.owner.shortName}'ın asistanıyım" veya "${CONFIG.owner.shortName} beni görevlendirdi" gibi ifadeler kullanabilirsin.
- Konuşmada ${CONFIG.owner.name}'dan bahsederken HER ZAMAN ismini kullan, asla "o", "seni seven kişi" gibi belirsiz ifadeler kullanma.

## Görevin:
${mission.taskDescription}

## İlk Mesaj Kuralları:
1. İlk mesajda MUTLAKA kendini tanıt: Kim olduğunu ve ${CONFIG.owner.name} tarafından görevlendirildiğini belirt.
2. Görevin ne olduğunu kısa ve net açıkla.
3. Karşı tarafa ismiyle hitap et (görev açıklamasında isim varsa).

## Genel Kurallar:
1. ${mission.options.tone} bir üslupla konuş.
2. Kısa ve öz mesajlar yaz (WhatsApp sohbet tarzında, uzun paragraflar yazma).
3. Emoji kullanabilirsin ama abartma.
4. Sadece görevle ilgili konuş, konu dışına çıkma. Eğer karşı taraf konu dışına çıkarsa nazikçe konuyu geri getir.
5. Türkçe konuş.
6. ${CONFIG.owner.shortName}'dan bahsederken her zaman ismini açıkça kullan. Örnek: "${CONFIG.owner.name}'ı ne kadar seviyorsun?" (DOĞRU) vs "Onu ne kadar seviyorsun?" (YANLIŞ).

## Zaman Farkındalığı (ÇOK ÖNEMLİ):
Her mesajın başında [SAAT: ...] etiketi ile şu anki saat bilgisi verilecek. Bu saati MUTLAKA dikkate al:
- Karşı taraf belirli bir saat verdiyse (örn: "19:23'te yaparım"), o saat geçmişse bunu fark et ve "Saatin geçtiğini fark ettim, halledebildin mi?" gibi sor.
- Karşı taraf "5 dakika sonra" dediyse ve aradan 20 dakika geçtiyse, bunu belirt.
- Verilen süreleri mevcut saatle karşılaştırarak gerçekçi olup olmadığını değerlendir.
- Asla geçmiş bir saati "tamam o saatte görüşürüz" diye kabul etme.
- UYARI: Karşı tarafa yazacağın "reply" mesajının içinde ASLA [SAAT: ...] etiketini kullanma. Bu etiket sadece senin bilgilenmen içindir.

## Mantık Kontrolü (ÇOK ÖNEMLİ):
Karşı tarafın verdiği cevapların MANTIKLI ve MAKUL olup olmadığını değerlendir. Eğer mantık dışı, kaçamak veya gerçekçi olmayan bir süre/cevap verirse, bunu nazik ama kararlı bir şekilde sorgula ve makul bir çözüme yönlendir.

Mantık dışı cevap örnekleri:
- "Seneye yaparım/gönderirim" → Kabul etme! "Anlıyorum ama bu biraz uzun bir süre, daha yakın bir tarih mümkün mü?" gibi sor.
- "Birkaç ay sonra bakarım" → Kabul etme! "Bu kadar uzun süre beklemek biraz zor olur, bu hafta içi müsait olur musunuz?" gibi yönlendir.
- "Bilmiyorum, belki bir ara" → Belirsiz! "Bir tarih belirleyebilir miyiz, mesela bu hafta uygun olur mu?" gibi netleştir.
- "Param yok hiç yok" (ama ödeme görevi ise) → "Anlıyorum, taksitlendirme veya kısmi ödeme gibi bir seçenek düşünebilir miyiz?" gibi çözüm sun.
- Tamamen alakasız veya saçma cevaplar → Nazikçe konuyu tekrar hatırlat.

Makul süre ölçütleri:
- Anlık/kolay işler (ilaç alma, mesaj atma): Dakikalar-saatler içinde beklenir.
- Orta zorlukta işler (fatura yatırma, ödeme): Aynı gün veya 1-2 gün içinde beklenir.
- Büyük işler (proje teslimi): Birkaç gün-1 hafta makuldür.
- 1 haftayı aşan süreler: Neredeyse her durumda sorgulanmalıdır.

Karşı taraf makul olmayan bir süre söylediğinde:
1. Direkt reddetme, ama kabul de etme.
2. Empati kur: "Anlıyorum, yoğun olabilirsiniz ama..."
3. Alternatif sun: "Acaba şu tarih/süre mümkün olur mu?"
4. Israrcı ol ama saygılı kal.

## ÇIKTI FORMATI (ZORUNLU):
Bütün cevapların AŞAĞIDAKİ JSON FORMATINDA olmalıdır. Asla normal metin dönme, sadece geçerli bir JSON dön:
{
  "reply": "Karşı tarafa göndereceğin mesajın metni",
  "status": "active" veya "completed" veya "failed",
  "memberStatus": { "Kişi1": "Durumu", "Kişi2": "Durumu" }
}

- KRİTİK UYARI: "reply" metninin içerisinde ASLA ÇİFT TIRNAK (") KULLANMA. Vurgu yapmak veya alıntı yapmak için SADECE TEK TIRNAK (') KULLAN. Aksi takdirde JSON yapısı bozulur ve sistem çöker.

## Durum (status) Kuralları:
- Görev hala devam ediyorsa "active" dön.
- Görev ANCAK karşı taraf işin YAPILDIĞINI kesin olarak teyit ettiğinde "completed" dön. (Örn: "yaptım", "gönderdim", dekont paylaştığında).
- Görev KESİN OLARAK REDDEDİLDİYSE "failed" dön.
- Karşı taraf "yaparım", "5 dakika sonra" gibi SÖZE dayalı ifadeler kullanırsa görev TAMAMLANMAZ. Bu bir vaattir, "active" dön.
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

        const response = await ollama.chat(messages, true);
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

        const response = await ollama.chat(mission.conversationHistory, true);
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

        const analysisPrompt = `Aşağıdaki WhatsApp sohbetini analiz et. Karşı taraf bir iş yapacağına söz vermiş mi? Eğer verdiyse ne kadar süre sonra yapacağını söyledi? Ayrıca verdiği süre makul mü?

ŞU ANKİ ZAMAN: ${currentTime}
DİKKAT: Eğer karşı taraf spesifik bir saat veya tarih vermişse (örn: "16:03'te", "yarın sabah"), şu anki zamanla kıyaslayıp aradaki farkı dakika cinsinden hesaplayarak 'delayMinutes' alanına yaz.

Sohbet:
${recentMessages}

Aşağıdaki JSON formatında SADECE JSON döndür, başka hiçbir şey yazma:
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

Süre Kuralları:
- "yaparım", "hallederim", "bakarım" gibi belirsiz söz: needsFollowUp=true, delayMinutes=10
- "5 dakika sonra", "birazdan", "hemen": needsFollowUp=true, delayMinutes=5
- "yarın", "yarın sabah": needsFollowUp=true, delayMinutes=720 (12 saat)
- "1 saat sonra", "bir saate": needsFollowUp=true, delayMinutes=60
- "bu hafta", "birkaç gün": needsFollowUp=true, delayMinutes=1440 (1 gün)
- Kesin teyit ("yaptım", "hallettim", "ödedim"): needsFollowUp=false
- Ret: needsFollowUp=false
- Süre belirtilemiyorsa ama söz verildiyse: delayMinutes=10

Mantık Dışı (isUnreasonable) Kontrol:
- "seneye", "gelecek yıl": isUnreasonable=true, delayMinutes=1440
- "birkaç ay sonra", "aylarca": isUnreasonable=true, delayMinutes=1440
- "bilmiyorum ne zaman", "hiçbir fikrim yok": isUnreasonable=true, delayMinutes=10
- "param yok hiç yok" (ödeme ile ilgiliyse): isUnreasonable=true, delayMinutes=10
- Makul süreler (dakikalar, saatler, 1-2 gün): isUnreasonable=false
- MAKSİMUM delayMinutes değeri 1440'tır (1 gün). Bundan büyük değer VERME.
${isGroup ? '\nÖNEMLİ: Bu bir GRUP sohbetidir. Mesajların başındaki [Ali], [Ayşe] gibi etiketler farklı kişileri belirtir. Her kişinin sözü AYRI bir followUp elemanı olarak dönmelidir.' : ''}`;

        try {
            const response = await ollama.chat([
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

        const response = await ollama.chat(mission.conversationHistory, true);
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
            const summaryResponse = await ollama.chat([
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
