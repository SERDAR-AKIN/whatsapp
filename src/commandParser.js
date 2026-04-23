// ============================================
// WhatsApp Otonom Ajan Sistemi — Komut Ayrıştırıcı
// ============================================

const CONFIG = require('./config');
const GeminiClient = require('./geminiClient');

const aiClient = new GeminiClient();

/**
 * @description Kullanıcının `!ai` komutunu ayrıştırarak yapılandırılmış bir görev nesnesi (Mission Object) döndürür.
 * Verilen görevi hedef numara veya WhatsApp grubuna göre ayırır. Ardından, LLM'i kullanarak görev metnindeki 
 * örtülü koşulları (`--tone`, `--until` gibi parametreler kullanılmasa bile doğal dilden) çıkarır.
 *
 * @example
 * const mission = await parseCommand("!ai görev: 90555... Ali'den dosyaları iste", client);
 * console.log(mission.targetChatId); // "90555...@c.us"
 * 
 * @param {string} messageBody - Kullanıcının gönderdiği ham WhatsApp mesajı.
 * @param {Object} client - whatsapp-web.js istemci nesnesi (Grupları aramak için gereklidir).
 * @returns {Promise<Object|null>} - Ayrıştırılmış görev objesi (hata varsa `{ error: '...' }` döner, komut değilse `null` döner).
 */
async function parseCommand(messageBody, client) {
    const body = messageBody.trim();

    // !ai komutu ile başlayıp başlamadığını kontrol et
    if (!body.startsWith(CONFIG.commands.ai + ' ')) {
        return null;
    }

    // !ai kısmını çıkar
    const content = body.substring(CONFIG.commands.ai.length + 1).trim();

    // Telefon numarasını veya grup kelimesini ayıkla (ilk kelime)
    const parts = content.split(/\s+/);
    if (parts.length < 2) {
        return { error: '❌ Geçersiz format. Kullanım: !ai <numara_veya_grupKelime> <görev açıklaması>' };
    }

    const firstWord = parts[0];
    let targetChatId = null;
    let targetNumberOrName = firstWord;

    const rawNumber = firstWord.replace(/[^0-9]/g, ''); // Sadece rakamları al
    if (rawNumber.length >= 10 && rawNumber.length <= 15 && rawNumber === firstWord) {
        // Tamamen rakamlardan oluşuyorsa telefon numarasıdır
        targetChatId = `${rawNumber}@c.us`;
        targetNumberOrName = rawNumber;
    } else {
        // Harf/kelime içeriyorsa grup aramasıdır
        if (!client) {
            return { error: '❌ Grup araması yapılamıyor (istemci bağlı değil).' };
        }
        
        try {
            const chats = await client.getChats();
            const groupChats = chats.filter(c => c.isGroup && c.name && c.name.toLowerCase().includes(firstWord.toLowerCase()));

            if (groupChats.length === 0) {
                return { error: `❌ "${firstWord}" kelimesini içeren hiçbir grup bulunamadı.` };
            } else if (groupChats.length > 1) {
                const names = groupChats.map(c => `"${c.name}"`).join(', ');
                return { error: `❌ "${firstWord}" kelimesini içeren birden fazla grup bulundu (${groupChats.length} adet). Lütfen daha spesifik bir kelime girin.\nBulunanlar: ${names}` };
            } else {
                const targetGroup = groupChats[0];
                targetChatId = targetGroup.id._serialized;
                targetNumberOrName = targetGroup.name; // Görünen ad olarak tam grup ismini kullan
            }
        } catch (error) {
             return { error: `⚠️ Grup listesi alınırken hata oluştu: ${error.message}` };
        }
    }

    const taskDescription = parts.slice(1).join(' ');

    // LLM ile görev açıklamasından seçenekleri çıkar
    const options = await extractOptionsWithLLM(taskDescription);

    const mission = {
        id: `m${Date.now()}`,
        targetNumber: targetNumberOrName,
        targetChatId: targetChatId,
        taskDescription: taskDescription,
        status: 'pending',
        createdAt: new Date().toISOString(),
        completedAt: null,
        conversationHistory: [],
        messageCount: 0,
        retryCount: 0,
        options: {
            retryInterval: options.retryInterval || CONFIG.mission.defaultRetryInterval,
            maxRetries: options.maxRetries || CONFIG.mission.defaultMaxRetries,
            maxMessages: CONFIG.mission.defaultMaxMessages,
            timeout: CONFIG.mission.defaultTimeout,
            completionCondition: options.completionCondition || null,
            tone: options.tone || 'nazik ve profesyonel',
        },
    };

    return mission;
}

