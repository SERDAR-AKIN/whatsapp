// ============================================
// WhatsApp Otonom Ajan Sistemi — Görev Durum Makinesi
// ============================================
//
// Görev yaşam döngüsünü kontrol altına alır.
// Geçersiz durum geçişlerini (örn: completed → active) engeller.
//
//                  ┌─────────┐
//                  │ PENDING │
//                  └────┬────┘
//                       │ start
//                  ┌────▼────┐
//            ┌─────│ ACTIVE  │─────┐
//            │     └────┬────┘     │
//     stop/  │  complete│   fail   │ timeout/
//     maxMsg │          │          │ maxRetries
//       ┌────▼───┐ ┌────▼───┐ ┌───▼────┐
//       │STOPPED │ │COMPLETE│ │ FAILED │
//       └────────┘ └────────┘ └────────┘

/**
 * Geçerli durum geçişleri haritası.
 * Her anahtar bir durum, değeri o durumdan geçilebilen durumlar.
 * @type {Object<string, string[]>}
 */
const TRANSITIONS = {
    pending:   ['active', 'failed'],
    active:    ['completed', 'failed', 'stopped'],
    completed: [], // Terminal durum — geri dönüşü yok
    failed:    [], // Terminal durum — geri dönüşü yok
    stopped:   [], // Terminal durum — geri dönüşü yok
};

/**
 * Terminal (son) durumlar — bu durumlardaki görevler artık işlem göremez.
 * @type {string[]}
 */
const TERMINAL_STATES = ['completed', 'failed', 'stopped'];

class MissionStateMachine {
    /**
     * @param {string} [initialState='pending'] - Başlangıç durumu
     */
    constructor(initialState = 'pending') {
        if (!TRANSITIONS[initialState]) {
            throw new Error(`Geçersiz başlangıç durumu: "${initialState}". Geçerli durumlar: ${Object.keys(TRANSITIONS).join(', ')}`);
        }
        this._state = initialState;
        this._history = [{ state: initialState, at: new Date().toISOString(), reason: 'init' }];
    }

    /**
     * Mevcut durumu döndürür.
     * @returns {string}
     */
    get state() {
        return this._state;
    }

    /**
     * Durum geçiş geçmişini döndürür.
     * @returns {Array<{state: string, at: string, reason: string}>}
     */
    get history() {
        return this._history;
    }

    /**
     * @description Görevin mevcut durumunun terminal (son) bir durum olup olmadığını kontrol eder.
     * Terminal durumdaki görevler artık hiçbir geçiş yapamaz.
     * @returns {boolean}
     */
    get isTerminal() {
        return TERMINAL_STATES.includes(this._state);
    }

    /**
     * @description Belirli bir hedefe geçişin geçerli olup olmadığını kontrol eder.
     * @param {string} targetState - Hedef durum
     * @returns {boolean}
     */
    canTransition(targetState) {
        const allowed = TRANSITIONS[this._state];
        return allowed ? allowed.includes(targetState) : false;
    }

    /**
     * @description Durumu değiştirir. Geçersiz geçişlerde hata fırlatır.
     * 
     * @param {string} targetState - Hedef durum
     * @param {string} [reason=''] - Geçiş nedeni (loglama için)
     * @returns {string} - Yeni durum
     * @throws {Error} Geçersiz geçiş denendiğinde
     */
    transition(targetState, reason = '') {
        if (!TRANSITIONS[targetState]) {
            throw new Error(`Bilinmeyen hedef durum: "${targetState}". Geçerli durumlar: ${Object.keys(TRANSITIONS).join(', ')}`);
        }

        if (!this.canTransition(targetState)) {
            throw new Error(
                `Geçersiz durum geçişi: "${this._state}" → "${targetState}". ` +
                `İzin verilen geçişler: [${(TRANSITIONS[this._state] || []).join(', ')}]`
            );
        }

        const from = this._state;
        this._state = targetState;
        this._history.push({
            state: targetState,
            at: new Date().toISOString(),
            reason: reason || `${from} → ${targetState}`,
        });

        return this._state;
    }

    /**
     * @description Durum makinesini JSON serileştirmeye uygun hale getirir.
     * restoreMissions() ile geri yüklenebilir.
     * @returns {{ state: string, history: Array }}
     */
    toJSON() {
        return {
            state: this._state,
            history: this._history,
        };
    }

    /**
     * @description JSON'dan durum makinesi oluşturur (hydration).
     * @param {Object} json - toJSON() çıktısı
     * @returns {MissionStateMachine}
     */
    static fromJSON(json) {
        if (!json || !json.state) {
            return new MissionStateMachine('pending');
        }
        const sm = new MissionStateMachine(json.state);
        if (json.history && Array.isArray(json.history)) {
            sm._history = json.history;
        }
        return sm;
    }
}

module.exports = { MissionStateMachine, TRANSITIONS, TERMINAL_STATES };
