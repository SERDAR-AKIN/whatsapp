// ============================================
// WhatsApp Autonomous Agent System — Scheduler
// ============================================

class Scheduler {
    constructor() {
        // Mission ID → interval ID mapping
        this.intervals = new Map();
        // Mission ID → timeout ID mapping (mission timeout)
        this.timeouts = new Map();
        // Mission ID → timeout ID mapping (smart follow-up)
        this.followUpTimeouts = new Map();
        // Mission ID → timeout ID mapping (group message throttle)
        this.throttleTimeouts = new Map();
    }

    /**
     * @description Starts a periodic (recurring) follow-up timer for a specific mission.
     * Used when the user specifies `--retryInterval` when starting a `!ai task`.
     * If an existing interval is already running, it clears it first (prevents memory leaks).
     *
     * @param {string} missionId - Unique ID of the target mission.
     * @param {number} intervalMs - Wait time between retries (in milliseconds).
     * @param {Function} callback - Function to trigger when the interval fires.
     */
    startInterval(missionId, intervalMs, callback) {
        // Clear existing interval if present
        this.clearInterval(missionId);

        console.log(`⏰ Interval started: ${missionId} — every ${intervalMs / 60000} minutes`);

        const id = setInterval(() => {
            console.log(`⏰ Interval fired: ${missionId}`);
            callback(missionId);
        }, intervalMs);

        this.intervals.set(missionId, id);
    }

    /**
     * @description Starts a time-to-live (TTL) timeout for a mission.
     * If a mission stays active too long, this timer forces it into a `failed` state.
     * If `absoluteTimestamp` is provided (for hydration after server restart), it calculates
     * the remaining delay from the current time.
     *
     * @param {string} missionId - Unique ID of the target mission.
     * @param {number} timeoutMs - Duration to wait before timing out (in milliseconds).
     * @param {Function} callback - Function to trigger when the timeout fires (e.g., `_handleTimeout`).
     * @param {number} [absoluteTimestamp] - (Optional) The original target time (Unix Timestamp) for restarts.
     * @returns {number} - The target Unix Timestamp when the timeout will fire.
     */
    startTimeout(missionId, timeoutMs, callback, absoluteTimestamp = null) {
        this.clearTimeout(missionId);

        const now = Date.now();
        const targetTime = absoluteTimestamp ? absoluteTimestamp : now + timeoutMs;
        let delay = targetTime - now;

        if (delay <= 0) delay = 1; // Fire immediately if time has already passed

        console.log(`⏳ Timeout set: ${missionId} — ${Math.round(delay / 60000)} minutes`);

        const id = setTimeout(() => {
            console.log(`⏳ Timeout expired: ${missionId}`);
            callback(missionId);
        }, delay);

        this.timeouts.set(missionId, id);
        return targetTime;
    }

    /**
     * @description Starts a smart (autonomous) follow-up timer.
     * Takes the "Person will reply tomorrow morning" (e.g., 800 minutes) information extracted
     * by the LLM's `analyzeForFollowUp` method and sets up a real Node.js `setTimeout`.
     * When the time expires, the bot autonomously sends a reminder message.
     *
     * @param {string} missionId - Unique ID of the target mission.
     * @param {number} delayMs - Wait duration from the LLM (in milliseconds).
     * @param {string} reason - Brief info about why the follow-up is needed (e.g., "Did not send the file").
     * @param {Function} callback - Callback function to run when the timer fires.
     * @param {number} [absoluteTimestamp] - (Optional) The original target time (Unix Timestamp) for restarts.
     * @returns {number} - The target Unix Timestamp when the follow-up will fire.
     */
    startFollowUpTimeout(missionId, delayMs, reason, callback, absoluteTimestamp = null) {
        this.clearFollowUpTimeout(missionId);

        const now = Date.now();
        const targetTime = absoluteTimestamp ? absoluteTimestamp : now + delayMs;
        let delay = targetTime - now;

        if (delay <= 0) delay = 1;

        const delayMin = Math.round(delay / 60000);
        console.log(`🔔 Smart follow-up scheduled: ${missionId} — in ${delayMin} minutes (${reason})`);

        const id = setTimeout(() => {
            console.log(`🔔 Smart follow-up fired: ${missionId} — ${reason}`);
            this.followUpTimeouts.delete(missionId);
            callback(missionId, reason);
        }, delay);

        this.followUpTimeouts.set(missionId, id);
        return targetTime;
    }

    /**
     * Stops the smart follow-up timer for a specific mission.
     * @param {string} missionId
     */
    clearFollowUpTimeout(missionId) {
        for (const [key, id] of this.followUpTimeouts.entries()) {
            if (key === missionId || key.startsWith(`${missionId}_`)) {
                clearTimeout(id);
                this.followUpTimeouts.delete(key);
                console.log(`🔔 Smart follow-up cancelled: ${key}`);
            }
        }
    }

    /**
     * Starts a one-shot throttle timer for group messages.
     * @param {string} missionId - Mission ID
     * @param {number} delayMs - Wait duration (ms)
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
     * Stops the throttle timer for a specific mission.
     * @param {string} missionId
     */
    clearThrottleTimeout(missionId) {
        if (this.throttleTimeouts.has(missionId)) {
            clearTimeout(this.throttleTimeouts.get(missionId));
            this.throttleTimeouts.delete(missionId);
        }
    }

    /**
     * Stops the periodic interval timer for a specific mission.
     * @param {string} missionId
     */
    clearInterval(missionId) {
        if (this.intervals.has(missionId)) {
            clearInterval(this.intervals.get(missionId));
            this.intervals.delete(missionId);
            console.log(`⏰ Interval stopped: ${missionId}`);
        }
    }

    /**
     * Stops the timeout timer for a specific mission.
     * @param {string} missionId
     */
    clearTimeout(missionId) {
        if (this.timeouts.has(missionId)) {
            clearTimeout(this.timeouts.get(missionId));
            this.timeouts.delete(missionId);
        }
    }

    /**
     * Clears all timers for a specific mission.
     * @param {string} missionId
     */
    clearAll(missionId) {
        this.clearInterval(missionId);
        this.clearTimeout(missionId);
        this.clearFollowUpTimeout(missionId);
        this.clearThrottleTimeout(missionId);
    }

    /**
     * Clears all timers for all missions.
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
        console.log('🧹 All timers cleared.');
    }
}

module.exports = Scheduler;
