// ============================================
// WhatsApp Autonomous Agent System — Message Processing Pipeline
// ============================================
//
// Processes incoming messages through layered middlewares.
// Each middleware is an async function: (context, next) => void
//
// ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐
// │ Contact  │──▶│   LID     │──▶│  Media   │──▶│ Command  │──▶ ...
// │ Resolver │   │ Resolver  │   │ Handler  │   │  Router  │
// └──────────┘   └───────────┘   └──────────┘   └──────────┘

class MessagePipeline {
    constructor() {
        /** @type {Array<{name: string, fn: Function}>} */
        this._middlewares = [];
    }

    /**
     * @description Adds a middleware to the pipeline. Middlewares run in the order they are added.
     *
     * @param {string} name - Identifier name of the middleware (for logging)
     * @param {Function} fn - async (context, next) => void
     * @returns {MessagePipeline} - Supports method chaining
     *
     * @example
     * pipeline.use('logger', async (ctx, next) => {
     *     console.log(`Message: ${ctx.body}`);
     *     await next();
     * });
     */
    use(name, fn) {
        if (typeof fn !== 'function') {
            throw new Error(`Middleware "${name}" must be a function.`);
        }
        this._middlewares.push({ name, fn });
        return this; // chaining
    }

    /**
     * @description Passes a message through the entire middleware chain.
     * If any middleware does not call next(), the chain stops (short-circuit).
     *
     * @param {Object} context - Message context (message, body, chatId, etc.)
     * @returns {Promise<Object>} - Processed context object
     */
    async process(context) {
        let index = 0;
        const middlewares = this._middlewares;

        const next = async () => {
            if (index >= middlewares.length) return;

            const current = middlewares[index++];
            try {
                await current.fn(context, next);
            } catch (error) {
                console.error(`❌ [Pipeline] Middleware "${current.name}" error:`, error.message);
                // Continue the chain even on error (resilience)
                // If next() is not called, the chain naturally stops
            }
        };

        await next();
        return context;
    }

    /**
     * @description Returns the list of middlewares in the pipeline.
     * @returns {string[]}
     */
    list() {
        return this._middlewares.map(m => m.name);
    }
}

// ════════════════════════════════════════════════════════
// Ready-made Middleware Factories
// ════════════════════════════════════════════════════════

/**
 * @description Middleware that extracts contact info from an incoming message.
 * Populates the context.contactNumber and context.senderName fields.
 */
function createContactResolverMiddleware() {
    return async (ctx, next) => {
        try {
            const contact = await ctx.message.getContact();
            if (contact) {
                if (contact.number) ctx.contactNumber = contact.number;
                ctx.senderName = contact.pushname || contact.name || contact.shortName || contact.number;
            }
        } catch (e) {
            // Remains null on error
        }
        await next();
    };
}

/**
 * @description LID resolution middleware. Converts @lid format to a phone number using LidResolver.
 * @param {Object} lidResolver - LidResolver instance
 */
function createLidResolverMiddleware(lidResolver) {
    return async (ctx, next) => {
        if (!ctx.contactNumber && ctx.chatId.endsWith('@lid')) {
            ctx.contactNumber = await lidResolver.resolve(ctx.chatId);
        }
        await next();
    };
}

/**
 * @description Media handling middleware. If the incoming message contains a photo,
 * file, or audio, it downloads the content and adds metadata to the context.
 */
function createMediaHandlerMiddleware() {
    return async (ctx, next) => {
        if (ctx.message.hasMedia) {
            try {
                const media = await ctx.message.downloadMedia();
                if (media) {
                    ctx.media = {
                        mimetype: media.mimetype,
                        filename: media.filename || null,
                        filesize: media.filesize || null,
                        data: media.data, // base64 encoded
                    };

                    // Create a description based on media type
                    const typeMap = {
                        'image': '📷 Photo',
                        'video': '🎥 Video',
                        'audio': '🎵 Audio recording',
                        'document': '📄 Document',
                        'sticker': '🏷️ Sticker',
                    };

                    const mediaType = media.mimetype?.split('/')[0] || 'unknown';
                    const description = typeMap[mediaType] || `📎 Media (${media.mimetype})`;
                    const filenameInfo = media.filename ? ` — "${media.filename}"` : '';

                    // Append media tag to the message body
                    ctx.body = `${ctx.body || ''}\n[MEDIA: ${description}${filenameInfo}]`.trim();
                    ctx.hasMedia = true;

                    console.log(`📎 [Media Detected]: ${description}${filenameInfo} (${ctx.chatId})`);
                }
            } catch (error) {
                console.warn(`⚠️ [Media Download Error]: ${error.message}`);
            }
        }
        await next();
    };
}

