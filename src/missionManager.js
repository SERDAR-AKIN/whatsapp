// ============================================
// WhatsApp Autonomous Agent System — Mission Manager
// ============================================

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const ConversationEngine = require('./conversationEngine');
const Scheduler = require('./scheduler');
const { MissionStateMachine } = require('./stateMachine');
const CONFIG = require('./config');

class MissionManager extends EventEmitter {
    constructor(whatsappClient) {
        super(); // Initialize EventEmitter
        this.client = whatsappClient;
        this.activeMissions = new Map(); // targetChatId → Mission
        this.conversationEngine = new ConversationEngine();
        this.scheduler = new Scheduler();
        this.myNumber = null; // Bot's own number (set once ready)

        // Create log directory
        if (CONFIG.logging.saveToFile) {
            const logDir = path.resolve(CONFIG.logging.logDir);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
        }

        // Create Persistence directory
        this.dataDir = path.resolve('./data');
        this.stateFile = path.join(this.dataDir, 'active_missions.json');
        this.tempStateFile = path.join(this.dataDir, 'active_missions.tmp');

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Sets the bot's own number.
     * @param {string} number
     */
    setMyNumber(number) {
        this.myNumber = number;
        console.log(`📱 Bot number: ${number}`);
    }

    /**
     * Starts a new mission.
     * @param {Object} mission - Mission object returned from parseCommand
     * @returns {Promise<string>} - Status message to display to the user
     */
    async startMission(mission) {
        // Check if there's already an active mission for this contact
        if (this.activeMissions.has(mission.targetChatId)) {
            const existing = this.activeMissions.get(mission.targetChatId);
            return `⚠️ There is already an active mission for this number (ID: #${existing.id}). Stop it first with !stop ${existing.id}.`;
        }

        try {
            // Save mission as active and initialize timers object
            mission.stateMachine = new MissionStateMachine('pending');
            mission.stateMachine.transition('active', 'Mission started');
            mission.status = mission.stateMachine.state;
            mission.timers = {};
            mission.isGroup = mission.targetChatId.endsWith('@g.us');
            this.activeMissions.set(mission.targetChatId, mission);

            // Generate first message from LLM
            console.log(`🚀 Starting mission: #${mission.id} → ${mission.targetNumber}`);
            const firstMessage = await this.conversationEngine.generateFirstMessage(mission);

            // Send message via WhatsApp
            await this.client.sendMessage(mission.targetChatId, firstMessage);
            console.log(`📤 First message sent: ${firstMessage}`);

            // ─────────────────────────────────────────────
            // Initial Follow-up Timer
            // After the first message, if the other party
            // doesn't respond, a follow-up is scheduled
            // ─────────────────────────────────────────────
            if (mission.options.retryInterval) {
                // Use the periodic interval specified in the command
                this.scheduler.startInterval(
                    mission.id,
                    mission.options.retryInterval,
                    (mId) => this._handleFollowUp(mId)
                );
            } else {
                // Not specified: send first follow-up in 5 minutes
                const initialFollowUpDelay = 5 * 60 * 1000; // 5 minutes
                console.log(`⏰ Initial follow-up scheduled (#${mission.id}): in ${initialFollowUpDelay / 60000} minutes`);
                mission.timers.nextFollowUpAt = this.scheduler.startFollowUpTimeout(
                    mission.id,
                    initialFollowUpDelay,
                    'No reply to first message yet',
                    (mId, reason) => this._handleFollowUp(mId, reason)
                );
                mission.timers.followUpReason = 'No reply to first message yet';
                // Phase 3 compatible: also save to individualFollowUps (for restoreMissions consistency)
                if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};
                mission.timers.individualFollowUps[mission.id] = mission.timers.nextFollowUpAt;
            }

            // Mission timeout timer
            mission.timers.missionTimeoutAt = this.scheduler.startTimeout(
                mission.id,
                mission.options.timeout,
                (mId) => this._handleTimeout(mId)
            );

            // Save to disk
            this._saveState();

            // Emit event (Phase 2C)
            this.emit('mission:started', {
                missionId: mission.id,
                target: mission.targetNumber,
                task: mission.taskDescription,
            });

            // Format options
            const retryInfo = mission.options.retryInterval
                ? `\n🔁 Retry: Every ${mission.options.retryInterval / 60000} minutes`
                : '\n🔁 Follow-up: Reminder in 5 min if no reply';
            const conditionInfo = mission.options.completionCondition
                ? `\n✅ Completion: ${mission.options.completionCondition}`
                : '';

            return `✅ Mission created (ID: #${mission.id})
📱 Target: ${mission.targetNumber}
📋 Task: ${mission.taskDescription.substring(0, 100)}...
⏳ Status: First message sent${retryInfo}${conditionInfo}`;

        } catch (error) {
            mission.status = 'failed';
            this.activeMissions.delete(mission.targetChatId);
            console.error(`❌ Mission start error:`, error);
            return `❌ Mission could not be started: ${error.message}`;
        }
    }

