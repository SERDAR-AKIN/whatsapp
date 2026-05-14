// ============================================
// WhatsApp Otonom Ajan Sistemi — Görev Yöneticisi
// ============================================

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const ConversationEngine = require('./conversationEngine');
const Scheduler = require('./scheduler');
const { MissionStateMachine } = require('./stateMachine');
const CONFIG = require('./config');

class MissionManager extends EventEmitter {
    constructor(whatsappClient) {
        super(); // EventEmitter başlat
        this.client = whatsappClient;
        this.activeMissions = new Map(); // targetChatId → Mission
        this.conversationEngine = new ConversationEngine();
        this.scheduler = new Scheduler();
        this.myNumber = null; // Botun kendi numarası (ready olunca set edilir)

        // Log dizinini oluştur
        if (CONFIG.logging.saveToFile) {
            const logDir = path.resolve(CONFIG.logging.logDir);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
        }

        // Kalıcı Hafıza (Persistence) dizinini oluştur
        this.dataDir = path.resolve('./data');
        this.stateFile = path.join(this.dataDir, 'active_missions.json');
        this.tempStateFile = path.join(this.dataDir, 'active_missions.tmp');

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Botun kendi numarasını ayarlar.
     * @param {string} number
     */
    setMyNumber(number) {
        this.myNumber = number;
        console.log(`📱 Bot numarası: ${number}`);
    }

    /**
     * Yeni bir görev başlatır.
     * @param {Object} mission - parseCommand'den dönen görev objesi
     * @returns {Promise<string>} - Kullanıcıya gösterilecek durum mesajı
     */
    async startMission(mission) {
        // Aynı kişiye zaten aktif görev var mı kontrol et
        if (this.activeMissions.has(mission.targetChatId)) {
            const existing = this.activeMissions.get(mission.targetChatId);
            return `⚠️ Bu numaraya zaten aktif bir görev var (ID: #${existing.id}). Önce !stop ${existing.id} ile durdurun.`;
        }

        try {
            // Görevi aktif olarak kaydet ve timers objesini başlat
            mission.stateMachine = new MissionStateMachine('pending');
            mission.stateMachine.transition('active', 'Görev başlatıldı');
            mission.status = mission.stateMachine.state;
            mission.timers = {};
            mission.isGroup = mission.targetChatId.endsWith('@g.us');
            this.activeMissions.set(mission.targetChatId, mission);

            // LLM'den ilk mesajı üret
            console.log(`🚀 Görev başlatılıyor: #${mission.id} → ${mission.targetNumber}`);
            const firstMessage = await this.conversationEngine.generateFirstMessage(mission);

            // WhatsApp'tan mesajı gönder
            await this.client.sendMessage(mission.targetChatId, firstMessage);
            console.log(`📤 İlk mesaj gönderildi: ${firstMessage}`);

            // ─────────────────────────────────────────────
            // Başlangıç Takip Zamanlayıcısı
            // İlk mesajdan sonra karşı taraf cevap vermezse
            // boşta kalmaması için bir takip kurulur
            // ─────────────────────────────────────────────
            if (mission.options.retryInterval) {
                // Komutta periyodik süre belirtilmişse onu kullan
                this.scheduler.startInterval(
                    mission.id,
                    mission.options.retryInterval,
                    (mId) => this._handleFollowUp(mId)
                );
            } else {
                // Belirtilmemişse: 5 dakika sonra ilk takip mesajı gönder
                const initialFollowUpDelay = 5 * 60 * 1000; // 5 dakika
                console.log(`⏰ Başlangıç takibi kuruldu (#${mission.id}): ${initialFollowUpDelay / 60000} dakika sonra`);
                mission.timers.nextFollowUpAt = this.scheduler.startFollowUpTimeout(
                    mission.id,
                    initialFollowUpDelay,
                    'İlk mesaja henüz cevap gelmedi',
                    (mId, reason) => this._handleFollowUp(mId, reason)
                );
                mission.timers.followUpReason = 'İlk mesaja henüz cevap gelmedi';
                // Faz 3 uyumlu: individualFollowUps'a da kaydet (restoreMissions tutarlılığı için)
                if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};
                mission.timers.individualFollowUps[mission.id] = mission.timers.nextFollowUpAt;
            }

            // Zaman aşımı zamanlayıcısı
            mission.timers.missionTimeoutAt = this.scheduler.startTimeout(
                mission.id,
                mission.options.timeout,
                (mId) => this._handleTimeout(mId)
            );

            // Diske kaydet
            this._saveState();

            // Event yayınla (Faz 2C)
            this.emit('mission:started', {
                missionId: mission.id,
                target: mission.targetNumber,
                task: mission.taskDescription,
            });

            // Seçenekleri formatla
            const retryInfo = mission.options.retryInterval
                ? `\n🔁 Tekrar: ${mission.options.retryInterval / 60000} dakikada bir`
                : '\n🔁 Takip: Cevap gelmezse 5 dk sonra hatırlatma';
            const conditionInfo = mission.options.completionCondition
                ? `\n✅ Tamamlanma: ${mission.options.completionCondition}`
                : '';

            return `✅ Görev oluşturuldu (ID: #${mission.id})
📱 Hedef: ${mission.targetNumber}
📋 Görev: ${mission.taskDescription.substring(0, 100)}...
⏳ Durum: İlk mesaj gönderildi${retryInfo}${conditionInfo}`;

        } catch (error) {
            mission.status = 'failed';
            this.activeMissions.delete(mission.targetChatId);
            console.error(`❌ Görev başlatma hatası:`, error);
            return `❌ Görev başlatılamadı: ${error.message}`;
        }
    }

