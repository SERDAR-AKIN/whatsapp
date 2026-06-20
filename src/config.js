/**
 * @file config.js
 * @description A read-only configuration object containing all core configurations
 * (owner info, default timeout values, command prefixes, etc.) for the application.
 * Other modules in the system read values from the constants defined here.
 */
const CONFIG = {
    // Bot Owner Info
    owner: {
        name: 'Serdar Akın',
        shortName: 'Serdar',  // Short name used in conversations
    },

    // Gemini CLI Settings
    gemini: {
        model: 'gemini-2.5-flash', // Or your preferred model name
    },

    // Mission Default Settings
    mission: {
        defaultTimeout: 24 * 60 * 60 * 1000,    // 24 hours (ms)
        defaultMaxMessages: 20,                  // Maximum message count
        defaultRetryInterval: null,              // Periodic retry (null = none)
        defaultMaxRetries: 10,                   // Maximum retry count
        maxFollowUpDelay: 24 * 60 * 60 * 1000,  // Maximum follow-up wait: 24 hours
    },

    // Control Tags
    tags: {
        completed: '[TASK_COMPLETED]',
        failed: '[TASK_FAILED]',
    },

    // Command Prefixes
    commands: {
        ai: '!ai',
        stop: '!stop',
        status: '!status',
        list: '!list',
    },

    // Logging
    logging: {
        saveToFile: true,
        logDir: './logs',
    },

    // Language
    language: 'en',
};

module.exports = CONFIG;
