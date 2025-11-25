// MUP1 (Microchip UART Protocol 1) Implementation
// Based on velocitydrivesp-support/support/scripts/mup1ct

const MUP1 = {
    // Protocol constants
    SYM_SOF: 0x3e,  // '>'
    SYM_EOF: 0x3c,  // '<'
    SYM_ESC: 0x5c,  // '\'
    SYM_NL: 0x0d,
    SYM_00: 0x30,   // '0'
    SYM_FF: 0x46,   // 'F'

    // Frame types
    TYPE_COAP: 'c'.charCodeAt(0),
    TYPE_COAP_RESP: 'C'.charCodeAt(0),
    TYPE_PING: 'p'.charCodeAt(0),
    TYPE_PONG: 'P'.charCodeAt(0),
    TYPE_SYSREQ: 's'.charCodeAt(0),
    TYPE_TRACE: 'T'.charCodeAt(0),
    TYPE_ANNOUNCE: 'A'.charCodeAt(0),

    // State machine states
    STATE_INIT: 'init',
    STATE_SOF: 'sof',
    STATE_DATA: 'data',
    STATE_ESC: 'esc',
    STATE_EOF2: 'eof2',
    STATE_CHK0: 'chk0',
    STATE_CHK1: 'chk1',
    STATE_CHK2: 'chk2',
    STATE_CHK3: 'chk3',

    // Parser state
    state: 'init',
    frameData: [],
    frameDataChk: [],
    frameChk: [],
    frameType: 0,
    rxQueue: [],

    // Reset parser state
    reset() {
        this.state = this.STATE_INIT;
        this.frameData = [];
        this.frameDataChk = [];
        this.frameChk = [];
        this.frameType = 0;
    },

    // Calculate checksum (16-bit one's complement)
    calculateChecksum(data) {
        let sum = 0;
        // Process as 16-bit words
        for (let i = 0; i < data.length; i += 2) {
            const high = data[i];
            const low = (i + 1 < data.length) ? data[i + 1] : 0;
            sum += (high << 8) | low;
        }
        // Handle odd length by padding last byte
        // Add carry twice
        sum = ((sum >> 16) + (sum & 0xffff));
        sum = ((sum >> 16) + (sum & 0xffff));
        // One's complement
        sum = (~sum) & 0xffff;
        // Convert to 4 hex chars
        return sum.toString(16).padStart(4, '0');
    },

    // Encode a MUP1 frame
    encodeFrame(type, data = []) {
        const dataBytes = (typeof data === 'string') ?
            Array.from(data).map(c => c.charCodeAt(0)) :
            Array.from(data);

        // Build frame for checksum calculation (unescaped)
        const frameForChk = [this.SYM_SOF, type.charCodeAt ? type.charCodeAt(0) : type, ...dataBytes, this.SYM_EOF];
        if (dataBytes.length % 2 === 0) {
            frameForChk.push(this.SYM_EOF);
        }
        const checksum = this.calculateChecksum(frameForChk);

        // Build escaped frame
        const frame = [this.SYM_SOF];
        frame.push(type.charCodeAt ? type.charCodeAt(0) : type);

        // Escape data bytes
        for (const byte of dataBytes) {
            if (byte === this.SYM_SOF || byte === this.SYM_EOF ||
                byte === this.SYM_ESC || byte === 0x00 || byte === 0xff) {
                frame.push(this.SYM_ESC);
                if (byte === 0x00) {
                    frame.push(this.SYM_00);
                } else if (byte === 0xff) {
                    frame.push(this.SYM_FF);
                } else {
                    frame.push(byte);
                }
            } else {
                frame.push(byte);
            }
        }

        // Add EOF(s)
        frame.push(this.SYM_EOF);
        if (dataBytes.length % 2 === 0) {
            frame.push(this.SYM_EOF);
        }

        // Add checksum as ASCII hex
        for (const c of checksum) {
            frame.push(c.charCodeAt(0));
        }

        return new Uint8Array(frame);
    },

    // Process received byte (state machine)
    processByte(c) {
        switch (this.state) {
            case this.STATE_INIT:
                if (c === this.SYM_SOF) {
                    this.state = this.STATE_SOF;
                    this.frameData = [];
                    this.frameDataChk = [this.SYM_SOF];
                    this.frameChk = [];
                    this.frameType = 0;
                }
                break;

            case this.STATE_SOF:
                this.frameType = c;
                this.state = this.STATE_DATA;
                this.frameDataChk.push(c);
                break;

            case this.STATE_DATA:
                if (this.frameData.length > 1024) {
                    console.error('MUP1: Frame too big');
                    this.state = this.STATE_INIT;
                } else {
                    switch (c) {
                        case this.SYM_ESC:
                            this.state = this.STATE_ESC;
                            break;
                        case this.SYM_EOF:
                            this.frameDataChk = this.frameDataChk.concat(this.frameData);
                            this.frameDataChk.push(this.SYM_EOF);
                            if (this.frameData.length % 2 !== 0) {
                                this.state = this.STATE_CHK0;
                            } else {
                                this.state = this.STATE_EOF2;
                                this.frameDataChk.push(this.SYM_EOF);
                            }
                            break;
                        case this.SYM_SOF:
                        case 0x00:
                        case 0xff:
                            console.error(`MUP1: Invalid data element: ${c}`);
                            this.state = this.STATE_INIT;
                            break;
                        default:
                            this.frameData.push(c);
                    }
                }
                break;

            case this.STATE_ESC:
                this.state = this.STATE_DATA;
                switch (c) {
                    case this.SYM_SOF:
                    case this.SYM_ESC:
                    case this.SYM_EOF:
                        this.frameData.push(c);
                        break;
                    case this.SYM_00:
                        this.frameData.push(0x00);
                        break;
                    case this.SYM_FF:
                        this.frameData.push(0xff);
                        break;
                    default:
                        console.error(`MUP1: Invalid escape sequence: ${c}`);
                        this.state = this.STATE_INIT;
                }
                break;

            case this.STATE_EOF2:
                if (c === this.SYM_EOF) {
                    this.state = this.STATE_CHK0;
                } else {
                    console.error(`MUP1: Expected repeated EOF, got ${c}`);
                    this.state = this.STATE_INIT;
                }
                break;

            case this.STATE_CHK0:
                this.frameChk.push(c);
                this.state = this.STATE_CHK1;
                break;

            case this.STATE_CHK1:
                this.frameChk.push(c);
                this.state = this.STATE_CHK2;
                break;

            case this.STATE_CHK2:
                this.frameChk.push(c);
                this.state = this.STATE_CHK3;
                break;

            case this.STATE_CHK3:
                this.frameChk.push(c);
                this.state = this.STATE_INIT;

                const calculatedChk = this.calculateChecksum(this.frameDataChk);
                const receivedChk = String.fromCharCode(...this.frameChk);

                if (calculatedChk !== receivedChk) {
                    console.error(`MUP1: Checksum error! Expected ${calculatedChk}, got ${receivedChk}`);
                    return null;
                }

                const frame = {
                    type: this.frameType,
                    typeChar: String.fromCharCode(this.frameType),
                    data: new Uint8Array(this.frameData)
                };
                this.rxQueue.push(frame);
                return frame;
        }
        return null;
    },

    // Process multiple bytes
    processBytes(bytes) {
        const frames = [];
        for (const byte of bytes) {
            const frame = this.processByte(byte);
            if (frame) {
                frames.push(frame);
            }
        }
        return frames;
    },

    // Get next frame from queue
    getFrame() {
        return this.rxQueue.shift();
    },

    // Clear the receive queue
    clearQueue() {
        this.rxQueue = [];
    },

    // Create ping frame
    createPingFrame() {
        return this.encodeFrame('p');
    },

    // Create system request frame
    createSysReqFrame(command, args = '') {
        const data = [command.charCodeAt(0), ...Array.from(args).map(c => c.charCodeAt(0))];
        return this.encodeFrame('s', data);
    },

    // Create trace request frame
    createTraceFrame(module, level) {
        const args = `${module}:${level}`;
        return this.createSysReqFrame('t', args);
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MUP1;
}
