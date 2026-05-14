// ============================================
// WhatsApp Otonom Ajan Sistemi — Sohbet Motoru
// ============================================

const LLMRouter = require('./llmRouter');
const CONFIG = require('./config');

const aiClient = new LLMRouter();

class ConversationEngine {
    /**
     * @description Otonom görev için LLM'in kimliğini ve sınırlarını belirleyen 5 katmanlı "System Prompt" oluşturur.
     * Bu fonksiyon, LLM'in halüsinasyon görmesini engellemek ve JSON çıktısını garanti altına almak için kritik bir rol oynar.
     * 
     * Mimarisi şu katmanlardan oluşur:
     * 1. Kimlik: Asistanın rolü ve kimi temsil ettiği.
     * 2. Görev Bağlamı: Kullanıcının verdiği `taskDescription`.
     * 3. Davranış: Üslup (`tone`) ve iletişim kuralları.
     * 4. Zaman Farkındalığı: Gelen mesajlardaki `[SAAT: ...]` etiketlerini nasıl yorumlaması gerektiği.
     * 5. Çıktı Kontratı: Sistemin beklediği kati JSON formatı (`reply`, `status`, `memberStatus`).
     * 
     * @example
     * const engine = new ConversationEngine();
     * const prompt = engine.buildSystemPrompt(missionObj);
     * // Dönüş: "# KİMLİĞİN\nSen... \n\n# GÖREVİN\n..."
     * 
     * @param {Object} mission - Üzerinde çalışılan aktif görev nesnesi.
     * @param {Object} mission.options - Görev opsiyonları (tone, completionCondition).
     * @param {boolean} mission.isGroup - Sohbetin bir grup olup olmadığını belirtir.
     * @returns {string} - Derlenmiş ve Markdown formatında hazırlanmış System Prompt.
     */
    buildSystemPrompt(mission) {
        const completionNote = mission.options.completionCondition
            ? `\n- Özel Tamamlanma Koşulu: ${mission.options.completionCondition}`
            : '';

        // ═══════════════════════════════════════════════════
        // KATMAN 1: KİMLİK
        // ═══════════════════════════════════════════════════
        const identityLayer = `# KİMLİĞİN
Sen, ${CONFIG.owner.name}'ın (${CONFIG.owner.shortName}) kişisel WhatsApp asistanısın.
- Görevlendiren: ${CONFIG.owner.shortName}
- Rol: ${CONFIG.owner.shortName} adına karşı tarafla iletişim kurmak
- Platform: WhatsApp (kısa, öz mesajlar yaz; paragraf değil, sohbet tarzında)`;

        // ═══════════════════════════════════════════════════
        // KATMAN 2: GÖREV BAĞLAMI
        // ═══════════════════════════════════════════════════
        const missionLayer = `# GÖREVİN
${mission.taskDescription}`;

        // ═══════════════════════════════════════════════════
        // KATMAN 3: DAVRANIŞ KURALLARI
        // ═══════════════════════════════════════════════════
        const behaviorLayer = `# DAVRANIŞ KURALLARI
- Üslup: ${mission.options.tone}
- İlk mesajında mutlaka kendini tanıt: "${CONFIG.owner.shortName}'ın asistanıyım, beni şu konuda görevlendirdi: ..." şeklinde.
- ${CONFIG.owner.shortName}'dan bahsederken DAİMA ismini kullan. "O", "kendisi", "seni seven kişi" gibi belirsiz ifadeler YASAK.
- Emojileri doğal ve ölçülü kullan (her mesajda değil, uygun yerlerde).
- Tekrara düşme. Aynı mesajı farklı kelimelerle tekrar gönderme; her mesajda yeni bir açı veya yaklaşım dene.

## GÖREV İLGİSİ ALGILAMA
- Karşı tarafın mesajı görevle ALAKASIZ olabilir (selamlaşma, şaka, kişisel sohbet, "çay hazır" gibi günlük mesajlar).
- Bu durumda:
  → Kısa ve doğal bir karşılık ver (maksimum 1 cümle). Konuyu ZORLA görev konusuna ÇEKMEYİN.
  → Eğer üst üste 2+ alakasız mesaj geldiyse, nazikçe "Bu arada [görev konusu] hakkında bir gelişme var mı?" gibi doğal bir geçiş yap.
  → Tek bir alakasız mesaj geldiyse sadece doğal karşılık ver, görev konusunu hiç açma.
- YANLIŞ: "Afiyet olsun! 😊 Peki poliçe ne durumda?"
- DOĞRU: "Afiyet olsun! 😊" (sonraki mesajı bekle)
- Görevle ilgili olmayan mesajlarda relevance alanını "off_topic" olarak işaretle.`;

        // ═══════════════════════════════════════════════════
        // KATMAN 4: ZAMAN VE MANTIK FARKINDALIĞI
        // ═══════════════════════════════════════════════════
        const awarenessLayer = `# ZAMAN VE MANTIK FARKINDALIĞI
Her kullanıcı mesajının başında [SAAT: GG.AA.YYYY SS:DD:SS] etiketi bulunur. Bu sana gerçek zamanı bildirir.

Zaman Kuralları:
- Karşı taraf belirli bir saat/tarih söylediyse ve o an geçtiyse → "Saati geçmiş görünüyor, halledebildiniz mi?" gibi doğal bir dille sor.
- "5 dakika sonra" gibi göreceli süreler verildiyse, geçen süreyi hesapla ve gerekirse hatırlat.
- Geçmişte kalmış bir saati kabul etme ("17:00'de yaparım" ama saat 19:00 ise bunu fark et).

Mantık Kuralları:
- Makul olmayan süreler (aylar, yıllar) verilirse: empati kur + daha yakın alternatif öner.
- Belirsiz cevaplar ("belki", "bir ara"): somut bir tarih/saat talep et.
- Kaçamak cevaplar: ısrarcı ama saygılı ol, çözüm odaklı alternatifler sun.

⚠️ KENDİ mesajlarında [SAAT: ...] etiketi KULLANMA. Bu etiket sadece senin bilgilenmen içindir.`;

        // ═══════════════════════════════════════════════════
        // KATMAN 5: ÇIKTI KONTRATI
        // ═══════════════════════════════════════════════════
        const outputLayer = `# ÇIKTI KONTRATI (ZORUNLU)
Her yanıtını aşağıdaki JSON yapısında döndür. JSON dışında hiçbir metin, açıklama veya markdown bloğu ekleme.

\`\`\`
{
  "reply": "<string: karşı tarafa gönderilecek mesaj>",
  "status": "<string: active | completed | failed>",
  "relevance": "<string: on_topic | off_topic | partial>",
  "memberStatus": { "<kişi_adı>": "<durum_açıklaması>" }
}
\`\`\`

Status Belirleme Kuralları:
- "active" → Görev devam ediyor. Karşı taraf söz verdi ama henüz yapmadı; veya diyalog sürüyor.
- "completed" → Karşı taraf işi YAPTIĞINI KESİN olarak teyit etti (örn: "yaptım", "gönderdim", dekont paylaştı). Sözler veya niyetler "completed" DEĞİLDİR.
- "failed" → Karşı taraf görevi KESİN olarak reddetti ve alternatiflere de kapalı.

Relevance Belirleme Kuralları:
- "on_topic" → Mesaj doğrudan görevle ilgili (poliçe, dosya, iş konusu vb.).
- "off_topic" → Mesaj görevle tamamen ilgisiz (selamlaşma, şaka, günlük sohbet).
- "partial" → Mesaj kısmen ilgili veya belirsiz ("Hazır" gibi görevle de ilgili olabilecek ifadeler).
${completionNote}`;

        // ═══════════════════════════════════════════════════
        // KATMAN 5+: GRUP EKİ (koşullu)
        // ═══════════════════════════════════════════════════
        let groupLayer = '';
        if (mission.isGroup) {
            groupLayer = `\n# GRUP SOHBETİ KURALLARI
Bu bir grup sohbetidir, birebir değil.
- Mesajlar "[KişiAdı]: mesaj" formatında gelecek. Her kişiyi isminden tanı.
- Yanıt verirken ilgili kişiye ismiyle hitap et.
- Tüm grup üyelerini takip et; sadece bir kişiye odaklanma.
- memberStatus alanında her kişinin durumunu ayrı ayrı raporla.`;
        }

        return [identityLayer, missionLayer, behaviorLayer, awarenessLayer, outputLayer, groupLayer]
            .filter(Boolean)
            .join('\n\n');
    }

