'use strict';
// One transport per speaker, kept between calls (a Cast connection is worth
// keeping). Kept by id, but a transport talks to the address the speaker had
// when it was made: when the speaker turns up at a new one (a new DHCP
// lease), the old transport is closed and a new one made for the new address.

function transportCache(make) {
  /** @type {Map<string, any>} */
  const map = new Map();
  return {
    get(device) {
      if (!device || !device.id) throw new Error('No device supplied');
      let t = map.get(device.id);
      if (t && (t.device?.host !== device.host || t.device?.port !== device.port)) {
        if (typeof t.close === 'function') { try { t.close(); } catch { /* already gone */ } }
        t = null;
      }
      if (!t) {
        t = make(device);
        map.set(device.id, t);
      }
      return t;
    },
    values() { return map.values(); },
  };
}

module.exports = { transportCache };
