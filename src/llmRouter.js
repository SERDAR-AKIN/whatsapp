// ============================================
// WhatsApp Autonomous Agent System — LLM Router
// ============================================
//
// Manages multiple LLM backends and performs
// automatic routing based on task complexity.
//
// ┌──────────────┐
// │  LLMRouter   │
// │  ┌────────┐  │       ┌──────────────┐
// │  │ route()│──┼──────▶│ GeminiClient │
// │  └────────┘  │       │ (flash/pro)  │
// │  ┌────────┐  │       └──────────────┘
// │  │fallback│──┼──────▶│ OllamaClient │ (optional)
// │  └────────┘  │       └──────────────┘
// └──────────────┘

const GeminiClient = require('./geminiClient');
const CONFIG = require('./config');

class LLMRouter {
    constructor() {
        /** @type {Map<string, GeminiClient>} */
        this.backends = new Map();

        // Default backend (from config)
        this.backends.set('default', new GeminiClient());

        // Statistics
        this.stats = { totalCalls: 0, byBackend: {} };
    }

    /**
     * @description Registers a new LLM backend.
     * @param {string} name - Backend name (e.g., 'fast', 'pro', 'local')
     * @param {Object} client - Client with chat() and healthCheck() methods
     */
    register(name, client) {
        this.backends.set(name, client);
        console.log(`🧠 [LLM Router]: Backend "${name}" registered.`);
    }

    /**
     * @description Routes a message list to the appropriate LLM backend.
     * Different models can be selected based on complexity level.
     *
     * @param {Array<{role: string, content: string}>} messages - Message history
     * @param {boolean} [useJson=false] - Enforce JSON format response
     * @param {Object} [options={}] - Routing options
     * @param {string} [options.backend] - Forced backend name (override)
     * @param {string} [options.complexity] - 'simple' | 'moderate' | 'complex'
     * @returns {Promise<string>} - LLM response
     */
    async chat(messages, useJson = false, options = {}) {
        const backendName = options.backend || this._selectBackend(messages, options);
        const client = this.backends.get(backendName) || this.backends.get('default');

        // Update statistics
        this.stats.totalCalls++;
        this.stats.byBackend[backendName] = (this.stats.byBackend[backendName] || 0) + 1;

        try {
            return await client.chat(messages, useJson);
        } catch (error) {
            // Fall back to default if selected backend fails
            if (backendName !== 'default') {
                console.warn(`⚠️ [LLM Router]: "${backendName}" failed, trying "default"...`);
                return await this.backends.get('default').chat(messages, useJson);
            }
            throw error;
        }
    }

    /**
     * @description Selects a backend based on message complexity.
     * @private
     * @param {Array} messages - Message list
     * @param {Object} options - Options
     * @returns {string} - Backend name
     */
    _selectBackend(messages, options = {}) {
        // If user specified a complexity level
        if (options.complexity === 'complex' && this.backends.has('pro')) {
            return 'pro';
        }
        if (options.complexity === 'simple' && this.backends.has('fast')) {
            return 'fast';
        }

        // Auto-determine: based on message count
        const totalTokenEstimate = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);

        if (totalTokenEstimate > 8000 && this.backends.has('pro')) {
            return 'pro'; // Long context → powerful model
        }

        return 'default';
    }

    /**
     * @description Performs a health check on all backends.
     * @returns {Promise<Object<string, boolean>>}
     */
    async healthCheck() {
        const results = {};
        for (const [name, client] of this.backends.entries()) {
            try {
                results[name] = await client.healthCheck();
            } catch {
                results[name] = false;
            }
        }
        return results;
    }

    /**
     * @description Returns routing statistics.
     * @returns {Object}
     */
    getStats() {
        return { ...this.stats, backendCount: this.backends.size };
    }
}

module.exports = LLMRouter;