    /**
     * @description WhatsApp'tan gelen mesajları doğrudan LLM'e göndermek yerine bir havuza (queue) ekler.
     * **Message Pooling (Mesaj Havuzu) Mantığı:** 
     * Kullanıcıların peş peşe gönderdiği mesajlar 15 saniyelik bir `throttleTimeout` ile biriktirilir.
     * Bu süre dolduğunda tüm havuz tek bir metin olarak birleştirilip LLM'e gönderilir (`_processReply`).
     * 
     * **Yarış Koşulu (Race Condition) Önlemi:** `throttleTimeoutActive` bayrağı sayesinde aynı anda birden
     * fazla LLM isteği (overlap) fırlatılması kesin olarak engellenir.
     * 
     * @example
     * // Kullanıcı 3 saniye arayla "Tamam", "Yarın", "Görüşürüz" yazdı.
     * // handleIncomingMessage 3 kez çağrılır ama LLM'e tek bir "Tamam\nYarın\nGörüşürüz" mesajı gider.
     * 
     * @param {string} chatId - Mesajın geldiği chat ID (hem @c.us hem @lid olabilir)
     * @param {string} messageBody - Mesaj içeriği
     * @param {string} contactNumber - Gerçek telefon numarası (opsiyonel, @lid sorununu çözmek için)
     * @param {string} senderName - Grup içi mesajlarda konuşan kişinin ismi
     * @returns {Promise<boolean>} - Mesaj bir göreve yönlendirildiyse true
     */
    async handleIncomingMessage(chatId, messageBody, contactNumber = null, senderName = null) {
        let mission = this._findMissionByChatId(chatId);
        
        // Eğer chatId (örn: @lid) ile bulunamadıysa ve telefon numarası biliniyorsa onunla dene
        if (!mission && contactNumber) {
            mission = this._findMissionByChatId(`${contactNumber}@c.us`);
        }

        // ─────────────────────────────────────────────
        // NOT: Eski "Smart Fallback" mekanizması kaldırıldı.
        // Tek aktif görev varken LID'i o göreve tahmin ederek eşleştiriyordu.
        // Bu yaklaşım kırılgandı (2+ görevde sessiz başarısızlık).
        // Artık LID çözümlemesi merkezi LidResolver modülü üzerinden yapılıyor.
        // ─────────────────────────────────────────────

        if (!mission) return false; // Bu kişiye aktif görev yok

        // İlk kez farklı bir chatId formatıyla karşılaştıysak kaydet (@lid vs @c.us haritalama)
        if (chatId !== mission.targetChatId && !mission.alternativeChatId) {
            mission.alternativeChatId = chatId;
            // Alternatif chatId ile de hızlı erişim sağla
            this.activeMissions.set(chatId, mission);
            console.log(`🔗 Alternatif chatId keşfedildi (#${mission.id}): ${chatId}`);
        }

        let formattedBody = messageBody;
        if (mission.isGroup && senderName) {
            formattedBody = `[${senderName}]: ${messageBody}`;
        }

        console.log(`📥 Hedef kişiden mesaj geldi (#${mission.id}): ${formattedBody}`);

        // Maksimum mesaj kontrolü
        if (mission.messageCount >= mission.options.maxMessages) {
            await this._completeMission(mission, 'failed', 'Maksimum mesaj sayısına ulaşıldı.');
            return;
        }

        // ─────────────────────────────────────────────
        // NOT: Zamanlayıcı temizleme ARTIK burada yapılmıyor.
        // Takip iptali, LLM cevabından sonra _processReply içinde
        // context-aware olarak gerçekleştirilir. (Kusur #2 Düzeltmesi)
        // ─────────────────────────────────────────────

        // Birebir veya Grup fark etmeksizin spam'ı önlemek için havuza ekle
        if (!mission.messageQueue) mission.messageQueue = [];
        mission.messageQueue.push(formattedBody);

        if (!mission.timers.throttleTimeoutActive) {
            // ─────────────────────────────────────────────
            // Adaptif Throttle (Kusur #6 Düzeltmesi):
            // İlk mesaj için 5s (daha hızlı yanıt), sonraki mesajlar için 15s
            // ─────────────────────────────────────────────
            const isFirstReply = !mission.firstReplyReceived;
            const throttleMs = isFirstReply ? 5000 : 15000;
            mission.firstReplyReceived = true;

            const chatType = mission.isGroup ? "Grup" : "Birebir";
            console.log(`⏳ ${chatType} mesajı havuza alındı (#${mission.id}). ${throttleMs/1000} saniye bekleniyor...`);
            
            mission.timers.throttleTimeoutActive = true;
            const replyChatId = mission.targetChatId; // Closure güvenliği: sabit chatId yakala
            this.scheduler.startThrottleTimeout(mission.id, throttleMs, async (mId) => {
                // ⚠️ throttleTimeoutActive işlem bitene kadar true KALIR (yarış koşulu önlemi)
                await this._processReply(mId, replyChatId);

                // ─────────────────────────────────────────────
                // Drain Döngüsü (Kusur #3 Düzeltmesi):
                // Ara iterasyonlar skipFollowUpAnalysis=true ile çağrılır.
                // Sadece son iterasyon (kuyruk boşalınca) tam pipeline çalıştırır.
                // ─────────────────────────────────────────────
                const drainMs = 15000;
                while (mission.messageQueue && mission.messageQueue.length > 0 && mission.status === 'active') {
                    console.log(`⏳ İşlem sırasında ${mission.messageQueue.length} yeni mesaj birikti (#${mission.id}). ${drainMs/1000}s beklenip işlenecek...`);
                    await new Promise(r => setTimeout(r, drainMs));
                    // Drain'deki ara adımda kuyrukta hâlâ mesaj olup olmadığını kontrol et
                    // Eğer bu son iterasyonsa (kuyruk boşalacaksa) tam pipeline çalıştır
                    const willHaveMore = mission.messageQueue && mission.messageQueue.length > 1;
                    await this._processReply(mId, replyChatId, { skipFollowUpAnalysis: willHaveMore });
                }

                mission.timers.throttleTimeoutActive = false; // Ancak tüm kuyruk boşaldıktan sonra serbest bırak
            });
        } else {
            console.log(`⏳ Mesaj havuza eklendi (#${mission.id}). Toplam: ${mission.messageQueue.length}`);
        }
        return true;
    }

