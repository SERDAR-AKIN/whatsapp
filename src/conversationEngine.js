// ============================================
// WhatsApp Autonomous Agent System — Conversation Engine
// ============================================

const LLMRouter = require('./llmRouter');
const CONFIG = require('./config');

const aiClient = new LLMRouter();

class ConversationEngine {
    /**
     * @description Creates a 5-layer "System Prompt" that defines the LLM's identity and
     * boundaries for an autonomous mission. This function plays a critical role in preventing
     * LLM hallucinations and guaranteeing JSON output.
     *
     * Architecture consists of the following layers:
     * 1. Identity: The assistant's role and who it represents.
     * 2. Task Context: The `taskDescription` provided by the user.
     * 3. Behavior: Tone (`tone`) and communication rules.
     * 4. Time Awareness: How to interpret `[TIME: ...]` tags in incoming messages.
     * 5. Output Contract: The strict JSON format expected by the system (`reply`, `status`, `memberStatus`).
     *
     * @example
     * const engine = new ConversationEngine();
     * const prompt = engine.buildSystemPrompt(missionObj);
     * // Returns: "# YOUR IDENTITY\nYou are... \n\n# YOUR TASK\n..."
     *
     * @param {Object} mission - The active mission object being worked on.
     * @param {Object} mission.options - Mission options (tone, completionCondition).
     * @param {boolean} mission.isGroup - Whether the conversation is a group chat.
     * @returns {string} - The compiled System Prompt in Markdown format.
     */
    buildSystemPrompt(mission) {
        const completionNote = mission.options.completionCondition
            ? `\n- Special Completion Condition: ${mission.options.completionCondition}`
            : '';

        // ═══════════════════════════════════════════════════
        // LAYER 1: IDENTITY
        // ═══════════════════════════════════════════════════
        const identityLayer = `# YOUR IDENTITY
You are ${CONFIG.owner.name}'s (${CONFIG.owner.shortName}) personal WhatsApp assistant.
- Assigned by: ${CONFIG.owner.shortName}
- Role: Communicate with the other party on behalf of ${CONFIG.owner.shortName}
- Platform: WhatsApp (write short, concise messages; conversational style, not paragraphs)`;

        // ═══════════════════════════════════════════════════
        // LAYER 2: TASK CONTEXT
        // ═══════════════════════════════════════════════════
        const missionLayer = `# YOUR TASK
${mission.taskDescription}`;

        // ═══════════════════════════════════════════════════
        // LAYER 3: BEHAVIOR RULES
        // ═══════════════════════════════════════════════════
        const behaviorLayer = `# BEHAVIOR RULES
- Tone: ${mission.options.tone}
- In your first message, always introduce yourself: "I'm ${CONFIG.owner.shortName}'s assistant, and I've been asked to: ..." format.
- When referring to ${CONFIG.owner.shortName}, ALWAYS use their name. Vague references like "they", "the person" are FORBIDDEN.
- Use emojis naturally and sparingly (not in every message, only where appropriate).
- Avoid repetition. Don't send the same message in different words; try a new angle or approach with each message.

## RELEVANCE DETECTION
- The other party's message may be UNRELATED to the task (greetings, jokes, personal chat, casual messages like "tea is ready").
- In this case:
  → Give a short, natural response (maximum 1 sentence). Do NOT forcibly steer the conversation back to the task.
  → If 2+ consecutive unrelated messages arrive, naturally transition with something like "By the way, is there any update on [task topic]?"
  → For a single unrelated message, just respond naturally without bringing up the task at all.
- WRONG: "Enjoy your meal! 😊 By the way, what's the status on the policy?"
- CORRECT: "Enjoy your meal! 😊" (wait for the next message)
- Mark the relevance field as "off_topic" for messages unrelated to the task.`;

        // ═══════════════════════════════════════════════════
        // LAYER 4: TIME AND LOGIC AWARENESS
        // ═══════════════════════════════════════════════════
        const awarenessLayer = `# TIME AND LOGIC AWARENESS
Each user message starts with a [TIME: DD.MM.YYYY HH:MM:SS] tag. This tells you the real current time.

Time Rules:
- If the other party stated a specific time/date and it has already passed → ask naturally, e.g. "It looks like that time has passed, were you able to take care of it?"
- If they gave relative timeframes like "in 5 minutes", calculate the elapsed time and remind if needed.
- Do not accept a past time as future (e.g., "I'll do it at 17:00" but it's currently 19:00 — acknowledge this).

Logic Rules:
- If unreasonable timeframes (months, years) are given: show empathy + suggest a closer alternative.
- Vague answers ("maybe", "sometime"): ask for a specific date/time.
- Evasive answers: be persistent but respectful, offer solution-oriented alternatives.

⚠️ Do NOT use the [TIME: ...] tag in YOUR OWN messages. This tag is for your information only.`;

        // ═══════════════════════════════════════════════════
        // LAYER 5: OUTPUT CONTRACT
        // ═══════════════════════════════════════════════════
        const outputLayer = `# OUTPUT CONTRACT (MANDATORY)
Return every response in the following JSON structure. Do not add any text, explanation, or markdown block outside the JSON.

\`\`\`
{
  "reply": "<string: message to send to the other party>",
  "status": "<string: active | completed | failed>",
  "relevance": "<string: on_topic | off_topic | partial>",
  "memberStatus": { "<person_name>": "<status_description>" }
}
\`\`\`

Status Rules:
- "active" → Task is still ongoing. The other party made a promise but hasn't done it yet; or the dialogue is continuing.
- "completed" → The other party has DEFINITIVELY confirmed they completed the task (e.g., "done", "sent", shared a receipt). Promises or intentions are NOT "completed".
- "failed" → The other party has DEFINITIVELY refused and is closed to alternatives.

Relevance Rules:
- "on_topic" → Message is directly related to the task (policy, file, business topic, etc.).
- "off_topic" → Message is completely unrelated to the task (greeting, joke, casual chat).
- "partial" → Message is partially related or ambiguous (expressions like "Ready" that could relate to the task).
${completionNote}`;

        // ═══════════════════════════════════════════════════
        // LAYER 5+: GROUP EXTENSION (conditional)
        // ═══════════════════════════════════════════════════
        let groupLayer = '';
        if (mission.isGroup) {
            groupLayer = `\n# GROUP CONVERSATION RULES
This is a group chat, not a one-on-one conversation.
- Messages will arrive in "[PersonName]: message" format. Identify each person by name.
- When replying, address the relevant person by name.
- Track all group members; don't focus on just one person.
- Report each person's status separately in the memberStatus field.`;
        }

        return [identityLayer, missionLayer, behaviorLayer, awarenessLayer, outputLayer, groupLayer]
            .filter(Boolean)
            .join('\n\n');
    }

