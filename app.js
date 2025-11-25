// VelocityDRIVE-SP Web Serial Application

class VelocityDriveApp {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.readLoopRunning = false;
        this.currentRequest = null;
        this.responseBuffer = [];
        this.responseTimeout = null;
        this.pendingCoAPFrame = null;
        this.block2Num = 0;

        this.setupEventListeners();
    }

    setupEventListeners() {
        document.getElementById('connectBtn').addEventListener('click', () => this.connect());
        document.getElementById('disconnectBtn').addEventListener('click', () => this.disconnect());
    }

    async connect() {
        try {
            // Request port with filters for common USB serial devices
            this.port = await navigator.serial.requestPort({
                filters: [
                    { usbVendorId: 0x0403 }, // FTDI
                    { usbVendorId: 0x10C4 }, // Silicon Labs
                    { usbVendorId: 0x1A86 }, // QinHeng Electronics (CH340)
                    { usbVendorId: 0x067B }, // Prolific
                    { usbVendorId: 0x239A }, // Adafruit
                    { usbVendorId: 0x2341 }, // Arduino
                    { usbVendorId: 0x16C0 }, // Teensy
                ]
            });

            await this.port.open({
                baudRate: 115200,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                flowControl: 'none'
            });

            this.writer = this.port.writable.getWriter();
            this.startReadLoop();
            this.updateConnectionStatus(true);

            // Get port info if available
            const info = this.port.getInfo();
            if (info.usbVendorId) {
                document.getElementById('deviceInfo').textContent =
                    `VID: ${info.usbVendorId.toString(16).toUpperCase()}, PID: ${info.usbProductId?.toString(16).toUpperCase() || 'N/A'}`;
            }

            this.log('Connected to serial port', 'info');
            MUP1.reset();

        } catch (error) {
            this.log(`Connection failed: ${error.message}`, 'error');
            console.error('Connection error:', error);
        }
    }

    async disconnect() {
        try {
            this.readLoopRunning = false;

            if (this.reader) {
                await this.reader.cancel();
                this.reader.releaseLock();
                this.reader = null;
            }

            if (this.writer) {
                this.writer.releaseLock();
                this.writer = null;
            }

            if (this.port) {
                await this.port.close();
                this.port = null;
            }

            this.updateConnectionStatus(false);
            this.log('Disconnected', 'info');

        } catch (error) {
            this.log(`Disconnect error: ${error.message}`, 'error');
        }
    }

    async startReadLoop() {
        this.readLoopRunning = true;
        const reader = this.port.readable.getReader();
        this.reader = reader;

        try {
            while (this.readLoopRunning) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                if (value) {
                    this.processReceivedData(value);
                }
            }
        } catch (error) {
            if (this.readLoopRunning) {
                this.log(`Read error: ${error.message}`, 'error');
            }
        } finally {
            reader.releaseLock();
        }
    }

    processReceivedData(data) {
        // Log raw received data
        const hexStr = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
        this.log(`RX: ${hexStr}`, 'rx');

        // Process through MUP1 state machine
        const frames = MUP1.processBytes(data);

        for (const frame of frames) {
            this.handleMUP1Frame(frame);
        }
    }

    handleMUP1Frame(frame) {
        this.log(`MUP1 Frame Type: ${frame.typeChar}`, 'info');

        switch (frame.typeChar) {
            case 'P': // Pong response
                this.handlePongResponse(frame.data);
                break;
            case 'C': // CoAP response
                this.handleCoAPResponse(frame.data);
                break;
            case 'T': // Trace
                const traceText = new TextDecoder().decode(frame.data);
                this.log(`TRACE: ${traceText}`, 'trace');
                break;
            case 'A': // Announce
                const announceText = new TextDecoder().decode(frame.data);
                this.log(`ANNOUNCE: ${announceText}`, 'info');
                break;
            default:
                this.log(`Unknown frame type: ${frame.typeChar}`, 'error');
        }
    }

    handlePongResponse(data) {
        const text = new TextDecoder().decode(data);
        const parts = text.split(' ');
        let response = 'Pong received!\n';
        if (parts[0]) response += `Build: ${parts[0]}\n`;
        if (parts[1]) response += `Uptime: ${parts[1]}\n`;
        if (parts[2]) response += `Data size: ${parts[2]}\n`;
        if (parts[3]) response += `Version: ${parts[3]}\n`;

        this.showResponse(response, 'text');
        this.log('Pong received', 'info');
    }

    handleCoAPResponse(data) {
        try {
            const coap = CoAP.parseFrame(data);
            this.log(`CoAP Response: ${coap.codeStr} (${coap.codeClass}.${coap.codeDetail.toString().padStart(2, '0')})`, 'info');

            // Check for errors
            if (coap.codeClass === 4 || coap.codeClass === 5) {
                this.showResponse(`Error: ${coap.codeStr}`, 'error');
                this.clearPendingRequest();
                return;
            }

            // Accumulate payload for block-wise transfer
            if (coap.payload && coap.payload.length > 0) {
                this.responseBuffer.push(...coap.payload);
            }

            // Check if more blocks are available
            if (coap.options.block2 && coap.options.block2.more) {
                this.log(`Block2: num=${coap.options.block2.num}, more=${coap.options.block2.more}`, 'info');
                this.requestNextBlock(coap);
                return;
            }

            // Response complete
            if (this.responseBuffer.length > 0) {
                this.processCompleteResponse();
            } else {
                this.showResponse(`Success: ${coap.codeStr}`, 'text');
            }

            this.clearPendingRequest();

        } catch (error) {
            this.log(`CoAP parse error: ${error.message}`, 'error');
            console.error('CoAP parse error:', error);
        }
    }

    requestNextBlock(lastResponse) {
        if (!this.pendingCoAPFrame) return;

        this.block2Num++;

        const frame = CoAP.buildFrame({
            type: CoAP.TYPE_CONFIRMABLE,
            method: this.pendingCoAPFrame.method,
            uriPaths: this.pendingCoAPFrame.uriPaths,
            uriQueries: this.pendingCoAPFrame.uriQueries,
            accept: this.pendingCoAPFrame.accept,
            block2: { num: this.block2Num, more: 0, size: CoAP.BLOCK_SIZE }
        });

        this.sendMUP1Frame('c', frame.bytes);
    }

    processCompleteResponse() {
        const payload = new Uint8Array(this.responseBuffer);

        // Show raw hex
        const hexStr = Array.from(payload).map(b => b.toString(16).padStart(2, '0')).join(' ');
        document.getElementById('rawOutput').textContent = hexStr;

        // Try to decode as CBOR
        try {
            const decoded = this.decodeCBOR(payload);
            const formatted = JSON.stringify(decoded, null, 2);
            this.showResponse(formatted, 'json');
        } catch (error) {
            // If CBOR decode fails, show as hex
            this.showResponse(`Raw data (${payload.length} bytes):\n${hexStr}`, 'text');
        }

        this.responseBuffer = [];
    }

    // Simple CBOR decoder for basic types
    decodeCBOR(data) {
        let offset = 0;

        const decode = () => {
            if (offset >= data.length) {
                throw new Error('Unexpected end of CBOR data');
            }

            const byte = data[offset++];
            const majorType = byte >> 5;
            let additionalInfo = byte & 0x1f;

            // Get the argument value
            let value;
            if (additionalInfo < 24) {
                value = additionalInfo;
            } else if (additionalInfo === 24) {
                value = data[offset++];
            } else if (additionalInfo === 25) {
                value = (data[offset] << 8) | data[offset + 1];
                offset += 2;
            } else if (additionalInfo === 26) {
                value = (data[offset] << 24) | (data[offset + 1] << 16) |
                        (data[offset + 2] << 8) | data[offset + 3];
                offset += 4;
            } else if (additionalInfo === 27) {
                // 64-bit - simplified handling
                let high = (data[offset] << 24) | (data[offset + 1] << 16) |
                           (data[offset + 2] << 8) | data[offset + 3];
                let low = (data[offset + 4] << 24) | (data[offset + 5] << 16) |
                          (data[offset + 6] << 8) | data[offset + 7];
                offset += 8;
                value = high * 0x100000000 + low;
            } else if (additionalInfo === 31) {
                value = -1; // Indefinite length
            } else {
                throw new Error(`Invalid CBOR additional info: ${additionalInfo}`);
            }

            switch (majorType) {
                case 0: // Unsigned integer
                    return value;
                case 1: // Negative integer
                    return -1 - value;
                case 2: // Byte string
                    if (value === -1) {
                        // Indefinite length
                        const chunks = [];
                        while (data[offset] !== 0xff) {
                            chunks.push(decode());
                        }
                        offset++; // Skip break
                        return chunks.flat();
                    }
                    const bytes = data.slice(offset, offset + value);
                    offset += value;
                    return Array.from(bytes);
                case 3: // Text string
                    if (value === -1) {
                        // Indefinite length
                        let str = '';
                        while (data[offset] !== 0xff) {
                            str += decode();
                        }
                        offset++; // Skip break
                        return str;
                    }
                    const textBytes = data.slice(offset, offset + value);
                    offset += value;
                    return new TextDecoder().decode(textBytes);
                case 4: // Array
                    const arr = [];
                    if (value === -1) {
                        // Indefinite length
                        while (data[offset] !== 0xff) {
                            arr.push(decode());
                        }
                        offset++; // Skip break
                    } else {
                        for (let i = 0; i < value; i++) {
                            arr.push(decode());
                        }
                    }
                    return arr;
                case 5: // Map
                    const map = {};
                    if (value === -1) {
                        // Indefinite length
                        while (data[offset] !== 0xff) {
                            const key = decode();
                            const val = decode();
                            map[key] = val;
                        }
                        offset++; // Skip break
                    } else {
                        for (let i = 0; i < value; i++) {
                            const key = decode();
                            const val = decode();
                            map[key] = val;
                        }
                    }
                    return map;
                case 6: // Tag
                    const tag = value;
                    const content = decode();
                    return { _tag: tag, value: content };
                case 7: // Simple/float
                    if (additionalInfo === 20) return false;
                    if (additionalInfo === 21) return true;
                    if (additionalInfo === 22) return null;
                    if (additionalInfo === 23) return undefined;
                    if (additionalInfo === 25) {
                        // Half-precision float (simplified)
                        return value;
                    }
                    if (additionalInfo === 26) {
                        // Single-precision float
                        const buf = new ArrayBuffer(4);
                        const view = new DataView(buf);
                        view.setUint32(0, value);
                        return view.getFloat32(0);
                    }
                    if (additionalInfo === 27) {
                        // Double-precision float
                        return value; // Simplified
                    }
                    return value;
                default:
                    throw new Error(`Unknown CBOR major type: ${majorType}`);
            }
        };

        // Handle CBOR sequence (multiple items)
        const results = [];
        while (offset < data.length) {
            results.push(decode());
        }

        return results.length === 1 ? results[0] : results;
    }

    // Simple CBOR encoder for basic types
    encodeCBOR(value) {
        const encode = (val) => {
            if (val === null || val === undefined) {
                return [0xf6]; // null
            }
            if (typeof val === 'boolean') {
                return val ? [0xf5] : [0xf4];
            }
            if (typeof val === 'number') {
                if (Number.isInteger(val) && val >= 0 && val <= 0xffffffff) {
                    if (val < 24) return [val];
                    if (val < 256) return [0x18, val];
                    if (val < 65536) return [0x19, val >> 8, val & 0xff];
                    return [0x1a, (val >> 24) & 0xff, (val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff];
                }
                if (Number.isInteger(val) && val < 0 && val >= -0xffffffff) {
                    const negVal = -1 - val;
                    if (negVal < 24) return [0x20 | negVal];
                    if (negVal < 256) return [0x38, negVal];
                    if (negVal < 65536) return [0x39, negVal >> 8, negVal & 0xff];
                    return [0x3a, (negVal >> 24) & 0xff, (negVal >> 16) & 0xff, (negVal >> 8) & 0xff, negVal & 0xff];
                }
                // Float (simplified - use double)
                const buf = new ArrayBuffer(8);
                const view = new DataView(buf);
                view.setFloat64(0, val);
                const bytes = [0xfb];
                for (let i = 0; i < 8; i++) {
                    bytes.push(view.getUint8(i));
                }
                return bytes;
            }
            if (typeof val === 'string') {
                const encoded = new TextEncoder().encode(val);
                const header = [];
                if (encoded.length < 24) {
                    header.push(0x60 | encoded.length);
                } else if (encoded.length < 256) {
                    header.push(0x78, encoded.length);
                } else if (encoded.length < 65536) {
                    header.push(0x79, encoded.length >> 8, encoded.length & 0xff);
                } else {
                    header.push(0x7a, (encoded.length >> 24) & 0xff, (encoded.length >> 16) & 0xff,
                               (encoded.length >> 8) & 0xff, encoded.length & 0xff);
                }
                return [...header, ...encoded];
            }
            if (Array.isArray(val)) {
                const header = [];
                if (val.length < 24) {
                    header.push(0x80 | val.length);
                } else if (val.length < 256) {
                    header.push(0x98, val.length);
                } else {
                    header.push(0x99, val.length >> 8, val.length & 0xff);
                }
                let items = [];
                for (const item of val) {
                    items = items.concat(encode(item));
                }
                return [...header, ...items];
            }
            if (typeof val === 'object') {
                const keys = Object.keys(val);
                const header = [];
                if (keys.length < 24) {
                    header.push(0xa0 | keys.length);
                } else if (keys.length < 256) {
                    header.push(0xb8, keys.length);
                } else {
                    header.push(0xb9, keys.length >> 8, keys.length & 0xff);
                }
                let items = [];
                for (const key of keys) {
                    const keyNum = parseInt(key);
                    if (!isNaN(keyNum)) {
                        items = items.concat(encode(keyNum));
                    } else {
                        items = items.concat(encode(key));
                    }
                    items = items.concat(encode(val[key]));
                }
                return [...header, ...items];
            }
            return [0xf6]; // null as fallback
        };

        return new Uint8Array(encode(value));
    }

    clearPendingRequest() {
        this.pendingCoAPFrame = null;
        this.block2Num = 0;
        if (this.responseTimeout) {
            clearTimeout(this.responseTimeout);
            this.responseTimeout = null;
        }
    }

    async send(data) {
        if (!this.writer) {
            this.log('Not connected', 'error');
            return false;
        }

        try {
            await this.writer.write(data);
            const hexStr = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
            this.log(`TX: ${hexStr}`, 'tx');
            return true;
        } catch (error) {
            this.log(`Send error: ${error.message}`, 'error');
            return false;
        }
    }

    async sendMUP1Frame(type, data) {
        const frame = MUP1.encodeFrame(type, data);
        return await this.send(frame);
    }

    async sendPing() {
        this.responseBuffer = [];
        const frame = MUP1.createPingFrame();
        await this.send(frame);
    }

    async sendCoAPRequest(method, urlPath, queries = [], payload = null) {
        this.responseBuffer = [];
        this.block2Num = 0;

        // Parse URL path and queries
        let uriPaths = [];
        let uriQueries = [...queries];

        if (urlPath.includes('?')) {
            const [path, queryStr] = urlPath.split('?');
            uriPaths = path.split('/').filter(p => p.length > 0);
            uriQueries = uriQueries.concat(queryStr.split('&'));
        } else {
            uriPaths = urlPath.split('/').filter(p => p.length > 0);
        }

        // Store pending request info for block-wise transfers
        this.pendingCoAPFrame = {
            method,
            uriPaths,
            uriQueries,
            accept: CoAP.getDefaultAccept(method)
        };

        const contentFormat = payload ? CoAP.getDefaultContentFormat(method) : null;

        const frame = CoAP.buildFrame({
            type: CoAP.TYPE_CONFIRMABLE,
            method,
            uriPaths,
            uriQueries,
            contentFormat,
            accept: this.pendingCoAPFrame.accept,
            payload,
            block2: { num: 0, more: 0, size: CoAP.BLOCK_SIZE }
        });

        await this.sendMUP1Frame('c', frame.bytes);

        // Set timeout for response
        this.responseTimeout = setTimeout(() => {
            this.log('Response timeout', 'error');
            this.showResponse('Error: Response timeout', 'error');
            this.clearPendingRequest();
        }, 10000);
    }

    async sendTrace(module, level) {
        const frame = MUP1.createTraceFrame(module, level);
        await this.send(frame);
    }

    updateConnectionStatus(connected) {
        const statusEl = document.getElementById('status');
        const connectBtn = document.getElementById('connectBtn');
        const disconnectBtn = document.getElementById('disconnectBtn');

        if (connected) {
            statusEl.textContent = 'Connected';
            statusEl.className = 'status connected';
            connectBtn.disabled = true;
            disconnectBtn.disabled = false;
        } else {
            statusEl.textContent = 'Disconnected';
            statusEl.className = 'status disconnected';
            connectBtn.disabled = false;
            disconnectBtn.disabled = true;
            document.getElementById('deviceInfo').textContent = '';
        }
    }

    log(message, type = 'info') {
        const logEl = document.getElementById('logOutput');
        const timestamp = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${timestamp}] ${message}`;
        logEl.appendChild(entry);
        logEl.scrollTop = logEl.scrollHeight;
    }

    showResponse(content, format = 'text') {
        const el = document.getElementById('parsedOutput');
        if (format === 'json') {
            el.innerHTML = this.syntaxHighlight(content);
        } else if (format === 'error') {
            el.innerHTML = `<span style="color: #ff5252">${content}</span>`;
        } else {
            el.textContent = content;
        }
    }

    syntaxHighlight(json) {
        return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
            let cls = 'number';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = 'key';
                    return `<span style="color: #00d4ff">${match}</span>`;
                } else {
                    cls = 'string';
                    return `<span style="color: #98c379">${match}</span>`;
                }
            } else if (/true|false/.test(match)) {
                return `<span style="color: #e5c07b">${match}</span>`;
            } else if (/null/.test(match)) {
                return `<span style="color: #c678dd">${match}</span>`;
            }
            return `<span style="color: #d19a66">${match}</span>`;
        });
    }
}

// Global app instance
let app;

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Check for Web Serial API support
    if (!('serial' in navigator)) {
        alert('Web Serial API is not supported in this browser. Please use Chrome or Edge.');
        return;
    }
    app = new VelocityDriveApp();
});

// Quick command functions
function sendPing() {
    if (app) app.sendPing();
}

function sendGetStatus() {
    if (app) app.sendCoAPRequest(CoAP.CODE_GET, 'c');
}

function sendGetConfig() {
    if (app) app.sendCoAPRequest(CoAP.CODE_GET, 'c', ['c=c']);
}

function sendGetInterfaces() {
    if (app) {
        const yaml = '- "/ietf-interfaces:interfaces"';
        const payload = app.encodeCBOR([29022]); // SID for interfaces
        app.sendCoAPRequest(CoAP.CODE_FETCH, 'c', [], payload);
    }
}

function sendGetPorts() {
    if (app) {
        // Fetch ports 1-4
        const sids = [29022]; // interfaces SID
        const payload = app.encodeCBOR(sids);
        app.sendCoAPRequest(CoAP.CODE_FETCH, 'c', ['c=c'], payload);
    }
}

function sendRequest() {
    if (!app) return;

    const method = document.getElementById('coapMethod').value;
    const urlPath = document.getElementById('urlPath').value;
    const queryOption = document.getElementById('queryOption').value;
    const yamlInput = document.getElementById('yamlInput').value.trim();

    let queries = [];
    if (queryOption) {
        queries.push(queryOption);
    }

    let payload = null;
    if (yamlInput && ['fetch', 'ipatch', 'put', 'post'].includes(method)) {
        // For now, just use simple CBOR encoding
        // In a real implementation, you'd need to convert YAML to proper CORECONF CBOR
        try {
            // Parse simple YAML array of strings (paths)
            const lines = yamlInput.split('\n').filter(l => l.trim().startsWith('-'));
            const paths = lines.map(l => l.replace(/^-\s*/, '').replace(/["']/g, '').trim());

            if (method === 'fetch') {
                // For FETCH, encode as CBOR array of identifiers
                // This is simplified - real implementation would use SIDs
                payload = app.encodeCBOR(paths);
            } else {
                // For iPATCH/PUT/POST, encode the data
                payload = app.encodeCBOR(paths);
            }
        } catch (e) {
            app.log(`YAML parse error: ${e.message}`, 'error');
            return;
        }
    }

    const methodCode = {
        'get': CoAP.CODE_GET,
        'fetch': CoAP.CODE_FETCH,
        'ipatch': CoAP.CODE_IPATCH,
        'put': CoAP.CODE_PUT,
        'post': CoAP.CODE_POST,
        'delete': CoAP.CODE_DELETE
    }[method];

    app.sendCoAPRequest(methodCode, urlPath, queries, payload);
}

function sendTrace() {
    if (!app) return;

    const module = document.getElementById('traceModule').value;
    const level = document.getElementById('traceLevel').value;
    app.sendTrace(module, level);
}

function clearYaml() {
    document.getElementById('yamlInput').value = '';
}

function clearResponse() {
    document.getElementById('parsedOutput').textContent = '';
    document.getElementById('rawOutput').textContent = '';
}

function clearLog() {
    document.getElementById('logOutput').innerHTML = '';
}

function copyResponse() {
    const content = document.getElementById('parsedOutput').textContent;
    navigator.clipboard.writeText(content).then(() => {
        alert('Copied to clipboard');
    });
}

function showTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');

    if (tab === 'parsed') {
        document.getElementById('parsedOutput').style.display = 'block';
        document.getElementById('rawOutput').style.display = 'none';
    } else {
        document.getElementById('parsedOutput').style.display = 'none';
        document.getElementById('rawOutput').style.display = 'block';
    }
}
