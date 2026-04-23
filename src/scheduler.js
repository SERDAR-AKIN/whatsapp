// ============================================
// WhatsApp Otonom Ajan Sistemi — Zamanlayıcı
// ============================================

class Scheduler {
    constructor() {
        // Görev ID → interval ID eşleşmesi
        this.intervals = new Map();
        // Görev ID → timeout ID eşleşmesi (zaman aşımı)
        this.timeouts = new Map();
        // Görev ID → timeout ID eşleşmesi (akıllı takip)
        this.followUpTimeouts = new Map();
        // Görev ID → timeout ID eşleşmesi (grup mesajı throttle)
        this.throttleTimeouts = new Map();
    }

    /**
     * @description Belirli bir görev için periyodik (tekrarlı) takip zamanlayıcısı başlatır.
     * Kullanıcı `!ai görev` başlatırken `--retryInterval` belirtmişse bu metot kullanılır.
     * Eğer önceden var olan bir interval varsa, önce onu temizler (Memory leak önlemi).
     * 
     * @param {string} missionId - Hedef görevin benzersiz ID'si.
     * @param {number} intervalMs - İki tekrar arasındaki bekleme süresi (Milisaniye cinsinden).
     * @param {Function} callback - Süre dolduğunda tetiklenecek fonksiyon.
     */
    startInterval(missionId, intervalMs, callback) {
        // Var olan interval varsa temizle
        this.clearInterval(missionId);

        console.log(`⏰ Zamanlayıcı başlatıldı: ${missionId} — her ${intervalMs / 60000} dakikada bir`);

        const id = setInterval(() => {
            console.log(`⏰ Zamanlayıcı tetiklendi: ${missionId}`);
            callback(missionId);
        }, intervalMs);

        this.intervals.set(missionId, id);
    }

    /**
     * @description Bir görevin maksimum yaşayabileceği (time-to-live) süreyi belirleyen zaman aşımı sayacını başlatır.
     * Görev çok uzun süre havada kalırsa, bu zamanlayıcı devreye girip görevi zorla `failed` durumuna çeker.
     * `absoluteTimestamp` parametresi verilirse (sunucu yeniden başlatıldıktan sonra Hydration için), süreyi anlık olarak 
     * mevcut zamandan çıkararak hesaplar.
     * 
     * @param {string} missionId - Hedef görevin benzersiz ID'si.
     * @param {number} timeoutMs - Zaman aşımı için geçmesi gereken süre (Milisaniye cinsinden).
     * @param {Function} callback - Süre dolduğunda tetiklenecek fonksiyon (Örn: `_handleTimeout`).
     * @param {number} [absoluteTimestamp] - (Opsiyonel) Sistemin yeniden başlatılma durumunda eski hedef zaman (Unix Timestamp).
     * @returns {number} - Tetikleneceği hedeflenen tam zaman (Unix Timestamp).
     */
    startTimeout(missionId, timeoutMs, callback, absoluteTimestamp = null) {
        this.clearTimeout(missionId);

        const now = Date.now();
        const targetTime = absoluteTimestamp ? absoluteTimestamp : now + timeoutMs;
        let delay = targetTime - now;

        if (delay <= 0) delay = 1; // Süre geçmişse anında tetikle

        console.log(`⏳ Zaman aşımı ayarlandı: ${missionId} — ${Math.round(delay / 60000)} dakika`);

        const id = setTimeout(() => {
            console.log(`⏳ Zaman aşımı doldu: ${missionId}`);
            callback(missionId);
        }, delay);

        this.timeouts.set(missionId, id);
        return targetTime;
    }

