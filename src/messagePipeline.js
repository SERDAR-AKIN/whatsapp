// ============================================
// WhatsApp Otonom Ajan Sistemi — Mesaj İşleme Pipeline'ı
// ============================================
//
// Gelen mesajları katmanlı middleware'ler üzerinden işler.
// Her middleware bir async fonksiyon: (context, next) => void
//
// ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐
// │ Contact  │──▶│   LID     │──▶│  Media   │──▶│ Command  │──▶ ...
// │ Resolver │   │ Resolver  │   │ Handler  │   │  Router  │
// └──────────┘   └───────────┘   └──────────┘   └──────────┘

class MessagePipeline {
    constructor() {
        /** @type {Array<{name: string, fn: Function}>} */
        this._middlewares = [];
    }

    /**
     * @description Pipeline'a bir middleware ekler. Middleware'ler ekleme sırasıyla çalışır.
     * 
     * @param {string} name - Middleware'in tanımlayıcı adı (loglama için)
     * @param {Function} fn - async (context, next) => void
     * @returns {MessagePipeline} - Zincirleme çağrı (chaining) desteği
     * 
     * @example
     * pipeline.use('logger', async (ctx, next) => {
     *     console.log(`Mesaj: ${ctx.body}`);
     *     await next();
     * });
     */
    use(name, fn) {
        if (typeof fn !== 'function') {
            throw new Error(`Middleware "${name}" bir fonksiyon olmalıdır.`);
        }
        this._middlewares.push({ name, fn });
        return this; // chaining
    }

    /**
     * @description Bir mesajı tüm middleware zincirinden geçirir.
     * Herhangi bir middleware next() çağırmazsa zincir durur (kısa devre).
     * 
     * @param {Object} context - Mesaj bağlamı (message, body, chatId, vb.)
     * @returns {Promise<Object>} - İşlenmiş context objesi
     */
    async process(context) {
        let index = 0;
        const middlewares = this._middlewares;

        const next = async () => {
            if (index >= middlewares.length) return;

            const current = middlewares[index++];
            try {
                await current.fn(context, next);
            } catch (error) {
                console.error(`❌ [Pipeline] Middleware "${current.name}" hatası:`, error.message);
                // Hata olsa bile zinciri devam ettir (resilience)
                // next() çağrılmazsa zincir doğal olarak durur
            }
        };

        await next();
        return context;
    }

    /**
     * @description Pipeline'daki middleware listesini döndürür.
     * @returns {string[]}
     */
    list() {
        return this._middlewares.map(m => m.name);
    }
}

// ════════════════════════════════════════════════════════
// Hazır Middleware Fabrikaları
// ════════════════════════════════════════════════════════

/**
 * @description Gelen mesajdan contact bilgisi çıkaran middleware.
 * context.contactNumber ve context.senderName alanlarını doldurur.
 */
function createContactResolverMiddleware() {
    return async (ctx, next) => {
        try {
            const contact = await ctx.message.getContact();
            if (contact) {
                if (contact.number) ctx.contactNumber = contact.number;
                ctx.senderName = contact.pushname || contact.name || contact.shortName || contact.number;
            }
        } catch (e) {
            // Hata olursa null kalır
        }
        await next();
    };
}

/**
 * @description LID çözümleme middleware'i. LidResolver kullanarak @lid formatını telefon numarasına çevirir.
 * @param {Object} lidResolver - LidResolver instance'ı
 */
function createLidResolverMiddleware(lidResolver) {
    return async (ctx, next) => {
        if (!ctx.contactNumber && ctx.chatId.endsWith('@lid')) {
            ctx.contactNumber = await lidResolver.resolve(ctx.chatId);
        }
        await next();
    };
}

/**
 * @description Medya işleme middleware'i. Gelen mesajda fotoğraf, dosya veya ses varsa
 * içeriğini indirir ve context'e meta bilgi ekler.
 */
function createMediaHandlerMiddleware() {
    return async (ctx, next) => {
        if (ctx.message.hasMedia) {
            try {
                const media = await ctx.message.downloadMedia();
                if (media) {
                    ctx.media = {
                        mimetype: media.mimetype,
                        filename: media.filename || null,
                        filesize: media.filesize || null,
                        data: media.data, // base64 encoded
                    };

                    // Medya tipine göre açıklama oluştur
                    const typeMap = {
                        'image': '📷 Fotoğraf',
                        'video': '🎥 Video',
                        'audio': '🎵 Ses kaydı',
                        'document': '📄 Dosya',
                        'sticker': '🏷️ Sticker',
                    };

                    const mediaType = media.mimetype?.split('/')[0] || 'unknown';
                    const description = typeMap[mediaType] || `📎 Medya (${media.mimetype})`;
                    const filenameInfo = media.filename ? ` — "${media.filename}"` : '';

                    // Mesaj gövdesine medya etiketi ekle
                    ctx.body = `${ctx.body || ''}\n[MEDYA: ${description}${filenameInfo}]`.trim();
                    ctx.hasMedia = true;

                    console.log(`📎 [Medya Algılandı]: ${description}${filenameInfo} (${ctx.chatId})`);
                }
            } catch (error) {
                console.warn(`⚠️ [Medya İndirme Hatası]: ${error.message}`);
            }
        }
        await next();
    };
}

