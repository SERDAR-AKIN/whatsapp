const activeMissions = new Map();
activeMissions.set('905348159035@c.us', { targetNumber: '905348159035', targetChatId: '905348159035@c.us' });

function _findMissionByChatId(chatId) {
    if (activeMissions.has(chatId)) {
        return activeMissions.get(chatId);
    }
    const incomingNumber = chatId.split('@')[0];
    for (const [, mission] of activeMissions) {
        if (chatId === mission.targetChatId || chatId === mission.alternativeChatId) {
            return mission;
        }
        if (incomingNumber === mission.targetNumber) {
            return mission;
        }
        // What if incomingNumber is a substring?
        if (mission.targetNumber.endsWith(incomingNumber) || incomingNumber.endsWith(mission.targetNumber)) {
            return mission;
        }
    }
    return undefined;
}

console.log(_findMissionByChatId('905348159035@c.us'));
console.log(_findMissionByChatId('5348159035@c.us'));
console.log(_findMissionByChatId('197646123819107@lid'));