    /**
     * @description Görev başlatıldığında LLM'den ilk açılış mesajını otonom olarak üretir.
     * `buildSystemPrompt` çıktısını `mission.systemPrompt` olarak bellekte (ve dolaylı olarak JSON'da) kaydeder.
     * Bu sayede system prompt, mesaj havuzu (conversationHistory) içinde her defasında tekrar edilmemiş olur.
     * Sadece "Görevi başlat." tetikleyicisiyle LLM'i ilk cevabı yazmaya zorlar.
     * 
     * @throws {Error} LLM API'ye erişilemediğinde hata fırlatabilir (missionManager içinde yakalanır).
     * 
     * @param {Object} mission - Üzerinde çalışılan aktif görev nesnesi.
     * @returns {Promise<string>} - Karşı tarafa WhatsApp üzerinden gönderilecek ilk temiz mesaj.
     */
    async generateFirstMessage(mission) {
        // System prompt'u mission'a kaydet (sonraki çağrılarda yeniden kullanılacak)
        mission.systemPrompt = this.buildSystemPrompt(mission);

        const response = await aiClient.chat([
            { role: 'system', content: mission.systemPrompt },
            { role: 'user', content: 'Görevi başlat.' },
        ], true);
        const { cleanMessage } = this._processResponse(response);

        // Geçmişe sadece asistan cevabını ekle (system prompt ayrıca saklanıyor)
        mission.conversationHistory.push(
            { role: 'assistant', content: cleanMessage }
        );
        mission.messageCount++;

        return cleanMessage;
    }