    /**
     * @description Instead of sending incoming WhatsApp messages directly to the LLM,
     * adds them to a pool (queue).
     * **Message Pooling Logic:**
     * Messages sent consecutively by users are accumulated via a 15-second `throttleTimeout`.
     * When this time expires, the entire pool is merged into a single text and sent to the LLM (`_processReply`).
     *
     * **Race Condition Prevention:** The `throttleTimeoutActive` flag definitively prevents
     * multiple overlapping LLM requests from being fired simultaneously.
     *
     * @example
     * // User wrote "Okay", "Tomorrow", "See you" 3 seconds apart.
     * // handleIncomingMessage is called 3 times but a single "Okay\nTomorrow\nSee you" goes to the LLM.
     *
     * @param {string} chatId - The chat ID from which the message came (can be @c.us or @lid)
     * @param {string} messageBody - Message content
     * @param {string} contactNumber - Real phone number (optional, to solve @lid issues)
     * @param {string} senderName - Name of the person speaking in a group
     * @returns {Promise<boolean>} - True if message was routed to a mission
     */
    async handleIncomingMessage(chatId, messageBody, contactNumber = null, senderName = null) {
        let mission = this._findMissionByChatId(chatId);

        // If not found by chatId (e.g., @lid) and phone number is known, try with that
        if (!mission && contactNumber) {
            mission = this._findMissionByChatId(`${contactNumber}@c.us`);
        }

        // ─────────────────────────────────────────────
        // NOTE: The old "Smart Fallback" mechanism has been removed.
        // It used to match a LID to a mission when there was only one active mission.
        // This was fragile (silent failures with 2+ missions).
        // LID resolution is now handled by the centralized LidResolver module.
        // ─────────────────────────────────────────────

        if (!mission) return false; // No active mission for this contact

        // If we encounter a different chatId format for the first time, save it (@lid vs @c.us mapping)
        if (chatId !== mission.targetChatId && !mission.alternativeChatId) {
            mission.alternativeChatId = chatId;
            // Enable quick access via the alternative chatId as well
            this.activeMissions.set(chatId, mission);
            console.log(`🔗 Alternative chatId discovered (#${mission.id}): ${chatId}`);
        }

        let formattedBody = messageBody;
        if (mission.isGroup && senderName) {
            formattedBody = `[${senderName}]: ${messageBody}`;
        }

        console.log(`📥 Message received from target (#${mission.id}): ${formattedBody}`);

        // Maximum message check
        if (mission.messageCount >= mission.options.maxMessages) {
            await this._completeMission(mission, 'failed', 'Maximum message count reached.');
            return;
        }

        // ─────────────────────────────────────────────
        // NOTE: Timer clearing is NO LONGER done here.
        // Follow-up cancellation is now done context-awarely inside _processReply
        // after the LLM response. (Fix for Bug #2)
        // ─────────────────────────────────────────────

        // Add to pool to prevent spam in both DM and Group
        if (!mission.messageQueue) mission.messageQueue = [];
        mission.messageQueue.push(formattedBody);

        if (!mission.timers.throttleTimeoutActive) {
            // ─────────────────────────────────────────────
            // Adaptive Throttle (Fix for Bug #6):
            // 5s for first message (faster response), 15s for subsequent messages
            // ─────────────────────────────────────────────
            const isFirstReply = !mission.firstReplyReceived;
            const throttleMs = isFirstReply ? 5000 : 15000;
            mission.firstReplyReceived = true;

            const chatType = mission.isGroup ? "Group" : "Direct";
            console.log(`⏳ ${chatType} message added to pool (#${mission.id}). Waiting ${throttleMs/1000} seconds...`);

            mission.timers.throttleTimeoutActive = true;
            const replyChatId = mission.targetChatId; // Closure safety: capture fixed chatId
            this.scheduler.startThrottleTimeout(mission.id, throttleMs, async (mId) => {
                // ⚠️ throttleTimeoutActive stays true until processing completes (race condition guard)
                await this._processReply(mId, replyChatId);

                // ─────────────────────────────────────────────
                // Drain Loop (Fix for Bug #3):
                // Intermediate iterations are called with skipFollowUpAnalysis=true.
                // Only the last iteration (when queue empties) runs the full pipeline.
                // ─────────────────────────────────────────────
                const drainMs = 15000;
                while (mission.messageQueue && mission.messageQueue.length > 0 && mission.status === 'active') {
                    console.log(`⏳ ${mission.messageQueue.length} new messages accumulated during processing (#${mission.id}). Waiting ${drainMs/1000}s before processing...`);
                    await new Promise(r => setTimeout(r, drainMs));
                    // Check if there are still messages in the drain step
                    // If this is the last iteration (queue will empty), run full pipeline
                    const willHaveMore = mission.messageQueue && mission.messageQueue.length > 1;
                    await this._processReply(mId, replyChatId, { skipFollowUpAnalysis: willHaveMore });
                }

                mission.timers.throttleTimeoutActive = false; // Release only after entire queue is drained
            });
        } else {
            console.log(`⏳ Message added to pool (#${mission.id}). Total: ${mission.messageQueue.length}`);
        }
        return true;
    }

