// ============================================
// WhatsApp Autonomous Agent System — LID Resolver
// ============================================
//
// WhatsApp Business/Linked Device messages arrive
// in @lid format and do not contain a real phone number.
// This module manages the LID → Phone mapping in a
// centralized, cached, and restart-resilient manner.
//
// Architecture:
// ┌─────────────────────────────────────────────┐
// │              LidResolver                     │
// │  ┌─────────┐   ┌──────────┐   ┌──────────┐ │
// │  │RAM Cache│──▶│Puppeteer │──▶│Disk Cache│ │
// │  │  (Map)  │   │ Resolve  │   │  (JSON)  │ │
// │  └─────────┘   └──────────┘   └──────────┘ │
// └─────────────────────────────────────────────┘

const fs = require('fs');
const path = require('path');

class LidResolver {
    /**
     * @param {Object} whatsappClient - whatsapp-web.js Client instance
     */
    constructor(whatsappClient) {
        this.client = whatsappClient;

        /** @type {Map<string, string>} lid → phoneNumber */
        this.cache = new Map();

        // Statistics counters
        this.stats = { hits: 0, misses: 0, puppeteerCalls: 0, errors: 0 };

        // Persistent cache file
        this.dataDir = path.resolve('./data');
        this.cacheFile = path.join(this.dataDir, 'lid_mappings.json');

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * @description Resolves the real phone number for a given chatId if it is a @lid.
     * Checks the RAM cache first, then falls back to Puppeteer. Successful resolutions
     * are written to both RAM and disk.
     *
     * @param {string} chatId - The chatId of the incoming message (e.g., "197646123819107@lid")
     * @returns {Promise<string|null>} - Phone number (e.g., "905xxxxxxxxxx") or null
     */
    async resolve(chatId) {
        // No resolution needed if not a @lid
        if (!chatId || !chatId.endsWith('@lid')) {
            return null;
        }

        // ─────────────────────────────────────────────
        // 1. RAM Cache check (O(1))
        // ─────────────────────────────────────────────
        if (this.cache.has(chatId)) {
            this.stats.hits++;
            const cached = this.cache.get(chatId);
            console.log(`🧠 [LID Cache HIT]: ${chatId} → ${cached}`);
            return cached;
        }

        // ─────────────────────────────────────────────
        // 2. WhatsApp internal API resolution via Puppeteer
        // ─────────────────────────────────────────────
        this.stats.misses++;
        const phoneNumber = await this._puppeteerResolve(chatId);

        if (phoneNumber) {
            // Write to cache (RAM + Disk)
            this.cache.set(chatId, phoneNumber);
            this._saveToDisk();
            console.log(`🧠 [LID Resolved]: ${chatId} → ${phoneNumber} (written to cache)`);
            return phoneNumber;
        }

        console.log(`⚠️ [LID Unresolved]: ${chatId} — No match found via Puppeteer.`);
        return null;
    }

    /**
     * @description Normalizes the given chatId. Converts @lid format to @c.us.
     * Leaves @c.us or @g.us as-is.
     *
     * @param {string} chatId - Raw chatId
     * @returns {Promise<string>} - Normalized chatId (returns original if unresolvable)
     */
    async normalize(chatId) {
        if (!chatId) return chatId;
        if (chatId.endsWith('@c.us') || chatId.endsWith('@g.us')) {
            return chatId;
        }

        const phone = await this.resolve(chatId);
        return phone ? `${phone}@c.us` : chatId;
    }

    /**
     * @description Converts a LID to a real phone number by querying WhatsApp Web's
     * internal APIs via Puppeteer.
     *
     * Two-stage resolution:
     * 1. WAWebApiContact.getPhoneNumber — Lookup from local Wid cache
     * 2. WAWebQueryExistsJob.queryWidExists — Server query (on cache miss)
     *
     * @private
     * @param {string} lidChatId - chatId in @lid format
     * @returns {Promise<string|null>} - Phone number or null
     */
    async _puppeteerResolve(lidChatId) {
        this.stats.puppeteerCalls++;

        // Cannot resolve if Puppeteer page is not ready
        if (!this.client || !this.client.pupPage) {
            console.warn('⚠️ [LID Resolver]: Puppeteer page is not ready yet.');
            return null;
        }

        try {
            const phoneStr = await this.client.pupPage.evaluate(async (lidStr) => {
                try {
                    const wid = window.require('WAWebWidFactory').createWid(lidStr);

                    // Stage 1: Read from local Wid cache
                    let phoneWid = window.require('WAWebApiContact').getPhoneNumber(wid);

                    // Stage 2: Query server if not in local cache
                    if (!phoneWid) {
                        const queryResult = await window.require('WAWebQueryExistsJob').queryWidExists(wid);
                        if (queryResult && queryResult.wid) {
                            phoneWid = window.require('WAWebApiContact').getPhoneNumber(queryResult.wid);
                        }
                    }

                    return phoneWid ? phoneWid._serialized : null;
                } catch (err) {
                    return null;
                }
            }, lidChatId);

            if (phoneStr) {
                // "905xxxxxxxxxx@c.us" → "905xxxxxxxxxx"
                return phoneStr.split('@')[0];
            }

            return null;
        } catch (error) {
            this.stats.errors++;
            console.error(`⚠️ [LID Resolver Error]: ${error.message}`);
            return null;
        }
    }

    /**
     * @description Loads the disk cache into RAM on application startup.
     * This allows previously resolved LIDs to be reused after a restart
     * without querying Puppeteer again.
     */
    loadFromDisk() {
        if (!fs.existsSync(this.cacheFile)) {
            console.log('🧠 [LID Cache]: No disk cache found, starting with empty cache.');
            return;
        }

        try {
            const data = fs.readFileSync(this.cacheFile, 'utf-8');
            const mappings = JSON.parse(data);

            let count = 0;
            for (const [lid, phone] of Object.entries(mappings)) {
                this.cache.set(lid, phone);
                count++;
            }

            console.log(`🧠 [LID Cache]: Loaded ${count} mappings from disk.`);
        } catch (error) {
            console.error('⚠️ [LID Cache]: Could not read disk cache:', error.message);
        }
    }

    /**
     * @description Writes the RAM cache to disk (atomic write).
     * Called on every new resolution.
     * @private
     */
    _saveToDisk() {
        try {
            const mappings = {};
            for (const [lid, phone] of this.cache.entries()) {
                mappings[lid] = phone;
            }

            const tempFile = this.cacheFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(mappings, null, 2), 'utf-8');
            fs.renameSync(tempFile, this.cacheFile); // Atomic write
        } catch (error) {
            console.error('⚠️ [LID Cache]: Could not write to disk:', error.message);
        }
    }

    /**
     * @description Returns cache statistics (for debugging and monitoring).
     * @returns {{ cacheSize: number, hits: number, misses: number, puppeteerCalls: number, errors: number }}
     */
    getStats() {
        return {
            cacheSize: this.cache.size,
            ...this.stats,
        };
    }
}

module.exports = LidResolver;