/**
 * @description Doğal dille yazılmış görev metnini LLM aracılığıyla analiz ederek, opsiyonel parametreleri (tone, completionCondition, retryInterval) çıkarır.
 * 
 * @example
 * // "15 dakikada bir sor, nazik ol" -> { retryInterval: 900000, tone: "nazik" }
 * 
 * @param {string} taskDescription - Kullanıcının "Ali'den dosyaları iste" gibi serbest metinli görev açıklaması.
 * @returns {Promise<Object>} - LLM tarafından çıkarılan opsiyonel değerler (Çıkarılamazsa boş `{}` döner).
 * @private
 */
async function extractOptionsWithLLM(taskDescription) {
    const systemPrompt = `Sen bir görev analiz asistanısın. Verilen görev açıklamasını analiz et ve aşağıdaki JSON formatında döndür. Sadece JSON döndür, başka hiçbir şey yazma.

{
  "retryInterval": null veya milisaniye cinsinden tekrar süresi (örn: 15 dakika = 900000),
  "maxRetries": null veya maksimum tekrar sayısı,
  "completionCondition": "görevin tamamlandığı kabul edilecek koşulun kısa açıklaması" veya null,
  "tone": "konuşma tonu (örn: samimi, profesyonel, sevecen)"
}

Örnekler:
- "15 dakikada bir tekrar sor" → retryInterval: 900000
- "aldım derse görevi kapat" → completionCondition: "Kişi aldığını teyit ettiğinde"
- "nazik bir şekilde hatırlat" → tone: "nazik ve profesyonel"`;

    try {
        const response = await aiClient.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: taskDescription },
        ]);

        // JSON bloğunu cevaptan çıkar
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (error) {
        console.error('⚠️ Görev seçenekleri ayrıştırılamadı, varsayılanlar kullanılacak:', error.message);
    }

    return {};
}

/**
 * @description Kullanıcının çalışan bir görevi manuel olarak iptal etmesini sağlayan `!stop` komutunu ayrıştırır.
 * 
 * @example
 * // "!stop m_12345" -> "m_12345"
 * // "!stop" -> "all"
 * 
 * @param {string} messageBody - Kullanıcının gönderdiği mesaj metni.
 * @returns {string|null} - Durdurulacak görevin spesifik ID'si, tümü için 'all' veya komut değilse null.
 */
function parseStopCommand(messageBody) {
    const body = messageBody.trim();
    if (!body.startsWith(CONFIG.commands.stop)) return null;

    const parts = body.split(/\s+/);
    if (parts.length >= 2) {
        return parts[1]; // Belirli görev ID
    }
    return 'all'; // ID belirtilmediyse tümünü durdur
}

/**
 * @description Sistem durumunu sorgulayan `!status` veya aktif görevleri listeleyen `!list` gibi yardımcı (utility) komutları kontrol eder.
 * 
 * @param {string} messageBody - Kullanıcının gönderdiği mesaj metni.
 * @returns {string|null} - Tanınan bir komutsa adını (örn: 'status', 'list'), değilse null döner.
 */
function parseUtilityCommand(messageBody) {
    const body = messageBody.trim();
    if (body === CONFIG.commands.status) return 'status';
    if (body === CONFIG.commands.list) return 'list';
    return null;
}

module.exports = { parseCommand, parseStopCommand, parseUtilityCommand };
