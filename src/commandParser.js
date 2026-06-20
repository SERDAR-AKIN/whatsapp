// ============================================
// WhatsApp Autonomous Agent System — Command Parser
// ============================================

const CONFIG = require('./config');
const GeminiClient = require('./geminiClient');

const aiClient = new GeminiClient();

/**
 * @description Parses the user's `!ai` command and returns a structured mission object.
 * Separates the given task by target number or WhatsApp group. Then, uses the LLM
 * to extract implicit conditions from the task text (e.g., `--tone`, `--until` parameters,
 * even when expressed in natural language).
 *
 * @example
 * const mission = await parseCommand("!ai task: 90555... Ask Ali for the files", client);
 * console.log(mission.targetChatId); // "90555...@c.us"
 *
 * @param {string} messageBody - The raw WhatsApp message sent by the user.
 * @param {Object} client - The whatsapp-web.js client instance (required to search groups).
 * @returns {Promise<Object|null>} - Parsed mission object (returns `{ error: '...' }` on error, `null` if not a command).
 */
async function parseCommand(messageBody, client) {
    const body = messageBody.trim();

    // Check if the message starts with the !ai command
    if (!body.startsWith(CONFIG.commands.ai + ' ')) {
        return null;
    }

    // Strip the !ai prefix
    const content = body.substring(CONFIG.commands.ai.length + 1).trim();

    // Extract the phone number or group keyword (first word)
    const parts = content.split(/\s+/);
    if (parts.length < 2) {
        return { error: '❌ Invalid format. Usage: !ai <number_or_groupKeyword> <task description>' };
    }

    const firstWord = parts[0];
    let targetChatId = null;
    let targetNumberOrName = firstWord;

    const rawNumber = firstWord.replace(/[^0-9]/g, ''); // Extract digits only
    if (rawNumber.length >= 10 && rawNumber.length <= 15 && rawNumber === firstWord) {
        // Consists entirely of digits → it's a phone number
        targetChatId = `${rawNumber}@c.us`;
        targetNumberOrName = rawNumber;
    } else {
        // Contains letters/words → group search
        if (!client) {
            return { error: '❌ Group search unavailable (client not connected).' };
        }

        try {
            const chats = await client.getChats();
            const groupChats = chats.filter(c => c.isGroup && c.name && c.name.toLowerCase().includes(firstWord.toLowerCase()));

            if (groupChats.length === 0) {
                return { error: `❌ No group found containing the keyword "${firstWord}".` };
            } else if (groupChats.length > 1) {
                const names = groupChats.map(c => `"${c.name}"`).join(', ');
                return { error: `❌ Multiple groups found containing "${firstWord}" (${groupChats.length} total). Please use a more specific keyword.\nFound: ${names}` };
            } else {
                const targetGroup = groupChats[0];
                targetChatId = targetGroup.id._serialized;
                targetNumberOrName = targetGroup.name; // Use the full group name as display name
            }
        } catch (error) {
             return { error: `⚠️ Error retrieving group list: ${error.message}` };
        }
    }

    const taskDescription = parts.slice(1).join(' ');

    // Extract options from task description using LLM
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
            tone: options.tone || 'polite and professional',
        },
    };

    return mission;
}

/**
 * @description Analyzes a naturally written task description via LLM to extract
 * optional parameters (tone, completionCondition, retryInterval).
 *
 * @example
 * // "ask every 15 minutes, be polite" -> { retryInterval: 900000, tone: "polite" }
 *
 * @param {string} taskDescription - The user's free-text task description (e.g., "Ask Ali for the files").
 * @returns {Promise<Object>} - Optional values extracted by LLM (returns empty `{}` if extraction fails).
 * @private
 */
async function extractOptionsWithLLM(taskDescription) {
    const systemPrompt = `You are a task analysis assistant. Analyze the given task description and return it in the following JSON format. Return ONLY the JSON, nothing else.

{
  "retryInterval": null or retry duration in milliseconds (e.g., 15 minutes = 900000),
  "maxRetries": null or maximum number of retries,
  "completionCondition": "short description of the condition under which the task is considered complete" or null,
  "tone": "conversation tone (e.g., friendly, professional, warm)"
}

Examples:
- "ask again every 15 minutes" → retryInterval: 900000
- "close the task when they confirm receipt" → completionCondition: "When the person confirms receipt"
- "remind politely" → tone: "polite and professional"`;

    try {
        const response = await aiClient.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: taskDescription },
        ]);

        // Extract JSON block from the response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (error) {
        console.error('⚠️ Could not parse task options, using defaults:', error.message);
    }

    return {};
}

/**
 * @description Parses the `!stop` command that allows the user to manually cancel a running mission.
 *
 * @example
 * // "!stop m_12345" -> "m_12345"
 * // "!stop" -> "all"
 *
 * @param {string} messageBody - The message text sent by the user.
 * @returns {string|null} - The specific ID of the mission to stop, 'all' for all, or null if not a command.
 */
function parseStopCommand(messageBody) {
    const body = messageBody.trim();
    if (!body.startsWith(CONFIG.commands.stop)) return null;

    const parts = body.split(/\s+/);
    if (parts.length >= 2) {
        return parts[1]; // Specific mission ID
    }
    return 'all'; // Stop all if no ID specified
}

/**
 * @description Checks for utility commands such as `!status` (query system status)
 * or `!list` (list active missions).
 *
 * @param {string} messageBody - The message text sent by the user.
 * @returns {string|null} - The name of the recognized command (e.g., 'status', 'list'), or null.
 */
function parseUtilityCommand(messageBody) {
    const body = messageBody.trim();
    if (body === CONFIG.commands.status) return 'status';
    if (body === CONFIG.commands.list) return 'list';
    return null;
}

module.exports = { parseCommand, parseStopCommand, parseUtilityCommand };