/**
 * @description Filter middleware that checks for empty messages and an unready bot.
 * Stops the chain for invalid messages (does not call next).
 * @param {Object} missionManager - MissionManager instance (for readiness check)
 */
function createGuardMiddleware(missionManager) {
    return async (ctx, next) => {
        // Skip if bot is not ready
        if (!missionManager.myNumber) return;
        // Skip if message is empty
        if (!ctx.body || ctx.body.trim() === '') return;

        await next();
    };
}

/**
 * @description Command routing middleware. Captures and handles bot commands
 * like !ai, !stop, !status, !ping. Stops the chain if a command is handled.
 * @param {Object} deps - { client, missionManager, parseCommand, parseStopCommand, parseUtilityCommand }
 */
function createCommandRouterMiddleware(deps) {
    const { client, missionManager, parseCommand, parseStopCommand, parseUtilityCommand } = deps;

    return async (ctx, next) => {
        // Only process the bot's own messages (command mode)
        if (!ctx.fromMe) {
            await next();
            return;
        }

        const myChatId = `${missionManager.myNumber}@c.us`;
        if (ctx.chatId !== myChatId) {
            await next();
            return;
        }

        const body = ctx.body;

        // !ai command: Start a new mission
        if (body.startsWith('!ai ')) {
            console.log(`\n🎯 New mission command received: ${body}`);
            const mission = await parseCommand(body, client);
            if (!mission) return;
            if (mission.error) {
                await client.sendMessage(myChatId, mission.error);
                return;
            }
            const statusMsg = await missionManager.startMission(mission);
            await client.sendMessage(myChatId, statusMsg);
            ctx.handled = true;
            return; // Stop the chain
        }

        // !stop command
        const stopId = parseStopCommand(body);
        if (stopId !== null) {
            const result = missionManager.stopMission(stopId);
            await client.sendMessage(myChatId, result);
            ctx.handled = true;
            return;
        }

        // Utility commands (!status, !list)
        const utilCmd = parseUtilityCommand(body);
        if (utilCmd === 'status' || utilCmd === 'list') {
            const report = missionManager.getStatusReport();
            await client.sendMessage(myChatId, report);
            ctx.handled = true;
            return;
        }

        // !ping
        if (body.trim().toLowerCase() === '!ping') {
            await ctx.message.reply('pong 🏓');
            ctx.handled = true;
            return;
        }

        // Not a command, continue (for self-test check)
        await next();
    };
}

/**
 * @description Middleware that routes incoming messages to active missions.
 * @param {Object} missionManager - MissionManager instance
 */
function createMissionRouterMiddleware(missionManager) {
    return async (ctx, next) => {
        // In self-test mode (my own message but not a command)
        const overrideChatId = ctx.fromMe ? `${missionManager.myNumber}@c.us` : null;
        const targetChatId = overrideChatId || ctx.chatId;

        const handled = await missionManager.handleIncomingMessage(
            targetChatId,
            ctx.body,
            ctx.contactNumber,
            ctx.senderName
        );

        if (handled) {
            console.log(`📥 [MISSION ROUTED] (${targetChatId}): ${ctx.body}`);
            ctx.handled = true;
        }

        await next();
    };
}

/**
 * @description Middleware that logs incoming messages.
 */
function createIncomingLoggerMiddleware() {
    return async (ctx, next) => {
        if (!ctx.fromMe) {
            try {
                const chat = await ctx.message.getChat();
                console.log(`\n📨 Incoming message: ${chat.name} (${ctx.chatId}): ${ctx.body}`);
            } catch {
                console.log(`\n📨 Incoming message: (${ctx.chatId}): ${ctx.body}`);
            }
        }
        await next();
    };
}

module.exports = {
    MessagePipeline,
    createContactResolverMiddleware,
    createLidResolverMiddleware,
    createMediaHandlerMiddleware,
    createGuardMiddleware,
    createCommandRouterMiddleware,
    createMissionRouterMiddleware,
    createIncomingLoggerMiddleware,
};
