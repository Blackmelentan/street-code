import { COMMON_DTC_CODES } from '../../../shared/constants.js';

/**
 * Universal ELM327 OBD-II Protocol Handler & Telemetry Parser
 * Compatible with Bluetooth SPP / BLE / USB ELM327 adapters
 */

export class Elm327ProtocolHandler {
  /**
   * Parse hex string response from ELM327
   * @param {string} rawResponse E.g. "41 0C 1A F8" or "43 02 03 00 04 20"
   */
  static parse(rawResponse) {
    const clean = rawResponse.replace(/[\r\n\s>]/g, '').toUpperCase();
    
    // Check for standard AT command acknowledgments
    if (clean === 'OK' || clean.startsWith('ELM327') || clean === 'SEARCHING...') {
      return { type: 'COMMAND_ACK', value: clean };
    }

    if (clean === 'NODATA') {
      return { type: 'NO_DATA', value: null };
    }

    // Mode 01 (Live Data): Response starts with 41
    if (clean.startsWith('41')) {
      return this.parseMode01(clean);
    }

    // Mode 03 (Diagnostic Trouble Codes): Response starts with 43
    if (clean.startsWith('43')) {
      return this.parseMode03(clean);
    }

    // Mode 04 (Clear DTCs): Response starts with 44
    if (clean.startsWith('44')) {
      return { type: 'DTC_CLEARED', success: true };
    }

    return { type: 'UNKNOWN', raw: rawResponse };
  }

  /**
   * Parse Mode 01 PIDs
   */
  static parseMode01(hex) {
    const pid = hex.substring(2, 4);
    const dataBytes = [];
    for (let i = 4; i < hex.length; i += 2) {
      dataBytes.push(parseInt(hex.substring(i, i + 2), 16));
    }

    switch (pid) {
      case '0C': { // Engine RPM: ((A*256)+B)/4
        const rpm = Math.round(((dataBytes[0] * 256) + dataBytes[1]) / 4);
        return { type: 'LIVE_METRIC', pid: '010C', metric: 'RPM', value: rpm, unit: 'rpm' };
      }
      case '0D': { // Vehicle Speed: A
        const speed = dataBytes[0];
        return { type: 'LIVE_METRIC', pid: '010D', metric: 'SPEED', value: speed, unit: 'km/h' };
      }
      case '05': { // Engine Coolant Temp: A - 40
        const temp = dataBytes[0] - 40;
        return { type: 'LIVE_METRIC', pid: '0105', metric: 'COOLANT_TEMP', value: temp, unit: '°C' };
      }
      case '2F': { // Fuel Level: (100*A)/255
        const fuel = Math.round(((100 * dataBytes[0]) / 255) * 10) / 10;
        return { type: 'LIVE_METRIC', pid: '012F', metric: 'FUEL_LEVEL', value: fuel, unit: '%' };
      }
      case '04': { // Calculated Engine Load: (100*A)/255
        const load = Math.round(((100 * dataBytes[0]) / 255) * 10) / 10;
        return { type: 'LIVE_METRIC', pid: '0104', metric: 'ENGINE_LOAD', value: load, unit: '%' };
      }
      default:
        return { type: 'LIVE_METRIC', pid: `01${pid}`, dataBytes };
    }
  }

  /**
   * Parse Mode 03 Stored Trouble Codes
   * E.g. "43 02 03 00 04 20" -> P0300, P0420
   */
  static parseMode03(hex) {
    // hex: 43 [count of dtcs: 1 byte] [dtc 1: 2 bytes] [dtc 2: 2 bytes] ...
    // or direct byte stream without count
    let startIndex = 2;
    // Check if first byte is count
    const possibleCount = parseInt(hex.substring(2, 4), 16);
    if ((hex.length - 4) % 4 === 0 && (hex.length - 4) / 4 === possibleCount) {
      startIndex = 4;
    }

    const dtcList = [];
    for (let i = startIndex; i < hex.length; i += 4) {
      const b1 = parseInt(hex.substring(i, i + 2), 16);
      const b2 = parseInt(hex.substring(i + 2, i + 4), 16);
      if (isNaN(b1) || isNaN(b2)) break;
      if (b1 === 0 && b2 === 0) continue; // padding zeroes

      const prefixMap = ['P', 'C', 'B', 'U'];
      const prefix = prefixMap[(b1 & 0xC0) >> 6];
      const digit1 = (b1 & 0x30) >> 4;
      const digit2 = (b1 & 0x0F).toString(16).toUpperCase();
      const digit3 = ((b2 & 0xF0) >> 4).toString(16).toUpperCase();
      const digit4 = (b2 & 0x0F).toString(16).toUpperCase();

      const dtcCode = `${prefix}${digit1}${digit2}${digit3}${digit4}`;
      const metadata = COMMON_DTC_CODES[dtcCode] || {
        description: 'Manufacturer Specific Diagnostic Code',
        severity: 'MEDIUM',
        category: prefix === 'P' ? 'Powertrain' : prefix === 'C' ? 'Chassis' : prefix === 'B' ? 'Body' : 'Network'
      };

      dtcList.push({
        code: dtcCode,
        description: metadata.description,
        severity: metadata.severity,
        category: metadata.category
      });
    }

    return {
      type: 'DTC_REPORT',
      totalCodes: dtcList.length,
      codes: dtcList
    };
  }

  /**
   * Helper to simulate dynamic realistic OBD-II telemetry for live demo and fleet tracking
   */
  static generateSimulatedFrame({ prevSpeed = 45, prevRpm = 1800, prevFuel = 80 }) {
    const speedDelta = (Math.random() - 0.48) * 8;
    const speed = Math.max(0, Math.min(110, Math.round(prevSpeed + speedDelta)));
    
    // RPM correlates with speed
    const baseRpm = speed === 0 ? 750 : Math.round(900 + speed * 32 + (Math.random() - 0.5) * 150);
    const rpm = Math.max(700, Math.min(4200, baseRpm));

    const coolantTemp = Math.round(88 + (Math.random() - 0.5) * 4); // Normal operating temp ~88-92°C
    const fuel = Math.max(5, Math.min(100, Math.round((prevFuel - 0.01) * 10) / 10));

    return {
      speed_kph: speed,
      engine_rpm: rpm,
      coolant_temp_c: coolantTemp,
      fuel_level_pct: fuel,
      battery_v: 13.8 + Math.round((Math.random() - 0.5) * 0.4 * 10) / 10
    };
  }
}