    /**
     * @description Bekleyen mesaj havuzunu (messageQueue) birleştirerek `conversationEngine` üzerinden LLM'e iletir.
     * **Hata Kurtarma (Retry):** Eğer LLM (Gemini/Ollama) yanıt vermezse, `maxRetries` (2) kadar tekrar dener.
     * Eğer tüm denemeler başarısız olursa, havuzdaki mesajları kaybetmemek için kuyruğun en başına (unshift) geri koyar.
     * 
     * @private
     * @param {string} missionId - İşlenecek görevin benzersiz ID'si.
     * @param {string} chatId - WhatsApp sohbet (chat) ID'si.
     * @returns {Promise<void>}
     */
    async _processReply(missionId, chatId, options = {}) {
        const { skipFollowUpAnalysis = false } = options;

        const mission = this._findMissionById(missionId);
        if (!mission || mission.status !== 'active') return;

        if (!mission.messageQueue || mission.messageQueue.length === 0) return;
        const combinedMessage = mission.messageQueue.join('\n');
        mission.messageQueue = []; // Kuyruğu temizle

        // ─────────────────────────────────────────────
        // LLM Çağrısı (Retry Mekanizmalı)
        // ─────────────────────────────────────────────
        let llmResult = null;
        const maxRetries = 2;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                llmResult = await this.conversationEngine.generateReply(mission, combinedMessage);
                break; // Başarılı, döngüden çık
            } catch (error) {
                if (attempt < maxRetries) {
                    const waitSec = (attempt + 1) * 5;
                    console.warn(`⚠️ Ollama hatası (#${mission.id}), ${waitSec}s sonra tekrar denenecek (deneme ${attempt + 1}/${maxRetries})...`);
                    await new Promise(r => setTimeout(r, waitSec * 1000));
                } else {
                    console.error(`❌ Ollama ${maxRetries + 1} denemede de başarısız (#${mission.id}):`, error.message);
                    // Mesajları geri kuyruğa koy (kaybolmasın)
                    if (!mission.messageQueue) mission.messageQueue = [];
                    mission.messageQueue.unshift(combinedMessage);
                    console.log(`🔄 Mesajlar kuyruğa geri eklendi (#${mission.id}). Bir sonraki mesajda tekrar denenecek.`);
                    return;
                }
            }
        }

        const { message, status, memberStatus, relevance } = llmResult;

        // Gruptaki kişilerin durumunu güncelle ve logla
        if (mission.isGroup && Object.keys(memberStatus || {}).length > 0) {
            mission.memberStatus = { ...(mission.memberStatus || {}), ...memberStatus };
            console.log(`👥 Grup Durum Matrisi (#${mission.id}):`, JSON.stringify(mission.memberStatus));
        }

        // Cevabı WhatsApp'tan gönder (boş mesaj kontrolü)
        if (!message || message.trim() === '') {
            console.warn(`⚠️ LLM boş mesaj üretti (#${mission.id}), gönderilmedi.`);
            return;
        }
        await this.client.sendMessage(chatId, message);
        console.log(`📤 Ajan cevabı (#${mission.id}): ${message}`);

        // Event yayınla (Faz 2C)
        this.emit('mission:reply_sent', {
            missionId: mission.id,
            message: message,
            relevance: relevance || 'on_topic',
            target: mission.targetNumber,
        });

        // Görev durumunu kontrol et
        if (status === 'completed') {
            await this._completeMission(mission, 'completed');
            return;
        } else if (status === 'failed') {
            await this._completeMission(mission, 'failed');
            return;
        }

        // ─────────────────────────────────────────────
        // Relevance-Aware Zamanlayıcı Stratejisi
        // (Kusur #2, #3, #4, #5 Düzeltmeleri)
        // ─────────────────────────────────────────────

        // OFF_TOPIC mesajlarda zamanlayıcılara DOKUNMA (Kusur #5)
        // Mevcut zamanlayıcılar korunur, görev konusu zorlanmaz.
        if (relevance === 'off_topic') {
            console.log(`💬 Görev dışı mesaj algılandı (#${mission.id}), zamanlayıcılar korunuyor.`);
            this._saveState();
            return;
        }

        // Drain döngüsünün ara iterasyonlarında takip analizi ATLA (Kusur #3)
        if (skipFollowUpAnalysis) {
            console.log(`⏩ Drain iterasyonu — takip analizi atlanıyor (#${mission.id}).`);
            this._saveState();
            return;
        }

        // ─────────────────────────────────────────────
        // Zamanlayıcı Temizleme (Kusur #2 Düzeltmesi):
        // Artık LLM cevabından SONRA ve yeni zamanlayıcı
        // kurulmadan HEMEN ÖNCE yapılır.
        // ─────────────────────────────────────────────
        this.scheduler.clearInterval(mission.id);
        if (!mission.isGroup) {
            this.scheduler.clearFollowUpTimeout(mission.id);
        }

        // ─────────────────────────────────────────────
        // Zamanlayıcı Stratejisi (Öncelik Sırası):
        // ─────────────────────────────────────────────
        try {
            console.log(`🔍 Takip analizi yapılıyor (#${mission.id})...`);
            const followUp = await this.conversationEngine.analyzeForFollowUp(mission);

            if (followUp.needsFollowUp && followUp.followUps && followUp.followUps.length > 0) {
                // ✅ Akıllı takip öncelikli
                if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};

                for (let fu of followUp.followUps) {
                    const delayMinutes = Math.round(fu.delayMs / 60000);
                    const targetInfo = mission.isGroup ? ` [${fu.target}]` : '';
                    console.log(`⏰ Akıllı takip planlandı (#${mission.id}${targetInfo}): ${delayMinutes} dakika sonra — ${fu.reason}`);

                    const myChatId = `${this.myNumber}@c.us`;

                    if (fu.isUnreasonable) {
                        await this.client.sendMessage(myChatId,
                            `⚠️ #${mission.id} → ${mission.targetNumber}${targetInfo}\n` +
                            `🚩 Mantık dışı cevap algılandı: ${fu.reason}\n` +
                            `🤖 Ajan nazikçe itiraz etti ve makul bir süreye yönlendirdi.\n` +
                            `🔁 ${delayMinutes} dakika sonra takip yapılacak.`
                        );
                    }

                    const timerId = mission.isGroup ? `${mission.id}_${fu.target}` : mission.id;
                    
                    mission.timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                        timerId,
                        fu.delayMs,
                        fu.reason,
                        (tId, reason) => this._handleFollowUp(mission.id, reason, fu.target)
                    );
                }
            } else if (mission.options.retryInterval) {
                // ⏰ Akıllı takip gerekmedi → periyodik
                console.log(`⏰ Periyodik takip yeniden başlatıldı (#${mission.id}): ${mission.options.retryInterval / 60000} dk`);
                this.scheduler.startInterval(
                    mission.id,
                    mission.options.retryInterval,
                    (mId) => this._handleFollowUp(mId)
                );
            } else {
                // ⏳ Hiçbir zamanlayıcı yok → varsayılan geri düşüş
                console.log(`⏳ Varsayılan takip bekleniyor (#${mission.id}): 30 dakika`);
                const timerId = mission.id;
                if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};
                mission.timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                    timerId,
                    30 * 60 * 1000,
                    'Karşı taraftan uzun süredir cevap gelmedi',
                    (tId, reason) => this._handleFollowUp(mission.id, reason)
                );
            }
        } catch (analyzeError) {
            // Takip analizi başarısız olursa varsayılan 30dk takip kur
            console.warn(`⚠️ Takip analizi hatası (#${mission.id}):`, analyzeError.message);
            console.log(`⏳ Varsayılan takip bekleniyor (#${mission.id}): 30 dakika`);
            const timerId = mission.id;
            if (!mission.timers) mission.timers = {};
            if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};
            mission.timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                timerId,
                30 * 60 * 1000,
                'Takip analizi başarısız, varsayılan bekleme',
                (tId, reason) => this._handleFollowUp(mission.id, reason)
            );
        }

        this._saveState();
    }

    /**
     * Periyodik veya akıllı takip mesajı gönderir.
     * @param {string} missionId
     * @param {string} [reason] - Takibin nedeni (akıllı takip analizi sonucu)
     * @param {string} [target] - Grup içindeki kişi (opsiyonel)
     * @private
     */
    async _handleFollowUp(missionId, reason, target = null) {
        const mission = this._findMissionById(missionId);
        if (!mission || mission.status !== 'active') {
            this.scheduler.clearAll(missionId);
            return;
        }

        // Maksimum tekrar kontrolü
        if (mission.retryCount >= mission.options.maxRetries) {
            await this._completeMission(mission, 'failed', 'Maksimum takip sayısına ulaşıldı, cevap alınamadı.');
            return;
        }

        try {
            // ─────────────────────────────────────────────
            // LLM Çağrısı (Retry Mekanizmalı)
            // ─────────────────────────────────────────────
            let llmResult = null;
            const maxRetries = 2;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    llmResult = await this.conversationEngine.generateFollowUp(mission, reason);
                    break; // Başarılı, döngüden çık
                } catch (error) {
                    if (attempt < maxRetries) {
                        const waitSec = (attempt + 1) * 5;
                        console.warn(`⚠️ Ollama hatası (#${mission.id} - Takip), ${waitSec}s sonra tekrar denenecek (deneme ${attempt + 1}/${maxRetries})...`);
                        await new Promise(r => setTimeout(r, waitSec * 1000));
                    } else {
                        throw error; // Tüm denemeler başarısızsa dış catch bloğuna fırlat
                    }
                }
            }

            const { message, status, memberStatus } = llmResult;
            
            if (mission.isGroup && Object.keys(memberStatus || {}).length > 0) {
                mission.memberStatus = { ...(mission.memberStatus || {}), ...memberStatus };
                console.log(`👥 Grup Durum Matrisi (#${mission.id}):`, JSON.stringify(mission.memberStatus));
            }

            await this.client.sendMessage(mission.targetChatId, message);
            console.log(`📤 Takip mesajı (#${mission.id}, deneme ${mission.retryCount}): ${message}`);

            const timerId = target && mission.isGroup ? `${mission.id}_${target}` : mission.id;
            this.scheduler.clearFollowUpTimeout(timerId);

            // Eğer periyodik (interval) döngüsü yoksa bir sonraki varsayılan bekleme süresini (30 dk) kur
            if (!mission.options.retryInterval) {
                if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};
                mission.timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                    timerId,
                    30 * 60 * 1000, // Varsayılan 30 dakika
                    'Takip mesajına henüz cevap gelmedi',
                    (tId, r) => this._handleFollowUp(mission.id, r, target)
                );
            }

            this._saveState();

            if (status === 'completed') {
                await this._completeMission(mission, 'completed');
            } else if (status === 'failed') {
                await this._completeMission(mission, 'failed');
            }
        } catch (error) {
            console.error(`❌ Takip mesajı hatası (#${mission.id}):`, error.message);
            // Hata durumunda (Ollama çökmesi vb.) döngünün ölmemesi için 5 dakika sonra tekrar dene
            const timerId = target && mission.isGroup ? `${mission.id}_${target}` : mission.id;
            if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};
            mission.timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                timerId,
                5 * 60 * 1000, // 5 dakika sonra
                reason || 'Ollama bağlantı hatası nedeniyle gecikmiş takip',
                (tId, r) => this._handleFollowUp(mission.id, r, target)
            );
            this._saveState();
        }
    }

    /**
     * Zaman aşımı durumunu işler.
     * @param {string} missionId
     * @private
     */
    async _handleTimeout(missionId) {
        const mission = this._findMissionById(missionId);
        if (!mission || mission.status !== 'active') return;

        await this._completeMission(mission, 'failed', 'Görev zaman aşımına uğradı.');
    }

    /**
     * Görevi tamamlar, zamanlayıcıları temizler, rapor gönderir.
     * @param {Object} mission
     * @param {string} status - 'completed' | 'failed'
     * @param {string} [reason] - Başarısızlık nedeni
     * @private
     */
    async _completeMission(mission, status, reason) {
        // State Machine ile gücül durum geçişi
        try {
            if (mission.stateMachine && mission.stateMachine.canTransition(status)) {
                mission.stateMachine.transition(status, reason || `Görev ${status}`);
                mission.status = mission.stateMachine.state;
            } else {
                mission.status = status; // Geriye dönük uyumluluk
            }
        } catch (e) {
            console.warn(`⚠️ Durum geçişi hatası (#${mission.id}):`, e.message);
            mission.status = status;
        }
        mission.completedAt = new Date().toISOString();

        // Zamanlayıcıları temizle
        this.scheduler.clearAll(mission.id);

        // Aktif görevlerden kaldır
        this.activeMissions.delete(mission.targetChatId);
        if (mission.alternativeChatId) {
            this.activeMissions.delete(mission.alternativeChatId);
        }

        console.log(`${status === 'completed' ? '✅' : '❌'} Görev sonlandı: #${mission.id} — ${status}`);
        if (reason) console.log(`   Neden: ${reason}`);

        // Kullanıcıya rapor gönder
        try {
            let report = await this.conversationEngine.generateReport(mission);
            if (reason) report += `\n📌 Not: ${reason}`;

            const myChatId = `${this.myNumber}@c.us`;
            await this.client.sendMessage(myChatId, report);
        } catch (error) {
            console.error('❌ Rapor gönderilemedi:', error);
        }

        // Log dosyasına kaydet
        this._saveLog(mission);
        this._saveState();

        // Event yayınla (Faz 2C)
        this.emit('mission:completed', {
            missionId: mission.id,
            status: mission.status,
            reason: reason || null,
            target: mission.targetNumber,
        });
    }

    /**
     * Aktif bir görevi durdurur.
     * @param {string} missionId - Görev ID veya 'all'
     * @returns {string} - Durum mesajı
     */
    stopMission(missionId) {
        if (missionId === 'all') {
            const count = this.activeMissions.size;
            for (const [, mission] of this.activeMissions) {
                // State Machine ile geçiş
                try {
                    if (mission.stateMachine && mission.stateMachine.canTransition('stopped')) {
                        mission.stateMachine.transition('stopped', 'Kullanıcı tarafından durduruldu');
                        mission.status = mission.stateMachine.state;
                    } else {
                        mission.status = 'stopped';
                    }
                } catch { mission.status = 'stopped'; }
                mission.completedAt = new Date().toISOString();
                this._saveLog(mission);
                this.emit('mission:stopped', { missionId: mission.id, target: mission.targetNumber });
            }
            this.activeMissions.clear();
            this.scheduler.clearEverything();
            this._saveState();
            return `🛑 Tüm görevler durduruldu (${count} görev).`;
        }

        const mission = this._findMissionById(missionId);
        if (!mission) {
            return `⚠️ Görev bulunamadı: ${missionId}`;
        }

        // State Machine ile geçiş
        try {
            if (mission.stateMachine && mission.stateMachine.canTransition('stopped')) {
                mission.stateMachine.transition('stopped', 'Kullanıcı tarafından durduruldu');
                mission.status = mission.stateMachine.state;
            } else {
                mission.status = 'stopped';
            }
        } catch { mission.status = 'stopped'; }
        mission.completedAt = new Date().toISOString();
        this.scheduler.clearAll(mission.id);
        this.activeMissions.delete(mission.targetChatId);
        if (mission.alternativeChatId) {
            this.activeMissions.delete(mission.alternativeChatId);
        }
        this._saveLog(mission);
        this._saveState();

        // Event yayınla (Faz 2C)
        this.emit('mission:stopped', { missionId: mission.id, target: mission.targetNumber });

        return `🛑 Görev durduruldu: #${mission.id}`;
    }

    /**
     * Aktif görevlerin listesini döndürür.
     * @returns {string}
     */
    getStatusReport() {
        if (this.activeMissions.size === 0) {
            return '📋 Aktif görev bulunmuyor.';
        }

        // Deduplikasyon: Aynı mission hem targetChatId hem alternativeChatId ile map'te olabilir
        const seen = new Set();
        let count = 0;
        let report = '';
        for (const [, mission] of this.activeMissions) {
            if (seen.has(mission.id)) continue;
            seen.add(mission.id);
            count++;
            const elapsed = this._getElapsedTime(mission.createdAt);
            report += `\n🔹 #${mission.id} → ${mission.targetNumber}`;
            report += `\n   📋 ${mission.taskDescription.substring(0, 60)}...`;
            report += `\n   💬 ${mission.messageCount} mesaj | ⏱️ ${elapsed}\n`;
        }

        return `📋 Aktif Görevler (${count}):\n${report}`;
    }

    /**
     * Görev ID'sine göre görev bulur.
     * @param {string} missionId
     * @returns {Object|undefined}
     * @private
     */
    _findMissionById(missionId) {
        for (const [, mission] of this.activeMissions) {
            if (mission.id === missionId) return mission;
        }
        return undefined;
    }

    /**
     * Chat ID veya Telefon Numarası ile görevi bulur.
     * LID çözümlemesi artık merkezi LidResolver tarafından yapıldığı için,
     * bu metod sadece @c.us, @g.us ve alternativeChatId eşleştirmesi yapar.
     * 
     * @param {string} chatId - Gelen mesajın chatId'si
     * @returns {Object|undefined}
     * @private
     */
    _findMissionByChatId(chatId) {
        // 1. Tam eşleşme kontrolü (activeMissions map'inden — O(1))
        if (this.activeMissions.has(chatId)) {
            return this.activeMissions.get(chatId);
        }

        // 2. Numara tabanlı eşleşme: chatId'nin numara kısmını targetNumber ile karşılaştır
        //    Bu, LidResolver'dan gelen contactNumber@c.us formatıyla çalışır.
        const incomingNumber = chatId.split('@')[0];

        for (const [, mission] of this.activeMissions) {
            // alternativeChatId üzerinden eşleşme (geriye dönük uyumluluk)
            if (chatId === mission.alternativeChatId) {
                return mission;
            }
            // Numara eşleşmesi: örn "905xxxxxxxxxx" === mission.targetNumber
            if (incomingNumber === mission.targetNumber) {
                return mission;
            }
        }

        return undefined;
    }

    /**
     * Geçen süreyi okunabilir formatta döndürür.
     * @private
     */
    _getElapsedTime(startISO) {
        const diffMs = Date.now() - new Date(startISO).getTime();
        const mins = Math.floor(diffMs / 60000);
        if (mins < 1) return 'az önce';
        if (mins < 60) return `${mins} dk`;
        return `${Math.floor(mins / 60)} sa ${mins % 60} dk`;
    }

    /**
     * Görev logunu dosyaya kaydeder.
     * @param {Object} mission
     * @private
     */
    _saveLog(mission) {
        if (!CONFIG.logging.saveToFile) return;

        try {
            const logDir = path.resolve(CONFIG.logging.logDir);
            const filename = `mission_${mission.id}_${mission.status}.json`;
            const filepath = path.join(logDir, filename);

            const logData = {
                id: mission.id,
                targetNumber: mission.targetNumber,
                taskDescription: mission.taskDescription,
                status: mission.status,
                createdAt: mission.createdAt,
                completedAt: mission.completedAt,
                messageCount: mission.messageCount,
                retryCount: mission.retryCount,
                options: mission.options,
                conversation: mission.conversationHistory
                    .filter(m => m.role !== 'system')
                    .map(m => ({
                        role: m.role,
                        content: m.content,
                    })),
            };

            fs.writeFileSync(filepath, JSON.stringify(logData, null, 2), 'utf-8');
            console.log(`💾 Görev logu kaydedildi: ${filepath}`);
        } catch (error) {
            console.error('⚠️ Log kaydetme hatası:', error.message);
        }
    }

    /**
     * @description Uygulama kapatıldığında (veya her önemli durum değişikliğinde) bellekteki tüm aktif görevleri
     * JSON formatında `data/active_missions.json` dosyasına senkronize eder.
     * Bu işlem "Resilience" (Dayanıklılık) sağlar; sunucu çökerse bile görevler, zamanlayıcılar ve geçmiş korunur.
     * 
     * @private
     */
    _saveState() {
        try {
            const missionsArray = Array.from(this.activeMissions.values());
            // Map'te ayni mission iki kere (targetChatId ve alternativeChatId ile) olabilir.
            // Benzersiz mission'ları filtreleyelim.
            const uniqueMissions = [];
            const seenIds = new Set();
            for (const m of missionsArray) {
                if (!seenIds.has(m.id)) {
                    seenIds.add(m.id);
                    uniqueMissions.push(m);
                }
            }

            fs.writeFileSync(this.tempStateFile, JSON.stringify(uniqueMissions, null, 2), 'utf-8');
            fs.renameSync(this.tempStateFile, this.stateFile); // Atomik
        } catch (error) {
            console.error('⚠️ Kalıcı hafıza kayıt hatası:', error.message);
        }
    }

    /**
     * @description Sunucu ilk başlatıldığında `active_missions.json` dosyasını okuyarak belleği (RAM) yeniden inşa eder (Hydration).
     * **Süre Kontrolü:** Eğer kayıtlı görevlerin zamanlayıcı (followUp) vakti geçmişse veya yaklaşmışsa, 
     * `scheduler` üzerinden ilgili zamanlayıcıları (setTimeout) yeniden kurar.
     * 
     * @example
     * const manager = new MissionManager(client);
     * manager.restoreMissions(); // Uygulama ayağa kalkarken çağrılır.
     */
    restoreMissions() {
        if (!fs.existsSync(this.stateFile)) return;

        try {
            const data = fs.readFileSync(this.stateFile, 'utf-8');
            const missions = JSON.parse(data);

            const now = Date.now();
            let restoredCount = 0;

            for (const mission of missions) {
                // Belleğe yükle
                this.activeMissions.set(mission.targetChatId, mission);
                if (mission.alternativeChatId) {
                    this.activeMissions.set(mission.alternativeChatId, mission);
                }

                // State Machine hydration (Faz 2B)
                if (mission.stateMachine) {
                    mission.stateMachine = MissionStateMachine.fromJSON(mission.stateMachine);
                } else {
                    // Geriye dönük uyumluluk: eski görevlerde SM yoktu
                    mission.stateMachine = new MissionStateMachine(mission.status || 'active');
                }

                // Zamanlayıcıları kontrol et (Time Travel)
                const timers = mission.timers || {};

                // 1. Görev zaman aşımı (Timeout) kontrolü
                if (timers.missionTimeoutAt) {
                    const timeoutDelay = timers.missionTimeoutAt - now;
                    if (timeoutDelay <= 0) {
                        // Çoktan zaman aşımına uğramış
                        this._handleTimeout(mission.id);
                        continue; // Görev kapandığı için takip kurmaya gerek yok
                    } else {
                        timers.missionTimeoutAt = this.scheduler.startTimeout(
                            mission.id,
                            0, // absolute kullanıldığında bu göz ardı edilir
                            (mId) => this._handleTimeout(mId),
                            timers.missionTimeoutAt
                        );
                    }
                }

                // 2. Bireysel takip zamanlayıcıları (Faz 3 uyumlu)
                if (timers.individualFollowUps && Object.keys(timers.individualFollowUps).length > 0) {
                    for (const [timerId, targetTime] of Object.entries(timers.individualFollowUps)) {
                        if (typeof targetTime !== 'number') continue;
                        
                        // timerId formatı: "missionId_KişiAdı" veya "missionId"
                        const parts = timerId.split('_');
                        const target = parts.length > 1 ? parts.slice(1).join('_') : null;
                        
                        timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                            timerId,
                            0,
                            'Bot yeniden başlatıldı, geciken takip.',
                            (tId, reason) => this._handleFollowUp(mission.id, reason, target),
                            targetTime
                        );
                    }
                } else if (timers.nextFollowUpAt) {
                    // Geriye dönük uyumluluk: eski format
                    timers.nextFollowUpAt = this.scheduler.startFollowUpTimeout(
                        mission.id,
                        0,
                        timers.followUpReason || 'Bot yeniden başlatıldı, geciken takip.',
                        (mId, reason) => this._handleFollowUp(mId, reason),
                        timers.nextFollowUpAt
                    );
                } else if (mission.options.retryInterval) {
                    // Periyodik takip varsa ve akıllı takip yoksa, sıfırdan periyodik başlat
                    this.scheduler.startInterval(
                        mission.id,
                        mission.options.retryInterval,
                        (mId) => this._handleFollowUp(mId)
                    );
                }

                restoredCount++;
            }

            console.log(`💾 Kalıcı hafızadan ${restoredCount} görev başarıyla geri yüklendi.`);
        } catch (error) {
            console.error('❌ Kalıcı hafıza geri yükleme hatası:', error.message);
        }
    }
}

module.exports = MissionManager;