    /**
     * @description Karşı taraftan veya gruptan gelen mesaja bağlam çerçevesinde yanıt üretir.
     * **Zaman Farkındalığı (Time Awareness):** Gelen her mesaja gizlice `[SAAT: GG.AA.YYYY SS:DD:SS]` 
     * etiketini enjekte eder. Böylece LLM gerçek dünyadaki zamanı algılar ve geçmiş/gelecek kipleriyle 
     * zaman hesaplamasını otonom yapar.
     * 
     * @example
     * const replyData = await engine.generateReply(mission, "Tamam dosyayı yarın atarım");
     * console.log(replyData.status); // "active" (Henüz atılmadığı için)
     * 
     * @param {Object} mission - Geçmiş bağlamı (`conversationHistory`) barındıran aktif görev nesnesi.
     * @param {string} incomingMessage - Karşı tarafın attığı (mesaj havuzundan gelen birleştirilmiş) mesaj.
     * @returns {Promise<{message: string, status: string, memberStatus: Object}>} - Çözümlenmiş LLM yanıtı ve görev durum kararı.
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

        // ─────────────────────────────────────────────
        // Context Sıkıştırma (Faz 2D):
        // Uzun konuşmalarda token limiti aşılmasını önlemek için
        // eski mesajları özetle ve sıkıştır.
        // ─────────────────────────────────────────────
        await this._compressHistoryIfNeeded(mission);

        // System prompt'u history'nin başına enjekte ederek gönder
        const fullMessages = [
            { role: 'system', content: mission.systemPrompt },
            ...mission.conversationHistory,
        ];

        const response = await aiClient.chat(fullMessages, true);
        const { cleanMessage, status, memberStatus, relevance } = this._processResponse(response);

        // Cevabı geçmişe ekle (temiz metin olarak, JSON kirliliği önlenir)
        mission.conversationHistory.push({
            role: 'assistant',
            content: cleanMessage,
        });
        mission.messageCount++;

        return { message: cleanMessage, status, memberStatus, relevance };
    }

    /**
     * @description Sohbet bağlamını analiz ederek, karşı tarafın eylem sözü (commitment) verip vermediğini denetler.
     * Eğer karşı taraf "10 dakika sonra atarım", "akşama bakarım" gibi ifadeler kullandıysa, bu durumu 
     * yakalar ve dakika (`delayMinutes`) cinsinden scheduler için matematiksel bir bekleme süresi döner.
     * 
     * **Edge Case (Uç Durum):** LLM, aylar veya yıllar sonrasına mantıksız bir süre (`delayMinutes: 1440` ve `isUnreasonable: true`) 
     * döndürebilir. Bu durum `missionManager` tarafından engellenir ve maksimum süre sınırlarına (örn: 2 saat) çekilir.
     * 
     * @param {Object} mission - Aktif görev nesnesi.
     * @returns {Promise<{needsFollowUp: boolean, followUps: Array<{target: string, delayMinutes: number, isUnreasonable: boolean, reason: string}>}>} 
     *          - Takip gerekip gerekmediğini ve gerekiyorsa kim için ne kadar bekleneceğini içeren yapılandırılmış JSON nesnesi.
     */
    async analyzeForFollowUp(mission) {
        // ─────────────────────────────────────────────
        // Akıllı Son-Mesaj Kontrolü (Kusur #7 Düzeltmesi):
        // Eğer sohbetin son mesajı bottan geldiyse (bot soru sordu),
        // takip analizi yapma — karşı taraftan cevap beklenmeli.
        // Bu, circular reasoning'i (bot soru sordu → belirsizlik var → takip kur) engeller.
        // ─────────────────────────────────────────────
        const lastNonSystemMessage = [...mission.conversationHistory]
            .reverse()
            .find(m => m.role !== 'system' && !m.content.startsWith('[SİSTEM'));

        if (lastNonSystemMessage && lastNonSystemMessage.role === 'assistant') {
            console.log(`🔍 Son mesaj bottan geldi (#${mission.id}), takip analizi atlanıyor — cevap bekleniyor.`);
            return { needsFollowUp: false, followUps: [] };
        }

        const isGroup = mission.isGroup || false;
        // Sohbet geçmişinden son birkaç mesajı al
        const recentMessages = mission.conversationHistory
            .filter(m => m.role !== 'system' && !m.content.startsWith('[SİSTEM'))
            .slice(-6) // Gruplarda birden fazla kişi olduğu için daha fazla mesaj al
            .map(m => `${m.role === 'assistant' ? 'Ben' : 'Karşı Taraf'}: ${m.content}`)
            .join('\n');

        const now = new Date();
        const currentTime = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

        const analysisPrompt = `# GÖREV
Aşağıdaki WhatsApp sohbetini analiz et ve karşı tarafın bir eylem sözü verip vermediğini tespit et.

# BAĞLAM
Görev açıklaması: ${mission.taskDescription}
Şu anki zaman: ${currentTime}
Sohbet tipi: ${isGroup ? 'Grup sohbeti (mesajlar [KişiAdı]: formatında)' : 'Birebir sohbet'}

# SON MESAJLAR
${recentMessages}

# ANALİZ TALİMATLARI
1. Karşı taraf bir iş yapacağına dair söz verdi mi? (örn: "yaparım", "gönderirim", "bakarım")
2. Ne zaman yapacağını belirtti mi? Belirttiyse, şu anki zamanla aradaki farkı dakika cinsinden hesapla.
3. Verilen süre makul mü? (1 haftayı aşan süreler genellikle makul değildir)
4. Kesin teyit veya ret varsa takip gerekmez.

Süre Referansı:
| İfade | delayMinutes |
|-------|-------------|
| "hemen", "şimdi", "birazdan" | 5 |
| "yaparım", "hallederim", "bakarım" (belirsiz) | 15 |
| "yarım saat", "biraz sonra" | 30 |
| "1 saat sonra" | 60 |
| "akşam", "akşama" | ilgili saate kadar kalan dakika |
| "yarın" | 720 |
| "bu hafta", "birkaç gün" | 1440 |
| "aylar sonra", "seneye" (makul değil) | 1440, isUnreasonable=true |

# ÇIKTI (SADECE JSON)
{
  "needsFollowUp": <boolean>,
  "followUps": [
    {
      "target": "<string: kişi adı veya 'Kişi'>",
      "delayMinutes": <number: dakika cinsinden bekleme>,
      "isUnreasonable": <boolean: süre mantıksız mı>,
      "reason": "<string: kısa açıklama>"
    }
  ]
}${isGroup ? '\n\nGRUP NOTU: Her kişinin sözünü ayrı bir followUp nesnesi olarak döndür.' : ''}`;

        try {
            const response = await aiClient.chat([
                { role: 'system', content: 'Sen bir zamanlama analiz motorusun. Sadece geçerli JSON döndür, başka hiçbir metin ekleme.' },
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
            ? `Neden: ${followUpReason}`
            : '';

        // Mevcut saati hesapla (zaman farkındalığı)
        const now = new Date();
        const currentTime = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });

        // Takip talimatını geçmişe ekle
        mission.conversationHistory.push({
            role: 'user',
            content: `[SİSTEM NOTU — SAAT: ${currentTime}]
Beklenen süre doldu. ${reasonNote}
Talimatlar:
- Durumu doğal bir dille sor ("Nasıl oldu, halledebildiniz mi?" gibi).
- Eğer karşı taraf daha önce belirli bir saat vermişse ve o saat geçtiyse, bunu kibarca hatırlat.
- Önceki mesajlarından farklı bir yaklaşım veya açı kullan.
- Sohbet tarzını koru, resmi/robotik olma.`,
        });

        // System prompt'u history'nin başına enjekte ederek gönder
        const fullMessages = [
            { role: 'system', content: mission.systemPrompt },
            ...mission.conversationHistory,
        ];

        const response = await aiClient.chat(fullMessages, true);
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
                    content: `Sen bir görev raporlama asistanısın. Aşağıdaki WhatsApp sohbetini analiz et ve Türkçe 1-2 cümlelik bir özet yaz.
Özette şunları belirt:
- Görevin sonucu (başarılı mı, başarısız mı)
- Karşı tarafın son tutumu veya taahhüdü
- Varsa önemli detaylar (tarih, miktar, koşul vb.)
Gereksiz detayları atla, sadece sonuç ve çıkarımı yaz.`,
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
     * @description LLM'den dönen kirli (Markdown blokları ve açıklamalar içeren) çıktıyı temizleyerek güvenli JSON/Metin parçalarına böler.
     * Bu fonksiyon sistemin hataya karşı dayanıklılığının (resilience) anahtarıdır.
     * 
     * **Çalışma Süreci (3 Adım):**
     * 1. **Parse:** Önce regex ile `{ ... }` bloğunu arar ve JSON olarak parse etmeyi dener.
     * 2. **Fallback:** Eğer JSON bozuksa (örn. eksik tırnak), regex ile sadece `"reply": "..."` kalıbının içini kurtarmaya çalışır.
     * 3. **Clean:** LLM'in yanlışlıkla bıraktığı `[SAAT: ...]` veya `asistan:` gibi serseri rolleri metinden temizler.
     * 
     * @private
     * @param {string} response - Gemini CLI veya API'den gelen ham metin (genellikle Markdown + JSON).
     * @returns {{cleanMessage: string, status: string, memberStatus: Object}} - Arıtılmış ve güvenli hale getirilmiş yapı.
     */
    _processResponse(response) {
        let status = 'active';
        let cleanMessage = response;
        let memberStatus = {};
        let relevance = 'on_topic'; // Varsayılan: görevle ilgili

        // ── 1. ADIM: JSON Ayrıştırma ──
        try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);

                // reply alanını çıkar (öncelik sırasıyla)
                cleanMessage = parsed.reply ?? parsed.content ?? parsed.message ?? response.replace(/[\{\}\"]/g, '').trim();

                if (parsed.status) status = parsed.status;
                if (parsed.memberStatus) memberStatus = parsed.memberStatus;
                if (parsed.relevance) relevance = parsed.relevance;
            } else {
                // JSON bulunamadı → ham metin olarak kullan
                cleanMessage = response.trim();
            }
        } catch (e) {
            // ── 2. ADIM: Bozuk JSON Kurtarma (Fallback) ──
            console.warn('⚠️ JSON ayrıştırma hatası, kurtarma deneniyor:', e.message);

            // "reply": "..." kalıbını regex ile çıkar
            const replyMatch = response.match(/"reply"\s*:\s*"([\s\S]*?)("(?=\s*,)|"(?=\s*\})|$)/);
            if (replyMatch?.[1]) {
                cleanMessage = replyMatch[1];
            } else {
                // Son çare: JSON yapı artıklarını temizle
                cleanMessage = response
                    .replace(/[\{\}]/g, '')
                    .replace(/"reply"\s*:\s*/g, '')
                    .replace(/"status"\s*:\s*".*?"/g, '')
                    .replace(/"memberStatus"\s*:\s*.*/g, '')
                    .replace(/^"|"$/g, '')
                    .trim();
            }
        }

        // ── 3. ADIM: Son Temizlik ──
        // [SAAT: ...] etiketi sızdıysa temizle
        cleanMessage = cleanMessage.replace(/\[SAAT:\s*[\d.:\/\s]+\]/g, '').trim();

        // Başta kalan rol etiketlerini temizle
        cleanMessage = cleanMessage.replace(/^(reply|asistan|cevap|message|content|bot|assistant)\s*:\s*/i, '').trim();

        return { cleanMessage, status, memberStatus, relevance };
    }

    /**
     * @description Konuşma geçmişi belirli bir eşiği aştığında eski mesajları LLM ile
     * özetleyerek sıkıştırır. Bu sayede token limiti aşılmaz ve bağlam korunur.
     * 
     * Çalışma prensibi:
     * 1. Geçmiş 16 mesajı aştığında tetiklenir
     * 2. Son 6 mesaj korunur (güncel bağlam)
     * 3. Eski mesajlar LLM ile 3-4 cümlelik özete dönüştürülür
     * 4. Özet, [BAĞLAM ÖZETİ] etiketi ile geçmişin başına eklenir
     * 
     * @private
     * @param {Object} mission - Aktif görev nesnesi
     */
    async _compressHistoryIfNeeded(mission) {
        const THRESHOLD = 16;   // Sıkıştırma eşiği
        const KEEP_LAST = 6;    // Korunacak son mesaj sayısı

        const history = mission.conversationHistory;
        if (history.length <= THRESHOLD) return;

        console.log(`📦 Bağlam sıkıştırma tetiklendi (#${mission.id}): ${history.length} mesaj → ~${KEEP_LAST + 1} mesaja düşürülecek.`);

        // Sıkıştırılacak eski mesajları ayır
        const oldMessages = history.slice(0, -KEEP_LAST);
        const recentMessages = history.slice(-KEEP_LAST);

        // Eski mesajları okunabilir formata çevir
        const oldText = oldMessages
            .filter(m => m.role !== 'system' && !m.content.startsWith('[SİSTEM'))
            .map(m => `${m.role === 'assistant' ? 'Ajan' : 'Kişi'}: ${m.content}`)
            .join('\n');

        if (!oldText.trim()) {
            // Sıkıştırılacak anlamlı içerik yok
            return;
        }

        try {
            const summary = await aiClient.chat([
                {
                    role: 'system',
                    content: `Sen bir konuşma özetleme motorusun. Aşağıdaki WhatsApp sohbetini 3-4 cümle ile Türkçe özetle.
Özette şunları koru:
- Kim ne söz verdi (tarih/saat dahil)
- Karşı tarafın son tutumu
- Görevle ilgili önemli bilgiler (isim, plaka, miktar vb.)
- Belirsiz kalan konular
Gereksiz selamlaşmaları ve tekrarları atla. Sadece özet metni döndür, başka bir şey yazma.`,
                },
                { role: 'user', content: oldText },
            ]);

            // Geçmişi sıkıştırılmış haliyle değiştir
            mission.conversationHistory = [
                { role: 'user', content: `[BAĞLAM ÖZETİ — Önceki ${oldMessages.length} mesaj]\n${summary.trim()}` },
                ...recentMessages,
            ];

            console.log(`📦 Bağlam sıkıştırıldı (#${mission.id}): ${history.length} → ${mission.conversationHistory.length} mesaj`);
        } catch (error) {
            console.warn(`⚠️ Bağlam sıkıştırma hatası (#${mission.id}):`, error.message);
            // Hata durumunda orijinal geçmişi koru
        }
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

