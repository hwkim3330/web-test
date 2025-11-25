// CoAP Protocol Implementation for VelocityDRIVE-SP
// Based on RFC7252 and velocitydrivesp-support implementation

const CoAP = {
    // CoAP codes
    CODE_PING: 0,
    CODE_GET: 1,
    CODE_POST: 2,
    CODE_PUT: 3,
    CODE_DELETE: 4,
    CODE_FETCH: 5,
    CODE_IPATCH: 7,

    // CoAP types
    TYPE_CONFIRMABLE: 0,
    TYPE_NON_CONFIRMABLE: 1,
    TYPE_ACK: 2,
    TYPE_RESET: 3,

    // Content formats
    FORMAT_TEXT_PLAIN: 0,
    FORMAT_APPL_LINK: 40,
    FORMAT_APPL_XML: 41,
    FORMAT_APPL_JSON: 50,
    FORMAT_APPL_CBOR: 60,
    FORMAT_YANG_DATA_CBOR: 140,
    FORMAT_YANG_IDENTIFIERS_CBOR: 141,
    FORMAT_YANG_INSTANCES_CBOR: 142,

    // CoAP options
    OPT_IF_MATCH: 1,
    OPT_URI_HOST: 3,
    OPT_ETAG: 4,
    OPT_IF_NONE_MATCH: 5,
    OPT_URI_PORT: 7,
    OPT_LOCATION_PATH: 8,
    OPT_URI_PATH: 11,
    OPT_CONTENT_FORMAT: 12,
    OPT_MAX_AGE: 14,
    OPT_URI_QUERY: 15,
    OPT_ACCEPT: 17,
    OPT_LOCATION_QUERY: 20,
    OPT_BLOCK2: 23,
    OPT_BLOCK1: 27,
    OPT_SIZE1: 60,

    // Block sizes
    BLOCK_SIZE: 256,

    // Message ID counter
    messageId: Math.floor(Math.random() * 65536),

    // Get next message ID
    getNextMessageId() {
        this.messageId = (this.messageId + 1) & 0xffff;
        return this.messageId;
    },

    // Encode option value (variable length)
    encodeOptionValue(delta, length) {
        let result = [];
        let deltaExt = [];
        let lengthExt = [];
        let deltaVal = delta;
        let lengthVal = length;

        if (delta < 13) {
            deltaVal = delta;
        } else if (delta < 269) {
            deltaVal = 13;
            deltaExt = [delta - 13];
        } else {
            deltaVal = 14;
            const d = delta - 269;
            deltaExt = [(d >> 8) & 0xff, d & 0xff];
        }

        if (length < 13) {
            lengthVal = length;
        } else if (length < 269) {
            lengthVal = 13;
            lengthExt = [length - 13];
        } else {
            lengthVal = 14;
            const l = length - 269;
            lengthExt = [(l >> 8) & 0xff, l & 0xff];
        }

        result.push((deltaVal << 4) | lengthVal);
        result = result.concat(deltaExt);
        result = result.concat(lengthExt);
        return result;
    },

    // Encode unsigned integer as minimal bytes
    encodeUint(value) {
        if (value === 0) return [];
        if (value < 256) return [value];
        if (value < 65536) return [(value >> 8) & 0xff, value & 0xff];
        if (value < 16777216) return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
        return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
    },

    // Decode unsigned integer from bytes
    decodeUint(bytes) {
        let value = 0;
        for (const b of bytes) {
            value = (value << 8) | b;
        }
        return value;
    },

    // Encode block option
    encodeBlock(num, more, size) {
        let szx = 0;
        switch (size) {
            case 16: szx = 0; break;
            case 32: szx = 1; break;
            case 64: szx = 2; break;
            case 128: szx = 3; break;
            case 256: szx = 4; break;
            case 512: szx = 5; break;
            case 1024: szx = 6; break;
            default: szx = 4;
        }
        let val = szx;
        if (more) val |= 8;
        val |= (num << 4);
        return this.encodeUint(val);
    },

    // Decode block option
    decodeBlock(bytes) {
        const val = this.decodeUint(bytes);
        const szx = val & 0x7;
        const more = (val >> 3) & 1;
        const num = val >> 4;
        const size = Math.pow(2, szx + 4);
        return { num, more, size };
    },

    // Add option to frame
    addOption(frame, lastOption, optionNum, value) {
        const delta = optionNum - lastOption;
        const valueBytes = typeof value === 'string' ?
            Array.from(value).map(c => c.charCodeAt(0)) :
            Array.from(value);

        const header = this.encodeOptionValue(delta, valueBytes.length);
        frame.push(...header);
        frame.push(...valueBytes);
        return optionNum;
    },

    // Build CoAP frame
    buildFrame(options) {
        const {
            type = this.TYPE_CONFIRMABLE,
            method,
            messageId,
            token = [],
            uriPaths = [],
            uriQueries = [],
            contentFormat = null,
            accept = null,
            block1 = null,
            block2 = null,
            payload = null
        } = options;

        const frame = [];

        // Header (4 bytes)
        const ver = 1;
        const tkl = token.length;
        const code = method;
        const msgId = messageId ?? this.getNextMessageId();

        frame.push((ver << 6) | (type << 4) | tkl);
        frame.push(code);
        frame.push((msgId >> 8) & 0xff);
        frame.push(msgId & 0xff);

        // Token
        frame.push(...token);

        // Options (must be in order by option number)
        let lastOption = 0;

        // URI-Path (11)
        for (const path of uriPaths) {
            if (path && path.length > 0) {
                lastOption = this.addOption(frame, lastOption, this.OPT_URI_PATH, path);
            }
        }

        // Content-Format (12)
        if (contentFormat !== null && contentFormat >= 0) {
            lastOption = this.addOption(frame, lastOption, this.OPT_CONTENT_FORMAT, this.encodeUint(contentFormat));
        }

        // URI-Query (15)
        for (const query of uriQueries) {
            if (query && query.length > 0) {
                lastOption = this.addOption(frame, lastOption, this.OPT_URI_QUERY, query);
            }
        }

        // Accept (17)
        if (accept !== null && accept >= 0) {
            lastOption = this.addOption(frame, lastOption, this.OPT_ACCEPT, this.encodeUint(accept));
        }

        // Block2 (23)
        if (block2) {
            const blockVal = this.encodeBlock(block2.num, block2.more, block2.size);
            lastOption = this.addOption(frame, lastOption, this.OPT_BLOCK2, blockVal);
        }

        // Block1 (27)
        if (block1) {
            const blockVal = this.encodeBlock(block1.num, block1.more, block1.size);
            lastOption = this.addOption(frame, lastOption, this.OPT_BLOCK1, blockVal);
        }

        // Payload marker and payload
        if (payload && payload.length > 0) {
            frame.push(0xff);  // Payload marker
            const payloadBytes = payload instanceof Uint8Array ?
                Array.from(payload) :
                typeof payload === 'string' ?
                    Array.from(payload).map(c => c.charCodeAt(0)) :
                    Array.from(payload);
            frame.push(...payloadBytes);
        }

        return {
            bytes: new Uint8Array(frame),
            messageId: msgId
        };
    },

    // Parse CoAP frame
    parseFrame(data) {
        if (data.length < 4) {
            throw new Error('CoAP frame too short');
        }

        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        let offset = 0;

        // Parse header
        const firstByte = bytes[offset++];
        const ver = (firstByte >> 6) & 0x3;
        const type = (firstByte >> 4) & 0x3;
        const tkl = firstByte & 0xf;

        if (ver !== 1) {
            throw new Error(`Unexpected CoAP version: ${ver}`);
        }

        const code = bytes[offset++];
        const codeClass = (code >> 5) & 0x7;
        const codeDetail = code & 0x1f;

        const messageId = (bytes[offset] << 8) | bytes[offset + 1];
        offset += 2;

        // Parse token
        const token = bytes.slice(offset, offset + tkl);
        offset += tkl;

        // Parse options
        const options = {
            uriPaths: [],
            uriQueries: [],
            contentFormat: null,
            accept: null,
            block1: null,
            block2: null
        };

        let optionNum = 0;
        while (offset < bytes.length && bytes[offset] !== 0xff) {
            const optByte = bytes[offset++];
            let delta = (optByte >> 4) & 0xf;
            let length = optByte & 0xf;

            // Extended delta
            if (delta === 13) {
                delta = bytes[offset++] + 13;
            } else if (delta === 14) {
                delta = ((bytes[offset] << 8) | bytes[offset + 1]) + 269;
                offset += 2;
            } else if (delta === 15) {
                throw new Error('Reserved option delta');
            }

            // Extended length
            if (length === 13) {
                length = bytes[offset++] + 13;
            } else if (length === 14) {
                length = ((bytes[offset] << 8) | bytes[offset + 1]) + 269;
                offset += 2;
            } else if (length === 15) {
                throw new Error('Reserved option length');
            }

            optionNum += delta;
            const optionValue = bytes.slice(offset, offset + length);
            offset += length;

            // Process option
            switch (optionNum) {
                case this.OPT_URI_PATH:
                    options.uriPaths.push(String.fromCharCode(...optionValue));
                    break;
                case this.OPT_URI_QUERY:
                    options.uriQueries.push(String.fromCharCode(...optionValue));
                    break;
                case this.OPT_CONTENT_FORMAT:
                    options.contentFormat = this.decodeUint(Array.from(optionValue));
                    break;
                case this.OPT_ACCEPT:
                    options.accept = this.decodeUint(Array.from(optionValue));
                    break;
                case this.OPT_BLOCK1:
                    options.block1 = this.decodeBlock(Array.from(optionValue));
                    break;
                case this.OPT_BLOCK2:
                    options.block2 = this.decodeBlock(Array.from(optionValue));
                    break;
            }
        }

        // Parse payload
        let payload = null;
        if (offset < bytes.length && bytes[offset] === 0xff) {
            offset++;  // Skip payload marker
            payload = bytes.slice(offset);
        }

        return {
            version: ver,
            type,
            typeStr: ['CON', 'NON', 'ACK', 'RST'][type],
            codeClass,
            codeDetail,
            codeStr: this.getCodeString(codeClass, codeDetail),
            messageId,
            token,
            options,
            payload
        };
    },

    // Get code string
    getCodeString(codeClass, codeDetail) {
        if (codeClass === 0) {
            const methods = ['PING', 'GET', 'POST', 'PUT', 'DELETE', 'FETCH', '', 'IPATCH'];
            return methods[codeDetail] || `0.${codeDetail.toString().padStart(2, '0')}`;
        }
        if (codeClass === 2) {
            const success = {1: 'Created', 2: 'Deleted', 3: 'Valid', 4: 'Changed', 5: 'Content', 31: 'Continue'};
            return success[codeDetail] || `2.${codeDetail.toString().padStart(2, '0')}`;
        }
        if (codeClass === 4) {
            const clientErr = {
                0: 'Bad Request', 1: 'Unauthorized', 2: 'Bad Option', 3: 'Forbidden',
                4: 'Not Found', 5: 'Method Not Allowed', 6: 'Not Acceptable',
                8: 'Request Entity Incomplete', 9: 'Conflict', 12: 'Precondition Failed',
                13: 'Request Entity Too Large', 15: 'Unsupported Content-Format'
            };
            return clientErr[codeDetail] || `4.${codeDetail.toString().padStart(2, '0')}`;
        }
        if (codeClass === 5) {
            const serverErr = {
                0: 'Internal Server Error', 1: 'Not Implemented', 2: 'Bad Gateway',
                3: 'Service Unavailable', 4: 'Gateway Timeout', 5: 'Proxying Not Supported'
            };
            return serverErr[codeDetail] || `5.${codeDetail.toString().padStart(2, '0')}`;
        }
        return `${codeClass}.${codeDetail.toString().padStart(2, '0')}`;
    },

    // Get default content format for method
    getDefaultContentFormat(method) {
        switch (method) {
            case this.CODE_POST:
            case this.CODE_PUT:
                return this.FORMAT_YANG_DATA_CBOR;
            case this.CODE_FETCH:
                return this.FORMAT_YANG_IDENTIFIERS_CBOR;
            case this.CODE_IPATCH:
                return this.FORMAT_YANG_INSTANCES_CBOR;
            default:
                return null;
        }
    },

    // Get default accept for method
    getDefaultAccept(method) {
        switch (method) {
            case this.CODE_GET:
                return this.FORMAT_YANG_DATA_CBOR;
            case this.CODE_FETCH:
                return this.FORMAT_YANG_INSTANCES_CBOR;
            default:
                return null;
        }
    },

    // Build a request frame
    buildRequest(method, urlPath, queries = [], payload = null) {
        // Parse URL path
        const pathParts = urlPath.split('/').filter(p => p.length > 0);

        // Parse queries from URL if present
        let allQueries = [...queries];
        if (urlPath.includes('?')) {
            const [path, queryStr] = urlPath.split('?');
            pathParts.length = 0;
            pathParts.push(...path.split('/').filter(p => p.length > 0));
            allQueries = allQueries.concat(queryStr.split('&'));
        }

        const contentFormat = payload ? this.getDefaultContentFormat(method) : null;
        const accept = this.getDefaultAccept(method);

        return this.buildFrame({
            type: this.TYPE_CONFIRMABLE,
            method,
            uriPaths: pathParts,
            uriQueries: allQueries,
            contentFormat,
            accept,
            payload,
            block2: { num: 0, more: 0, size: this.BLOCK_SIZE }
        });
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CoAP;
}