    /**
     * @description Merges the pending message pool (messageQueue) and forwards it to the LLM
     * via `conversationEngine`.
     * **Error Recovery (Retry):** If the LLM (Gemini/Ollama) doesn't respond, retries up to `maxRetries` (2) times.
     * If all retries fail, puts the messages back at the front of the queue (unshift) to avoid losing them.
     *
     * @private
     * @param {string} missionId - Unique ID of the mission to process.
     * @param {string} chatId - WhatsApp chat ID.
     * @returns {Promise<void>}
     */
    async _processReply(missionId, chatId, options = {}) {
        const { skipFollowUpAnalysis = false } = options;

        const mission = this._findMissionById(missionId);
        if (!mission || mission.status !== 'active') return;

        if (!mission.messageQueue || mission.messageQueue.length === 0) return;
        const combinedMessage = mission.messageQueue.join('\n');
        mission.messageQueue = []; // Clear the queue

        // ─────────────────────────────────────────────
        // LLM Call (With Retry Mechanism)
        // ─────────────────────────────────────────────
        let llmResult = null;
        const maxRetries = 2;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                llmResult = await this.conversationEngine.generateReply(mission, combinedMessage);
                break; // Success, exit loop
            } catch (error) {
                if (attempt < maxRetries) {
                    const waitSec = (attempt + 1) * 5;
                    console.warn(`⚠️ LLM error (#${mission.id}), retrying in ${waitSec}s (attempt ${attempt + 1}/${maxRetries})...`);
                    await new Promise(r => setTimeout(r, waitSec * 1000));
                } else {
                    console.error(`❌ LLM failed after ${maxRetries + 1} attempts (#${mission.id}):`, error.message);
                    // Put messages back in queue (don't lose them)
                    if (!mission.messageQueue) mission.messageQueue = [];
                    mission.messageQueue.unshift(combinedMessage);
                    console.log(`🔄 Messages returned to queue (#${mission.id}). Will retry on next message.`);
                    return;
                }
            }
        }

        const { message, status, memberStatus, relevance } = llmResult;

        // Update and log group member statuses
        if (mission.isGroup && Object.keys(memberStatus || {}).length > 0) {
            mission.memberStatus = { ...(mission.memberStatus || {}), ...memberStatus };
            console.log(`👥 Group Status Matrix (#${mission.id}):`, JSON.stringify(mission.memberStatus));
        }

        // Send reply via WhatsApp (with empty message check)
        if (!message || message.trim() === '') {
            console.warn(`⚠️ LLM produced empty message (#${mission.id}), not sent.`);
            return;
        }
        await this.client.sendMessage(chatId, message);
        console.log(`📤 Agent reply (#${mission.id}): ${message}`);

        // Emit event (Phase 2C)
        this.emit('mission:reply_sent', {
            missionId: mission.id,
            message: message,
            relevance: relevance || 'on_topic',
            target: mission.targetNumber,
        });

        // Check mission status
        if (status === 'completed') {
            await this._completeMission(mission, 'completed');
            return;
        } else if (status === 'failed') {
            await this._completeMission(mission, 'failed');
            return;
        }

        // ─────────────────────────────────────────────
        // Relevance-Aware Timer Strategy
        // (Fixes for Bugs #2, #3, #4, #5)
        // ─────────────────────────────────────────────

        // Don't TOUCH timers on OFF_TOPIC messages (Bug #5)
        // Existing timers are preserved, task topic is not forced.
        if (relevance === 'off_topic') {
            console.log(`💬 Off-topic message detected (#${mission.id}), preserving timers.`);
            this._saveState();
            return;
        }

        // Skip follow-up analysis in drain loop intermediate iterations (Bug #3)
        if (skipFollowUpAnalysis) {
            console.log(`⏩ Drain iteration — skipping follow-up analysis (#${mission.id}).`);
            this._saveState();
            return;
        }

        // ─────────────────────────────────────────────
        // Timer Clearing (Fix for Bug #2):
        // Now done AFTER the LLM response and JUST BEFORE
        // setting a new timer.
        // ─────────────────────────────────────────────
        this.scheduler.clearInterval(mission.id);
        if (!mission.isGroup) {
            this.scheduler.clearFollowUpTimeout(mission.id);
        }

        // ─────────────────────────────────────────────
        // Timer Strategy (Priority Order):
        // ─────────────────────────────────────────────
        try {
            console.log(`🔍 Running follow-up analysis (#${mission.id})...`);
            const followUp = await this.conversationEngine.analyzeForFollowUp(mission);

            if (followUp.needsFollowUp && followUp.followUps && followUp.followUps.length > 0) {
                // ✅ Smart follow-up takes priority
                if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};

                for (let fu of followUp.followUps) {
                    const delayMinutes = Math.round(fu.delayMs / 60000);
                    const targetInfo = mission.isGroup ? ` [${fu.target}]` : '';
                    console.log(`⏰ Smart follow-up scheduled (#${mission.id}${targetInfo}): in ${delayMinutes} minutes — ${fu.reason}`);

                    const myChatId = `${this.myNumber}@c.us`;

                    if (fu.isUnreasonable) {
                        await this.client.sendMessage(myChatId,
                            `⚠️ #${mission.id} → ${mission.targetNumber}${targetInfo}\n` +
                            `🚩 Unreasonable response detected: ${fu.reason}\n` +
                            `🤖 Agent politely objected and redirected to a reasonable timeframe.\n` +
                            `🔁 Follow-up will be sent in ${delayMinutes} minutes.`
                        );
                    }

                    const timerId = mission.isGroup ? `${mission.id}_${fu.target}` : mission.id;

                    mission.timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                        timerId,
                        fu.delayMs,
                        fu.reason,
                        (tId, reason) => this._handleFollowUp(mission.id, reason, fu.target)
                    );
                }
            } else if (mission.options.retryInterval) {
                // ⏰ No smart follow-up needed → periodic
                console.log(`⏰ Periodic follow-up restarted (#${mission.id}): ${mission.options.retryInterval / 60000} min`);
                this.scheduler.startInterval(
                    mission.id,
                    mission.options.retryInterval,
                    (mId) => this._handleFollowUp(mId)
                );
            } else {
                // ⏳ No timers → default fallback
                console.log(`⏳ Default follow-up waiting (#${mission.id}): 30 minutes`);
                const timerId = mission.id;
                if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};
                mission.timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                    timerId,
                    30 * 60 * 1000,
                    'No response from the other party for a long time',
                    (tId, reason) => this._handleFollowUp(mission.id, reason)
                );
            }
        } catch (analyzeError) {
            // If follow-up analysis fails, set default 30-minute follow-up
            console.warn(`⚠️ Follow-up analysis error (#${mission.id}):`, analyzeError.message);
            console.log(`⏳ Default follow-up waiting (#${mission.id}): 30 minutes`);
            const timerId = mission.id;
            if (!mission.timers) mission.timers = {};
            if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};
            mission.timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                timerId,
                30 * 60 * 1000,
                'Follow-up analysis failed, using default wait',
                (tId, reason) => this._handleFollowUp(mission.id, reason)
            );
        }

        this._saveState();
    }

    /**
     * Sends a periodic or smart follow-up message.
     * @param {string} missionId
     * @param {string} [reason] - Reason for follow-up (result of smart follow-up analysis)
     * @param {string} [target] - Person in the group (optional)
     * @private
     */
    async _handleFollowUp(missionId, reason, target = null) {
        const mission = this._findMissionById(missionId);
        if (!mission || mission.status !== 'active') {
            this.scheduler.clearAll(missionId);
            return;
        }

        // Maximum retry check
        if (mission.retryCount >= mission.options.maxRetries) {
            await this._completeMission(mission, 'failed', 'Maximum follow-up count reached, no response received.');
            return;
        }

        try {
            // ─────────────────────────────────────────────
            // LLM Call (With Retry Mechanism)
            // ─────────────────────────────────────────────
            let llmResult = null;
            const maxRetries = 2;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    llmResult = await this.conversationEngine.generateFollowUp(mission, reason);
                    break; // Success, exit loop
                } catch (error) {
                    if (attempt < maxRetries) {
                        const waitSec = (attempt + 1) * 5;
                        console.warn(`⚠️ LLM error (#${mission.id} - Follow-up), retrying in ${waitSec}s (attempt ${attempt + 1}/${maxRetries})...`);
                        await new Promise(r => setTimeout(r, waitSec * 1000));
                    } else {
                        throw error; // If all retries fail, throw to outer catch
                    }
                }
            }

            const { message, status, memberStatus } = llmResult;

            if (mission.isGroup && Object.keys(memberStatus || {}).length > 0) {
                mission.memberStatus = { ...(mission.memberStatus || {}), ...memberStatus };
                console.log(`👥 Group Status Matrix (#${mission.id}):`, JSON.stringify(mission.memberStatus));
            }

            await this.client.sendMessage(mission.targetChatId, message);
            console.log(`📤 Follow-up message (#${mission.id}, attempt ${mission.retryCount}): ${message}`);

            const timerId = target && mission.isGroup ? `${mission.id}_${target}` : mission.id;
            this.scheduler.clearFollowUpTimeout(timerId);

            // If no periodic interval loop, set the next default wait (30 min)
            if (!mission.options.retryInterval) {
                if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};
                mission.timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                    timerId,
                    30 * 60 * 1000, // Default 30 minutes
                    'No response to follow-up message yet',
                    (tId, r) => this._handleFollowUp(mission.id, r, target)
                );
            }

            this._saveState();

            if (status === 'completed') {
                await this._completeMission(mission, 'completed');
            } else if (status === 'failed') {
                await this._completeMission(mission, 'failed');
            }
        } catch (error) {
            console.error(`❌ Follow-up message error (#${mission.id}):`, error.message);
            // On error (e.g., LLM crash), retry in 5 minutes to keep the loop alive
            const timerId = target && mission.isGroup ? `${mission.id}_${target}` : mission.id;
            if (!mission.timers.individualFollowUps) mission.timers.individualFollowUps = {};
            mission.timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                timerId,
                5 * 60 * 1000, // In 5 minutes
                reason || 'Delayed follow-up due to connection error',
                (tId, r) => this._handleFollowUp(mission.id, r, target)
            );
            this._saveState();
        }
    }

    /**
     * Handles the mission timeout.
     * @param {string} missionId
     * @private
     */
    async _handleTimeout(missionId) {
        const mission = this._findMissionById(missionId);
        if (!mission || mission.status !== 'active') return;

        await this._completeMission(mission, 'failed', 'Mission timed out.');
    }

    /**
     * Completes a mission, clears timers, and sends a report.
     * @param {Object} mission
     * @param {string} status - 'completed' | 'failed'
     * @param {string} [reason] - Reason for failure
     * @private
     */
    async _completeMission(mission, status, reason) {
        // Forced state transition via State Machine
        try {
            if (mission.stateMachine && mission.stateMachine.canTransition(status)) {
                mission.stateMachine.transition(status, reason || `Mission ${status}`);
                mission.status = mission.stateMachine.state;
            } else {
                mission.status = status; // Backward compatibility
            }
        } catch (e) {
            console.warn(`⚠️ State transition error (#${mission.id}):`, e.message);
            mission.status = status;
        }
        mission.completedAt = new Date().toISOString();

        // Clear all timers
        this.scheduler.clearAll(mission.id);

        // Remove from active missions
        this.activeMissions.delete(mission.targetChatId);
        if (mission.alternativeChatId) {
            this.activeMissions.delete(mission.alternativeChatId);
        }

        console.log(`${status === 'completed' ? '✅' : '❌'} Mission ended: #${mission.id} — ${status}`);
        if (reason) console.log(`   Reason: ${reason}`);

        // Send report to user
        try {
            let report = await this.conversationEngine.generateReport(mission);
            if (reason) report += `\n📌 Note: ${reason}`;

            const myChatId = `${this.myNumber}@c.us`;
            await this.client.sendMessage(myChatId, report);
        } catch (error) {
            console.error('❌ Could not send report:', error);
        }

        // Save to log file
        this._saveLog(mission);
        this._saveState();

        // Emit event (Phase 2C)
        this.emit('mission:completed', {
            missionId: mission.id,
            status: mission.status,
            reason: reason || null,
            target: mission.targetNumber,
        });
    }

    /**
     * Stops an active mission.
     * @param {string} missionId - Mission ID or 'all'
     * @returns {string} - Status message
     */
    stopMission(missionId) {
        if (missionId === 'all') {
            const count = this.activeMissions.size;
            for (const [, mission] of this.activeMissions) {
                // Transition via State Machine
                try {
                    if (mission.stateMachine && mission.stateMachine.canTransition('stopped')) {
                        mission.stateMachine.transition('stopped', 'Stopped by user');
                        mission.status = mission.stateMachine.state;
                    } else {
                        mission.status = 'stopped';
                    }
                } catch { mission.status = 'stopped'; }
                mission.completedAt = new Date().toISOString();
                this._saveLog(mission);
                this.emit('mission:stopped', { missionId: mission.id, target: mission.targetNumber });
            }
            this.activeMissions.clear();
            this.scheduler.clearEverything();
            this._saveState();
            return `🛑 All missions stopped (${count} missions).`;
        }

        const mission = this._findMissionById(missionId);
        if (!mission) {
            return `⚠️ Mission not found: ${missionId}`;
        }

        // Transition via State Machine
        try {
            if (mission.stateMachine && mission.stateMachine.canTransition('stopped')) {
                mission.stateMachine.transition('stopped', 'Stopped by user');
                mission.status = mission.stateMachine.state;
            } else {
                mission.status = 'stopped';
            }
        } catch { mission.status = 'stopped'; }
        mission.completedAt = new Date().toISOString();
        this.scheduler.clearAll(mission.id);
        this.activeMissions.delete(mission.targetChatId);
        if (mission.alternativeChatId) {
            this.activeMissions.delete(mission.alternativeChatId);
        }
        this._saveLog(mission);
        this._saveState();

        // Emit event (Phase 2C)
        this.emit('mission:stopped', { missionId: mission.id, target: mission.targetNumber });

        return `🛑 Mission stopped: #${mission.id}`;
    }

    /**
     * Returns a list of active missions.
     * @returns {string}
     */
    getStatusReport() {
        if (this.activeMissions.size === 0) {
            return '📋 No active missions.';
        }

        // Deduplication: Same mission may be in the map under both targetChatId and alternativeChatId
        const seen = new Set();
        let count = 0;
        let report = '';
        for (const [, mission] of this.activeMissions) {
            if (seen.has(mission.id)) continue;
            seen.add(mission.id);
            count++;
            const elapsed = this._getElapsedTime(mission.createdAt);
            report += `\n🔹 #${mission.id} → ${mission.targetNumber}`;
            report += `\n   📋 ${mission.taskDescription.substring(0, 60)}...`;
            report += `\n   💬 ${mission.messageCount} messages | ⏱️ ${elapsed}\n`;
        }

        return `📋 Active Missions (${count}):\n${report}`;
    }

    /**
     * Finds a mission by its ID.
     * @param {string} missionId
     * @returns {Object|undefined}
     * @private
     */
    _findMissionById(missionId) {
        for (const [, mission] of this.activeMissions) {
            if (mission.id === missionId) return mission;
        }
        return undefined;
    }

    /**
     * Finds a mission by chat ID or phone number.
     * Since LID resolution is now handled centrally by LidResolver,
     * this method only handles @c.us, @g.us, and alternativeChatId matching.
     *
     * @param {string} chatId - The chatId of the incoming message
     * @returns {Object|undefined}
     * @private
     */
    _findMissionByChatId(chatId) {
        // 1. Exact match check (from activeMissions map — O(1))
        if (this.activeMissions.has(chatId)) {
            return this.activeMissions.get(chatId);
        }

        // 2. Number-based matching: compare the number part of chatId with targetNumber
        //    Works with the contactNumber@c.us format from LidResolver.
        const incomingNumber = chatId.split('@')[0];

        for (const [, mission] of this.activeMissions) {
            // Match via alternativeChatId (backward compatibility)
            if (chatId === mission.alternativeChatId) {
                return mission;
            }
            // Number match: e.g., "905xxxxxxxxxx" === mission.targetNumber
            if (incomingNumber === mission.targetNumber) {
                return mission;
            }
        }

        return undefined;
    }

    /**
     * Returns the elapsed time since a given start ISO string in human-readable format.
     * @private
     */
    _getElapsedTime(startISO) {
        const diffMs = Date.now() - new Date(startISO).getTime();
        const mins = Math.floor(diffMs / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins} min`;
        return `${Math.floor(mins / 60)} hr ${mins % 60} min`;
    }

    /**
     * Saves the mission log to a file.
     * @param {Object} mission
     * @private
     */
    _saveLog(mission) {
        if (!CONFIG.logging.saveToFile) return;

        try {
            const logDir = path.resolve(CONFIG.logging.logDir);
            const filename = `mission_${mission.id}_${mission.status}.json`;
            const filepath = path.join(logDir, filename);

            const logData = {
                id: mission.id,
                targetNumber: mission.targetNumber,
                taskDescription: mission.taskDescription,
                status: mission.status,
                createdAt: mission.createdAt,
                completedAt: mission.completedAt,
                messageCount: mission.messageCount,
                retryCount: mission.retryCount,
                options: mission.options,
                conversation: mission.conversationHistory
                    .filter(m => m.role !== 'system')
                    .map(m => ({
                        role: m.role,
                        content: m.content,
                    })),
            };

            fs.writeFileSync(filepath, JSON.stringify(logData, null, 2), 'utf-8');
            console.log(`💾 Mission log saved: ${filepath}`);
        } catch (error) {
            console.error('⚠️ Log save error:', error.message);
        }
    }

    /**
     * @description Synchronizes all active missions from memory to `data/active_missions.json`
     * in JSON format when the application shuts down (or on every significant state change).
     * This provides "Resilience"; even if the server crashes, missions, timers, and history are preserved.
     *
     * @private
     */
    _saveState() {
        try {
            const missionsArray = Array.from(this.activeMissions.values());
            // The same mission may appear twice in the Map (under targetChatId and alternativeChatId).
            // Filter for unique missions.
            const uniqueMissions = [];
            const seenIds = new Set();
            for (const m of missionsArray) {
                if (!seenIds.has(m.id)) {
                    seenIds.add(m.id);
                    uniqueMissions.push(m);
                }
            }

            fs.writeFileSync(this.tempStateFile, JSON.stringify(uniqueMissions, null, 2), 'utf-8');
            fs.renameSync(this.tempStateFile, this.stateFile); // Atomic
        } catch (error) {
            console.error('⚠️ Persistence save error:', error.message);
        }
    }

    /**
     * @description Rebuilds memory (RAM) by reading the `active_missions.json` file
     * when the server first starts (Hydration).
     * **Time Check:** If the timer (followUp) time for saved missions has passed or is approaching,
     * it re-establishes the relevant timers (setTimeout) in memory via `scheduler`.
     *
     * @example
     * const manager = new MissionManager(client);
     * manager.restoreMissions(); // Called when the application starts up.
     */
    restoreMissions() {
        if (!fs.existsSync(this.stateFile)) return;

        try {
            const data = fs.readFileSync(this.stateFile, 'utf-8');
            const missions = JSON.parse(data);

            const now = Date.now();
            let restoredCount = 0;

            for (const mission of missions) {
                // Load into memory
                this.activeMissions.set(mission.targetChatId, mission);
                if (mission.alternativeChatId) {
                    this.activeMissions.set(mission.alternativeChatId, mission);
                }

                // State Machine hydration (Phase 2B)
                if (mission.stateMachine) {
                    mission.stateMachine = MissionStateMachine.fromJSON(mission.stateMachine);
                } else {
                    // Backward compatibility: old missions didn't have SM
                    mission.stateMachine = new MissionStateMachine(mission.status || 'active');
                }

                // ─────────────────────────────────────────────
                // Reset runtime-only flags:
                // These values are saved to disk but real timers
                // are lost on restart. If not reset, messages
                // fall into a dead queue (throttle timer gone but flag is true).
                // ─────────────────────────────────────────────
                if (!mission.timers) mission.timers = {};
                mission.timers.throttleTimeoutActive = false;
                mission.messageQueue = [];
                mission.firstReplyReceived = false;

                // Check timers (Time Travel)
                const timers = mission.timers;

                // 1. Mission timeout check
                if (timers.missionTimeoutAt) {
                    const timeoutDelay = timers.missionTimeoutAt - now;
                    if (timeoutDelay <= 0) {
                        // Already timed out
                        this._handleTimeout(mission.id);
                        continue; // No need to set follow-up since mission closed
                    } else {
                        timers.missionTimeoutAt = this.scheduler.startTimeout(
                            mission.id,
                            0, // Ignored when absolute is used
                            (mId) => this._handleTimeout(mId),
                            timers.missionTimeoutAt
                        );
                    }
                }

                // 2. Individual follow-up timers (Phase 3 compatible)
                if (timers.individualFollowUps && Object.keys(timers.individualFollowUps).length > 0) {
                    for (const [timerId, targetTime] of Object.entries(timers.individualFollowUps)) {
                        if (typeof targetTime !== 'number') continue;

                        // timerId format: "missionId_PersonName" or "missionId"
                        const parts = timerId.split('_');
                        const target = parts.length > 1 ? parts.slice(1).join('_') : null;

                        timers.individualFollowUps[timerId] = this.scheduler.startFollowUpTimeout(
                            timerId,
                            0,
                            'Bot restarted, delayed follow-up.',
                            (tId, reason) => this._handleFollowUp(mission.id, reason, target),
                            targetTime
                        );
                    }
                } else if (timers.nextFollowUpAt) {
                    // Backward compatibility: old format
                    timers.nextFollowUpAt = this.scheduler.startFollowUpTimeout(
                        mission.id,
                        0,
                        timers.followUpReason || 'Bot restarted, delayed follow-up.',
                        (mId, reason) => this._handleFollowUp(mId, reason),
                        timers.nextFollowUpAt
                    );
                } else if (mission.options.retryInterval) {
                    // If periodic follow-up exists and no smart follow-up, restart periodic from scratch
                    this.scheduler.startInterval(
                        mission.id,
                        mission.options.retryInterval,
                        (mId) => this._handleFollowUp(mId)
                    );
                }

                restoredCount++;
            }

            console.log(`💾 Successfully restored ${restoredCount} missions from persistent storage.`);
        } catch (error) {
            console.error('❌ Persistent storage restore error:', error.message);
        }
    }
}

module.exports = MissionManager;
