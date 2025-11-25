# VelocityDRIVE-SP CBS Control (Web Serial)

A browser-based Credit Based Shaper (CBS) configuration tool for Microchip VelocityDRIVE-SP switches using the Web Serial API.

## Features

- **No installation required** - Runs directly in Chrome/Edge browser
- **No server needed** - Works from `file://` protocol or localhost
- **Real-time communication** - Direct serial communication with the switch
- **Multi-port support** - Configure CBS on multiple ports simultaneously
- **Debug logging** - Full hex dump of TX/RX data for troubleshooting

## Requirements

- **Browser**: Chrome 89+ or Edge 89+ (Web Serial API support)
- **Device**: VelocityDRIVE-SP switch connected via USB serial
- **Connection**: USB cable to `/dev/ttyACM0` (Linux) or COM port (Windows)

## Quick Start

### Option 1: Open directly
```
1. Open index.html in Chrome or Edge
2. Click "Connect Serial Port"
3. Select your USB serial device
4. Select ports and configure CBS
```

### Option 2: Local server (optional)
```bash
node server.js
# Open http://localhost:8080
```

## Protocol Stack

```
┌─────────────────────────────────────────┐
│           Web Serial API                │
├─────────────────────────────────────────┤
│    MUP1 (Microchip UART Protocol 1)     │
│    Frame: SOF + Type + Data + EOF + CRC │
├─────────────────────────────────────────┤
│              CoAP (RFC 7252)            │
│         Method: iPATCH (Code 7)         │
├─────────────────────────────────────────┤
│          CBOR (RFC 8949)                │
│    Content-Type: yang-instances+cbor    │
├─────────────────────────────────────────┤
│     YANG/CORECONF (RFC 9254)            │
│        SID-based addressing             │
└─────────────────────────────────────────┘
```

## MUP1 Protocol Details

### Frame Format
```
┌─────┬──────┬──────────────┬─────┬──────────┐
│ SOF │ Type │     Data     │ EOF │ Checksum │
│ '>' │  1B  │   variable   │ '<' │   4 hex  │
│0x3e │      │  (escaped)   │0x3c │  chars   │
└─────┴──────┴──────────────┴─────┴──────────┘
```

### Frame Types
| Type | Char | Description |
|------|------|-------------|
| Ping | `p`  | Ping request |
| Pong | `P`  | Pong response |
| CoAP | `c`  | CoAP request |
| CoAP | `C`  | CoAP response |
| Trace| `T`  | Debug trace message |

### Special Characters
- **SOF**: `0x3e` (`>`) - Start of frame
- **EOF**: `0x3c` (`<`) - End of frame
- **ESC**: `0x5c` (`\`) - Escape character

### Checksum
16-bit one's complement, represented as 4 uppercase hex characters.

## YANG SID Mapping

From `mchp-velocitysp-port@2025-01-20.sid`:

| Path | SID | Type |
|------|-----|------|
| `.../traffic-class-shapers` | 8051 | list |
| `.../traffic-class-shapers/traffic-class` | 8052 | leaf (key) |
| `.../traffic-class-shapers/credit-based` | 8053 | container |
| `.../traffic-class-shapers/credit-based/idle-slope` | 8054 | leaf |

### Delta-SID Encoding
CBOR uses delta-SID (relative SID) for efficient encoding:
- `traffic-class`: 8052 - 8051 = **1**
- `credit-based`: 8053 - 8051 = **2**
- `idle-slope`: 8054 - 8053 = **1**

## iPATCH CBOR Format

### Instance Identifier (IID)
```
IID = [SID, key1, key2, ...]
```
For CBS: `[8051, "port-name"]`

### iPATCH Payload Structure
```cbor
{
  [8051, "11"] => [        // IID => value
    {
      1: 7,                // traffic-class (delta=1)
      2: {                 // credit-based (delta=2)
        1: 100000          // idle-slope (delta=1)
      }
    }
  ]
}
```

### CBOR Encoding Example
For port "11", TC 7, idle-slope 100000 kbps:
```
a1                    # map(1)
  82                  # array(2) - IID
    19 1f73           # uint(8051) - SID
    62 3131           # text(2) "11" - interface name
  81                  # array(1) - value (list entries)
    a2                # map(2) - entry
      01              # uint(1) - traffic-class key
      07              # uint(7) - traffic-class value
      02              # uint(2) - credit-based key
      a1              # map(1)
        01            # uint(1) - idle-slope key
        1a 000186a0   # uint(100000) - idle-slope value
```

## CoAP Configuration

| Parameter | Value |
|-----------|-------|
| Method | iPATCH (Code 0.07) |
| URI-Path | `c` |
| Content-Format | 142 (application/yang-instances+cbor) |
| Block2 | szx=4 (256 bytes) |

## Troubleshooting

### "Web Serial API not supported"
- Use Chrome 89+ or Edge 89+
- Safari and Firefox do not support Web Serial

### "Connection failed"
- Check USB cable connection
- Verify device is powered on
- Check if another application is using the serial port

### "Bad Request (4.00)"
- CBOR payload format error
- Check the debug log for CBOR hex dump

### "List keys not allowed"
- IID contains incorrect keys
- Traffic-class should be in value, not IID

### "Not Found (4.04)"
- Invalid port number
- Port does not exist on device

## File Structure

```
web-serial/
├── index.html    # Main application (standalone)
├── server.js     # Optional local HTTP server
└── README.md     # This file
```

## References

- [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
- [CoAP RFC 7252](https://datatracker.ietf.org/doc/html/rfc7252)
- [CBOR RFC 8949](https://datatracker.ietf.org/doc/html/rfc8949)
- [CORECONF RFC 9254](https://datatracker.ietf.org/doc/html/rfc9254)
- [VelocityDRIVE-SP Support](https://github.com/microchip-ung/velocitydrivesp-support)

## License

MIT License - Based on Microchip VelocityDRIVE-SP support tools.