    /**
     * @description Autonomously generates the first opening message from the LLM when a mission starts.
     * Saves the `buildSystemPrompt` output as `mission.systemPrompt` in memory (and indirectly in JSON).
     * This way, the system prompt is not repeated inside the message pool (conversationHistory) each time.
     * Forces the LLM to write the first response with just the "Start the task." trigger.
     *
     * @throws {Error} May throw an error when the LLM API is unreachable (caught in missionManager).
     *
     * @param {Object} mission - The active mission object being worked on.
     * @returns {Promise<string>} - The first clean message to be sent via WhatsApp to the other party.
     */
    async generateFirstMessage(mission) {
        // Save the system prompt to the mission (will be reused in subsequent calls)
        mission.systemPrompt = this.buildSystemPrompt(mission);

        const response = await aiClient.chat([
            { role: 'system', content: mission.systemPrompt },
            { role: 'user', content: 'Start the task.' },
        ], true);
        const { cleanMessage } = this._processResponse(response);

        // Add only the assistant reply to history (system prompt is stored separately)
        mission.conversationHistory.push(
            { role: 'assistant', content: cleanMessage }
        );
        mission.messageCount++;

        return cleanMessage;
    }

    /**
     * @description Generates a contextual reply to a message received from the other party or group.
     * **Time Awareness:** Secretly injects a `[TIME: DD.MM.YYYY HH:MM:SS]` tag into every incoming
     * message. This allows the LLM to perceive real-world time and autonomously calculate
     * past/future tense time differences.
     *
     * @example
     * const replyData = await engine.generateReply(mission, "Sure, I'll send the file tomorrow");
     * console.log(replyData.status); // "active" (hasn't been sent yet)
     *
     * @param {Object} mission - The active mission object containing past context (`conversationHistory`).
     * @param {string} incomingMessage - The message from the other party (combined from the message pool).
     * @returns {Promise<{message: string, status: string, memberStatus: Object}>} - Resolved LLM reply and mission status decision.
     */
    async generateReply(mission, incomingMessage) {
        // Prepend current time to the message (time awareness)
        const now = new Date();
        const currentTime = now.toLocaleString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeTaggedMessage = `[TIME: ${currentTime}] ${incomingMessage}`;

        // Add incoming message to history
        mission.conversationHistory.push({
            role: 'user',
            content: timeTaggedMessage,
        });

        // ─────────────────────────────────────────────
        // Context Compression (Phase 2D):
        // To avoid exceeding token limits in long conversations,
        // summarize and compress older messages.
        // ─────────────────────────────────────────────
        await this._compressHistoryIfNeeded(mission);

        // Inject system prompt at the start of history before sending
        const fullMessages = [
            { role: 'system', content: mission.systemPrompt },
            ...mission.conversationHistory,
        ];

        const response = await aiClient.chat(fullMessages, true);
        const { cleanMessage, status, memberStatus, relevance } = this._processResponse(response);

        // Add reply to history (as clean text, prevents JSON contamination)
        mission.conversationHistory.push({
            role: 'assistant',
            content: cleanMessage,
        });
        mission.messageCount++;

        return { message: cleanMessage, status, memberStatus, relevance };
    }

