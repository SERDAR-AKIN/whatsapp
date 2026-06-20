// ============================================
// WhatsApp Autonomous Agent System — Gemini Client
// ============================================

const { spawn } = require('child_process');
const CONFIG = require('./config');

class GeminiClient {
    constructor() {
        this.model = CONFIG.gemini ? CONFIG.gemini.model : undefined;
    }

    /**
     * @description Communicates asynchronously and in headless (background) mode with the
     * system-level Gemini CLI tool via Node.js `child_process.spawn`. This allows leveraging
     * the power of Google Gemini without needing a local LLM or an API key.
     *
     * @param {Array<{role: string, content: string}>} messages - Array of messages and system prompt to send.
     * @param {boolean} useJson - Forces the response to be in mandatory JSON format (adds a hidden instruction to the prompt).
     * @returns {Promise<string>} - Standard output (stdout) from the Gemini CLI.
     * @throws {Error} Throws an error if the CLI command fails or cannot be found.
     */
    async chat(messages, useJson = false) {
        // Merge message history into a single prompt
        let promptText = messages.map(m => {
            const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
            return `[${role}]:\n${m.content}`;
        }).join('\n\n');

        if (useJson) {
            promptText += '\n\nIMPORTANT: Please provide your response as ONLY a valid JSON object. Do not use a markdown code block (```json) at the beginning or end — return only the raw JSON text.';
        }

        const args = ['-p', promptText];
        if (this.model) {
            args.push('-m', this.model);
        }

        return new Promise((resolve, reject) => {
            const child = spawn('gemini', args);

            let stdoutData = '';
            let stderrData = '';

            child.stdout.on('data', (data) => {
                stdoutData += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderrData += data.toString();
            });

            child.on('close', (code) => {
                // Throw an error if code is not 0 and stdout is empty
                if (code !== 0 && !stdoutData.trim()) {
                    reject(new Error(`Gemini CLI error (Code: ${code}): ${stderrData}`));
                    return;
                }

                let result = stdoutData.trim();

                // If JSON was requested, strip markdown code blocks
                if (useJson) {
                    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
                    if (jsonMatch) {
                        result = jsonMatch[1].trim();
                    }
                }

                resolve(result);
            });

            child.on('error', (err) => {
                console.error('❌ Gemini CLI could not be started:', err.message);
                reject(err);
            });
        });
    }

    /**
     * Checks whether the Gemini CLI is accessible.
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        return new Promise((resolve) => {
            const child = spawn('gemini', ['-v']);
            child.on('close', (code) => {
                resolve(code === 0);
            });
            child.on('error', () => {
                resolve(false);
            });
        });
    }
}

module.exports = GeminiClient;
