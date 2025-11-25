# VelocityDRIVE-SP Web Serial CBS Control

CBS (Credit Based Shaper) configuration tool for VelocityDRIVE-SP using Web Serial API.

## Requirements

- Chrome or Edge browser (Web Serial API support)
- VelocityDRIVE-SP device connected via USB (/dev/ttyACM0)

## Usage

### Option 1: Open directly
Open `cbs.html` in Chrome/Edge browser.

### Option 2: Run local server
```bash
node server.js
# Open http://localhost:8080/cbs.html
```

## Protocol Details

### MUP1 (Microchip UART Protocol 1)
- Baud rate: 115200
- Frame format: `>` + type + data + `<` + checksum
- Frame types: `p` (Ping), `c` (CoAP)

### CORECONF (CoAP + YANG + CBOR)
- iPATCH method for configuration
- Content-Type: application/yang-instances+cbor (142)
- YANG SID based instance identifiers

### YANG SIDs (mchp-velocitysp-port module)
- `traffic-class-shapers`: 8051
- `traffic-class`: 8052
- `credit-based`: 8053
- `idle-slope`: 8054

### iPATCH CBOR Structure
```
{ [SID, interface-name] => [{ delta-tc: tc, delta-cb: { delta-is: idleSlope } }] }
```

## License

MIT - Based on Microchip VelocityDRIVE-SP support tools.