/**
 * @description Boş mesaj ve hazır olmayan bot kontrolü yapan filtre middleware'i.
 * Geçersiz mesajlarda zinciri durdurur (next çağırmaz).
 * @param {Object} missionManager - MissionManager instance'ı (hazırlık kontrolü için)
 */
function createGuardMiddleware(missionManager) {
    return async (ctx, next) => {
        // Bot hazır değilse atla
        if (!missionManager.myNumber) return;
        // Boş mesajsa atla
        if (!ctx.body || ctx.body.trim() === '') return;

        await next();
    };
}

/**
 * @description Komut yönlendirme middleware'i. !ai, !stop, !durum, !ping gibi
 * bot komutlarını yakalar ve işler. Komut ise zinciri durdurur.
 * @param {Object} deps - { client, missionManager, parseCommand, parseStopCommand, parseUtilityCommand }
 */
function createCommandRouterMiddleware(deps) {
    const { client, missionManager, parseCommand, parseStopCommand, parseUtilityCommand } = deps;

    return async (ctx, next) => {
        // Sadece botun kendi mesajları (komut modu)
        if (!ctx.fromMe) {
            await next();
            return;
        }

        const myChatId = `${missionManager.myNumber}@c.us`;
        if (ctx.chatId !== myChatId) {
            await next();
            return;
        }

        const body = ctx.body;

        // !ai komutu: Yeni görev başlat
        if (body.startsWith('!ai ')) {
            console.log(`\n🎯 Yeni görev komutu alındı: ${body}`);
            const mission = await parseCommand(body, client);
            if (!mission) return;
            if (mission.error) {
                await client.sendMessage(myChatId, mission.error);
                return;
            }
            const statusMsg = await missionManager.startMission(mission);
            await client.sendMessage(myChatId, statusMsg);
            ctx.handled = true;
            return; // Zinciri durdur
        }

        // !stop komutu
        const stopId = parseStopCommand(body);
        if (stopId !== null) {
            const result = missionManager.stopMission(stopId);
            await client.sendMessage(myChatId, result);
            ctx.handled = true;
            return;
        }

        // Yardımcı komutlar (!durum, !liste)
        const utilCmd = parseUtilityCommand(body);
        if (utilCmd === 'status' || utilCmd === 'list') {
            const report = missionManager.getStatusReport();
            await client.sendMessage(myChatId, report);
            ctx.handled = true;
            return;
        }

        // !ping
        if (body.trim().toLowerCase() === '!ping') {
            await ctx.message.reply('pong 🏓');
            ctx.handled = true;
            return;
        }

        // Komut değilse devam et (self-test kontrolü için)
        await next();
    };
}

/**
 * @description Gelen mesajı aktif görevlere yönlendiren middleware.
 * @param {Object} missionManager - MissionManager instance'ı
 */
function createMissionRouterMiddleware(missionManager) {
    return async (ctx, next) => {
        // Self-test durumunda (kendi mesajım ama komut değil)
        const overrideChatId = ctx.fromMe ? `${missionManager.myNumber}@c.us` : null;
        const targetChatId = overrideChatId || ctx.chatId;

        const handled = await missionManager.handleIncomingMessage(
            targetChatId,
            ctx.body,
            ctx.contactNumber,
            ctx.senderName
        );

        if (handled) {
            console.log(`📥 [GÖREV YÖNLENDİRİLDİ] (${targetChatId}): ${ctx.body}`);
            ctx.handled = true;
        }

        await next();
    };
}

/**
 * @description Gelen mesajı loglayan middleware.
 */
function createIncomingLoggerMiddleware() {
    return async (ctx, next) => {
        if (!ctx.fromMe) {
            try {
                const chat = await ctx.message.getChat();
                console.log(`\n📨 Gelen mesaj: ${chat.name} (${ctx.chatId}): ${ctx.body}`);
            } catch {
                console.log(`\n📨 Gelen mesaj: (${ctx.chatId}): ${ctx.body}`);
            }
        }
        await next();
    };
}

module.exports = {
    MessagePipeline,
    createContactResolverMiddleware,
    createLidResolverMiddleware,
    createMediaHandlerMiddleware,
    createGuardMiddleware,
    createCommandRouterMiddleware,
    createMissionRouterMiddleware,
    createIncomingLoggerMiddleware,
};