    /**
     * @description Akıllı (Otonom) takip zamanlayıcısını başlatır. 
     * LLM'in `analyzeForFollowUp` metodundan çıkardığı "Kişi yarın sabah dönecek" (Örn: 800 dakika) bilgisini 
     * alarak gerçek bir Node.js `setTimeout` kurulumu yapar. Süre dolunca bot otonom bir "Hatırlatma" mesajı atar.
     * 
     * @param {string} missionId - Hedef görevin benzersiz ID'si.
     * @param {number} delayMs - LLM'den gelen bekleme süresi (Milisaniye cinsinden).
     * @param {string} reason - Neden takip yapıldığına dair kısa bilgi ("Dosyayı göndermedi").
     * @param {Function} callback - Süre dolduğunda çalışacak geri çağırım fonksiyonu.
     * @param {number} [absoluteTimestamp] - (Opsiyonel) Sistemin yeniden başlatılma durumunda eski hedef zaman (Unix Timestamp).
     * @returns {number} - Tetikleneceği hedeflenen tam zaman (Unix Timestamp).
     */
    startFollowUpTimeout(missionId, delayMs, reason, callback, absoluteTimestamp = null) {
        this.clearFollowUpTimeout(missionId);

        const now = Date.now();
        const targetTime = absoluteTimestamp ? absoluteTimestamp : now + delayMs;
        let delay = targetTime - now;

        if (delay <= 0) delay = 1;

        const delayMin = Math.round(delay / 60000);
        console.log(`🔔 Akıllı takip kuruldu: ${missionId} — ${delayMin} dakika sonra (${reason})`);

        const id = setTimeout(() => {
            console.log(`🔔 Akıllı takip tetiklendi: ${missionId} — ${reason}`);
            this.followUpTimeouts.delete(missionId);
            callback(missionId, reason);
        }, delay);

        this.followUpTimeouts.set(missionId, id);
        return targetTime;
    }

    /**
     * Belirli bir görevin akıllı takip zamanlayıcısını durdurur.
     * @param {string} missionId
     */
    clearFollowUpTimeout(missionId) {
        for (const [key, id] of this.followUpTimeouts.entries()) {
            if (key === missionId || key.startsWith(`${missionId}_`)) {
                clearTimeout(id);
                this.followUpTimeouts.delete(key);
                console.log(`🔔 Akıllı takip iptal edildi: ${key}`);
            }
        }
    }

    /**
     * Grup mesajları için throttle zamanlayıcısı başlatır (tek seferlik).
     * @param {string} missionId - Görev ID
     * @param {number} delayMs - Bekleme süresi (ms)
     * @param {Function} callback - () => void
     */
    startThrottleTimeout(missionId, delayMs, callback) {
        this.clearThrottleTimeout(missionId);

        const id = setTimeout(() => {
            this.throttleTimeouts.delete(missionId);
            callback(missionId);
        }, delayMs);

        this.throttleTimeouts.set(missionId, id);
    }

    /**
     * Belirli bir görevin throttle zamanlayıcısını durdurur.
     * @param {string} missionId
     */
    clearThrottleTimeout(missionId) {
        if (this.throttleTimeouts.has(missionId)) {
            clearTimeout(this.throttleTimeouts.get(missionId));
            this.throttleTimeouts.delete(missionId);
        }
    }

    /**
     * Belirli bir görevin periyodik zamanlayıcısını durdurur.
     * @param {string} missionId
     */
    clearInterval(missionId) {
        if (this.intervals.has(missionId)) {
            clearInterval(this.intervals.get(missionId));
            this.intervals.delete(missionId);
            console.log(`⏰ Zamanlayıcı durduruldu: ${missionId}`);
        }
    }

    /**
     * Belirli bir görevin zaman aşımı zamanlayıcısını durdurur.
     * @param {string} missionId
     */
    clearTimeout(missionId) {
        if (this.timeouts.has(missionId)) {
            clearTimeout(this.timeouts.get(missionId));
            this.timeouts.delete(missionId);
        }
    }

    /**
     * Belirli bir görevin tüm zamanlayıcılarını temizler.
     * @param {string} missionId
     */
    clearAll(missionId) {
        this.clearInterval(missionId);
        this.clearTimeout(missionId);
        this.clearFollowUpTimeout(missionId);
        this.clearThrottleTimeout(missionId);
    }

    /**
     * Tüm görevlerin zamanlayıcılarını temizler.
     */
    clearEverything() {
        for (const [id] of this.intervals) {
            this.clearInterval(id);
        }
        for (const [id] of this.timeouts) {
            this.clearTimeout(id);
        }
        for (const [id] of this.followUpTimeouts) {
            this.clearFollowUpTimeout(id);
        }
        for (const [id] of this.throttleTimeouts) {
            this.clearThrottleTimeout(id);
        }
        console.log('🧹 Tüm zamanlayıcılar temizlendi.');
    }
}

module.exports = Scheduler;