    /**
     * @description Analyzes the conversation context to check whether the other party
     * has made a commitment (action promise). If they used expressions like "I'll send it in 10 minutes",
     * "I'll check this evening", it captures this and returns a mathematical wait duration in minutes
     * (`delayMinutes`) for the scheduler.
     *
     * **Edge Case:** The LLM may return an unreasonably long duration (`delayMinutes: 1440` and `isUnreasonable: true`)
     * such as months or years. This is intercepted by `missionManager` and capped at maximum limits (e.g., 2 hours).
     *
     * @param {Object} mission - Active mission object.
     * @returns {Promise<{needsFollowUp: boolean, followUps: Array<{target: string, delayMinutes: number, isUnreasonable: boolean, reason: string}>}>}
     *          - Structured JSON object indicating whether follow-up is needed and for whom, and how long to wait.
     */
    async analyzeForFollowUp(mission) {
        // ─────────────────────────────────────────────
        // Smart Last-Message Check (Fix for Bug #7):
        // If the last message in the conversation came from the bot (bot asked a question),
        // skip follow-up analysis — we should wait for the other party's response.
        // This prevents circular reasoning (bot asked → ambiguity → set follow-up).
        // ─────────────────────────────────────────────
        const lastNonSystemMessage = [...mission.conversationHistory]
            .reverse()
            .find(m => m.role !== 'system' && !m.content.startsWith('[SYSTEM'));

        if (lastNonSystemMessage && lastNonSystemMessage.role === 'assistant') {
            console.log(`🔍 Last message was from bot (#${mission.id}), skipping follow-up analysis — waiting for response.`);
            return { needsFollowUp: false, followUps: [] };
        }

        const isGroup = mission.isGroup || false;
        // Get the last few messages from conversation history
        const recentMessages = mission.conversationHistory
            .filter(m => m.role !== 'system' && !m.content.startsWith('[SYSTEM'))
            .slice(-6) // Take more messages for groups with multiple people
            .map(m => `${m.role === 'assistant' ? 'Me' : 'Other Party'}: ${m.content}`)
            .join('\n');

        const now = new Date();
        const currentTime = now.toLocaleString('en-US', { timeZone: 'UTC' });

        const analysisPrompt = `# TASK
Analyze the following WhatsApp conversation and determine whether the other party has made an action commitment.

# CONTEXT
Task description: ${mission.taskDescription}
Current time: ${currentTime}
Conversation type: ${isGroup ? 'Group chat (messages in [PersonName]: format)' : 'One-on-one chat'}

# RECENT MESSAGES
${recentMessages}

# ANALYSIS INSTRUCTIONS
1. Did the other party make a promise to do something? (e.g., "I will", "I'll send it", "I'll check")
2. Did they specify when? If so, calculate the difference from the current time in minutes.
3. Is the given timeframe reasonable? (Timeframes exceeding 1 week are generally unreasonable)
4. No follow-up is needed if there is a definitive confirmation or refusal.

Time Reference:
| Expression | delayMinutes |
|------------|-------------|
| "right now", "immediately", "in a bit" | 5 |
| "I will", "I'll handle it", "I'll check" (vague) | 15 |
| "in half an hour", "a little later" | 30 |
| "in an hour" | 60 |
| "this evening", "tonight" | minutes until that time |
| "tomorrow" | 720 |
| "this week", "in a few days" | 1440 |
| "in months", "next year" (unreasonable) | 1440, isUnreasonable=true |

# OUTPUT (JSON ONLY)
{
  "needsFollowUp": <boolean>,
  "followUps": [
    {
      "target": "<string: person's name or 'Person'>",
      "delayMinutes": <number: wait time in minutes>,
      "isUnreasonable": <boolean: is the timeframe unreasonable?>,
      "reason": "<string: brief explanation>"
    }
  ]
}${isGroup ? '\n\nGROUP NOTE: Return each person\'s commitment as a separate followUp object.' : ''}`;

        try {
            const response = await aiClient.chat([
                { role: 'system', content: 'You are a scheduling analysis engine. Return only valid JSON, no other text.' },
                { role: 'user', content: analysisPrompt },
            ], true);

            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);

                let followUps = [];
                if (result.needsFollowUp && result.followUps && Array.isArray(result.followUps)) {
                    for (let item of result.followUps) {
                        let delayMs = item.delayMinutes ? item.delayMinutes * 60 * 1000 : 10 * 60 * 1000;
                        const maxDelay = CONFIG.mission.maxFollowUpDelay;
                        if (delayMs > maxDelay) {
                            console.log(`⚠️ Follow-up duration capped (${item.target}): ${item.delayMinutes} min → ${maxDelay / 60000} min`);
                            delayMs = maxDelay;
                        }
                        followUps.push({
                            target: item.target || 'Person',
                            delayMs: delayMs,
                            isUnreasonable: item.isUnreasonable || false,
                            reason: item.reason || 'Follow-up required'
                        });
                    }
                }

                return {
                    needsFollowUp: result.needsFollowUp || false,
                    followUps: followUps,
                };
            }
        } catch (error) {
            console.error('⚠️ Follow-up analysis failed:', error.message);
        }

        return { needsFollowUp: false, followUps: [] };
    }

    /**
     * Generates a follow-up message triggered by the scheduler.
     * @param {Object} mission - Mission object
     * @param {string} [followUpReason] - Reason for the follow-up
     * @returns {Promise<{message: string, status: string}>}
     */
    async generateFollowUp(mission, followUpReason) {
        const reasonNote = followUpReason
            ? `Reason: ${followUpReason}`
            : '';

        // Calculate current time (time awareness)
        const now = new Date();
        const currentTime = now.toLocaleString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });

        // Add follow-up instruction to history
        mission.conversationHistory.push({
            role: 'user',
            content: `[SYSTEM NOTE — TIME: ${currentTime}]
The expected time has passed. ${reasonNote}
Instructions:
- Ask about the status naturally (e.g., "How did it go, were you able to take care of it?").
- If the other party previously gave a specific time and it has passed, politely remind them.
- Use a different approach or angle than your previous messages.
- Maintain the conversational tone, don't be formal or robotic.`,
        });

        // Inject system prompt at the start of history before sending
        const fullMessages = [
            { role: 'system', content: mission.systemPrompt },
            ...mission.conversationHistory,
        ];

        const response = await aiClient.chat(fullMessages, true);
        const { cleanMessage, status, memberStatus } = this._processResponse(response);

        // Add reply to history (as clean text)
        mission.conversationHistory.push({
            role: 'assistant',
            content: cleanMessage,
        });
        mission.messageCount++;
        mission.retryCount++;

        return { message: cleanMessage, status, memberStatus };
    }

    /**
     * Generates a summary report via LLM to be sent to the user when a mission completes.
     * @param {Object} mission - Mission object
     * @returns {Promise<string>} - Summary report
     */
    async generateReport(mission) {
        const statusEmoji = mission.status === 'completed' ? '✅' : '❌';
        const statusText = mission.status === 'completed' ? 'Completed' : 'Failed';

        // Get only assistant and user messages from conversation history (excluding system)
        const chatSummary = mission.conversationHistory
            .filter(m => m.role !== 'system' && !m.content.startsWith('[SYSTEM'))
            .map(m => `${m.role === 'assistant' ? '🤖 Agent' : '👤 Person'}: ${m.content}`)
            .join('\n');

        try {
            const summaryResponse = await aiClient.chat([
                {
                    role: 'system',
                    content: `You are a task reporting assistant. Analyze the following WhatsApp conversation and write a 1-2 sentence summary in English.
The summary should include:
- The outcome of the task (successful or failed)
- The other party's final stance or commitment
- Any important details if present (date, amount, condition, etc.)
Skip unnecessary details, write only the result and conclusion.`,
                },
                { role: 'user', content: chatSummary },
            ]);

            const duration = mission.completedAt
                ? this._calculateDuration(mission.createdAt, mission.completedAt)
                : 'Unknown';

            let memberInfo = '';
            if (mission.isGroup && mission.memberStatus && Object.keys(mission.memberStatus).length > 0) {
                memberInfo = '\n👥 Member Statuses:';
                for (const [name, status] of Object.entries(mission.memberStatus)) {
                    memberInfo += `\n   • ${name}: ${status}`;
                }
            }

            return `${statusEmoji} Mission ${statusText} (ID: #${mission.id})
📱 ${mission.isGroup ? 'Group' : 'Contact'}: ${mission.targetNumber}
📋 Result: ${summaryResponse.trim()}
🔁 Retries: ${mission.retryCount} follow-up messages sent
💬 Messages: ${mission.messageCount} total
⏱️ Duration: ${duration}${memberInfo}`;
        } catch {
            return `${statusEmoji} Mission ${statusText} (ID: #${mission.id})
📱 Contact: ${mission.targetNumber}
💬 Total ${mission.messageCount} messages, ${mission.retryCount} follow-ups`;
        }
    }

    /**
     * @description Cleans the dirty output (containing Markdown blocks and explanations) returned
     * by the LLM and splits it into safe JSON/text parts.
     * This function is the key to the system's resilience.
     *
     * **Processing Steps (3 Steps):**
     * 1. **Parse:** First searches for a `{ ... }` block via regex and tries to parse as JSON.
     * 2. **Fallback:** If JSON is malformed (e.g., missing quotes), tries to rescue just the `"reply": "..."` pattern via regex.
     * 3. **Clean:** Strips stray roles like `[TIME: ...]` or `assistant:` accidentally left by the LLM.
     *
     * @private
     * @param {string} response - Raw text from Gemini CLI or API (usually Markdown + JSON).
     * @returns {{cleanMessage: string, status: string, memberStatus: Object}} - Refined and sanitized structure.
     */
    _processResponse(response) {
        let status = 'active';
        let cleanMessage = response;
        let memberStatus = {};
        let relevance = 'on_topic'; // Default: related to task

        // ── STEP 1: JSON Parsing ──
        try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);

                // Extract reply field (in priority order)
                cleanMessage = parsed.reply ?? parsed.content ?? parsed.message ?? response.replace(/[\{\}\"]/g, '').trim();

                if (parsed.status) status = parsed.status;
                if (parsed.memberStatus) memberStatus = parsed.memberStatus;
                if (parsed.relevance) relevance = parsed.relevance;
            } else {
                // No JSON found → use raw text
                cleanMessage = response.trim();
            }
        } catch (e) {
            // ── STEP 2: Malformed JSON Recovery (Fallback) ──
            console.warn('⚠️ JSON parse error, attempting recovery:', e.message);

            // Extract the "reply": "..." pattern via regex
            const replyMatch = response.match(/"reply"\s*:\s*"([\s\S]*?)("(?=\s*,)|"(?=\s*\})|$)/);
            if (replyMatch?.[1]) {
                cleanMessage = replyMatch[1];
            } else {
                // Last resort: strip JSON structural artifacts
                cleanMessage = response
                    .replace(/[\{\}]/g, '')
                    .replace(/"reply"\s*:\s*/g, '')
                    .replace(/"status"\s*:\s*".*?"/g, '')
                    .replace(/"memberStatus"\s*:\s*.*/g, '')
                    .replace(/^"|"$/g, '')
                    .trim();
            }
        }

        // ── STEP 3: Final Cleanup ──
        // Remove any leaked [TIME: ...] tags
        cleanMessage = cleanMessage.replace(/\[TIME:\s*[\d.:\/ ]+\]/g, '').trim();

        // Strip leading role labels
        cleanMessage = cleanMessage.replace(/^(reply|assistant|response|message|content|bot)\s*:\s*/i, '').trim();

        return { cleanMessage, status, memberStatus, relevance };
    }

    /**
     * @description When the conversation history exceeds a certain threshold, compresses
     * older messages into a summary via LLM. This prevents exceeding token limits while
     * preserving context.
     *
     * How it works:
     * 1. Triggered when history exceeds 16 messages
     * 2. The last 6 messages are preserved (current context)
     * 3. Older messages are summarized into 3-4 sentences via LLM
     * 4. The summary is prepended to history with a [CONTEXT SUMMARY] tag
     *
     * @private
     * @param {Object} mission - Active mission object
     */
    async _compressHistoryIfNeeded(mission) {
        const THRESHOLD = 16;   // Compression threshold
        const KEEP_LAST = 6;    // Number of recent messages to preserve

        const history = mission.conversationHistory;
        if (history.length <= THRESHOLD) return;

        console.log(`📦 Context compression triggered (#${mission.id}): ${history.length} messages → ~${KEEP_LAST + 1} messages.`);

        // Separate old messages to be compressed
        const oldMessages = history.slice(0, -KEEP_LAST);
        const recentMessages = history.slice(-KEEP_LAST);

        // Convert old messages to readable format
        const oldText = oldMessages
            .filter(m => m.role !== 'system' && !m.content.startsWith('[SYSTEM'))
            .map(m => `${m.role === 'assistant' ? 'Agent' : 'Person'}: ${m.content}`)
            .join('\n');

        if (!oldText.trim()) {
            // No meaningful content to compress
            return;
        }

        try {
            const summary = await aiClient.chat([
                {
                    role: 'system',
                    content: `You are a conversation summarization engine. Summarize the following WhatsApp conversation in 3-4 sentences in English.
Preserve in the summary:
- Who promised what (including dates/times)
- The other party's last stance
- Important task-related information (names, amounts, conditions, etc.)
- Any unresolved issues
Skip unnecessary greetings and repetitions. Return only the summary text, nothing else.`,
                },
                { role: 'user', content: oldText },
            ]);

            // Replace history with compressed version
            mission.conversationHistory = [
                { role: 'user', content: `[CONTEXT SUMMARY — Previous ${oldMessages.length} messages]\n${summary.trim()}` },
                ...recentMessages,
            ];

            console.log(`📦 Context compressed (#${mission.id}): ${history.length} → ${mission.conversationHistory.length} messages`);
        } catch (error) {
            console.warn(`⚠️ Context compression error (#${mission.id}):`, error.message);
            // Preserve original history on error
        }
    }

    /**
     * Returns the duration between two dates in a human-readable format.
     * @private
     */
    _calculateDuration(startISO, endISO) {
        const diffMs = new Date(endISO) - new Date(startISO);
        const minutes = Math.floor(diffMs / 60000);
        const seconds = Math.floor((diffMs % 60000) / 1000);

        if (minutes < 1) return `${seconds} seconds`;
        if (minutes < 60) return `${minutes} minutes`;
        const hours = Math.floor(minutes / 60);
        const remainMins = minutes % 60;
        return `${hours} hours ${remainMins} minutes`;
    }
}

module.exports = ConversationEngine;
