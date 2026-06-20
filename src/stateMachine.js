// ============================================
// WhatsApp Autonomous Agent System — Mission State Machine
// ============================================
//
// Controls the mission lifecycle.
// Prevents invalid state transitions (e.g., completed → active).
//
//                  ┌─────────┐
//                  │ PENDING │
//                  └────┬────┘
//                       │ start
//                  ┌────▼────┐
//            ┌─────│ ACTIVE  │─────┐
//            │     └────┬────┘     │
//     stop/  │  complete│   fail   │ timeout/
//     maxMsg │          │          │ maxRetries
//       ┌────▼───┐ ┌────▼───┐ ┌───▼────┐
//       │STOPPED │ │COMPLETE│ │ FAILED │
//       └────────┘ └────────┘ └────────┘

/**
 * Valid state transitions map.
 * Each key is a state; its value is the set of states it can transition to.
 * @type {Object<string, string[]>}
 */
const TRANSITIONS = {
    pending:   ['active', 'failed'],
    active:    ['completed', 'failed', 'stopped'],
    completed: [], // Terminal state — no way back
    failed:    [], // Terminal state — no way back
    stopped:   [], // Terminal state — no way back
};

/**
 * Terminal states — missions in these states can no longer be processed.
 * @type {string[]}
 */
const TERMINAL_STATES = ['completed', 'failed', 'stopped'];

class MissionStateMachine {
    /**
     * @param {string} [initialState='pending'] - Initial state
     */
    constructor(initialState = 'pending') {
        if (!TRANSITIONS[initialState]) {
            throw new Error(`Invalid initial state: "${initialState}". Valid states: ${Object.keys(TRANSITIONS).join(', ')}`);
        }
        this._state = initialState;
        this._history = [{ state: initialState, at: new Date().toISOString(), reason: 'init' }];
    }

    /**
     * Returns the current state.
     * @returns {string}
     */
    get state() {
        return this._state;
    }

    /**
     * Returns the state transition history.
     * @returns {Array<{state: string, at: string, reason: string}>}
     */
    get history() {
        return this._history;
    }

    /**
     * @description Checks whether the mission's current state is a terminal state.
     * Missions in a terminal state can no longer make any transitions.
     * @returns {boolean}
     */
    get isTerminal() {
        return TERMINAL_STATES.includes(this._state);
    }

    /**
     * @description Checks whether a transition to a specific target state is valid.
     * @param {string} targetState - Target state
     * @returns {boolean}
     */
    canTransition(targetState) {
        const allowed = TRANSITIONS[this._state];
        return allowed ? allowed.includes(targetState) : false;
    }

    /**
     * @description Changes the state. Throws an error on invalid transitions.
     *
     * @param {string} targetState - Target state
     * @param {string} [reason=''] - Reason for the transition (for logging)
     * @returns {string} - New state
     * @throws {Error} When an invalid transition is attempted
     */
    transition(targetState, reason = '') {
        if (!TRANSITIONS[targetState]) {
            throw new Error(`Unknown target state: "${targetState}". Valid states: ${Object.keys(TRANSITIONS).join(', ')}`);
        }

        if (!this.canTransition(targetState)) {
            throw new Error(
                `Invalid state transition: "${this._state}" → "${targetState}". ` +
                `Allowed transitions: [${(TRANSITIONS[this._state] || []).join(', ')}]`
            );
        }

        const from = this._state;
        this._state = targetState;
        this._history.push({
            state: targetState,
            at: new Date().toISOString(),
            reason: reason || `${from} → ${targetState}`,
        });

        return this._state;
    }

    /**
     * @description Serializes the state machine for JSON storage.
     * Can be restored via restoreMissions().
     * @returns {{ state: string, history: Array }}
     */
    toJSON() {
        return {
            state: this._state,
            history: this._history,
        };
    }

    /**
     * @description Creates a state machine from JSON (hydration).
     * @param {Object} json - Output of toJSON()
     * @returns {MissionStateMachine}
     */
    static fromJSON(json) {
        if (!json || !json.state) {
            return new MissionStateMachine('pending');
        }
        const sm = new MissionStateMachine(json.state);
        if (json.history && Array.isArray(json.history)) {
            sm._history = json.history;
        }
        return sm;
    }
}

module.exports = { MissionStateMachine, TRANSITIONS, TERMINAL_STATES };
