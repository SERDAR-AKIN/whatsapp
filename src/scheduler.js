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
     * Periyodik takip zamanlayıcısı başlatır.
     * @param {string} missionId - Görev ID
     * @param {number} intervalMs - Tekrar aralığı (ms)
     * @param {Function} callback - Her tetiklemede çağrılacak fonksiyon
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
     * Görev zaman aşımı zamanlayıcısı başlatır.
     * @param {string} missionId - Görev ID
     * @param {number} timeoutMs - Zaman aşımı süresi (ms)
     * @param {Function} callback - Zaman aşımında çağrılacak fonksiyon
     * @param {number} [absoluteTimestamp] - (Opsiyonel) Geri yükleme işlemi için tam tetiklenme zamanı
     * @returns {number} Tetikleneceği tam zaman (timestamp)
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
     * Akıllı takip zamanlayıcısı başlatır (tek seferlik).
     * LLM analizi sonucu karşı tarafın belirttiği süre sonunda tetiklenir.
     * @param {string} missionId - Görev ID
     * @param {number} delayMs - Bekleme süresi (ms)
     * @param {string} reason - Takibin nedeni
     * @param {Function} callback - (missionId, reason) => void
     * @param {number} [absoluteTimestamp] - (Opsiyonel) Geri yükleme işlemi için tam tetiklenme zamanı
     * @returns {number} Tetikleneceği tam zaman (timestamp)
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
