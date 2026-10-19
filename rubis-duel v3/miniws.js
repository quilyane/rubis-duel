'use strict';
// Mini serveur WebSocket (RFC 6455) sans dépendance : messages texte uniquement.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 8 * 1024;

class Socket extends EventEmitter {
  constructor(raw) {
    super();
    this.raw = raw;
    this.readyState = 1;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.alive = true;
    raw.on('data', (d) => this._onData(d));
    raw.on('close', () => this._closed());
    raw.on('error', () => this._closed());
  }

  _closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  _frame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([head, payload]);
  }

  send(text) {
    if (this.readyState !== 1) return;
    try { this.raw.write(this._frame(0x1, Buffer.from(text, 'utf8'))); } catch { /* socket fermé */ }
  }

  ping() { if (this.readyState === 1) try { this.raw.write(this._frame(0x9, Buffer.alloc(0))); } catch { /* */ } }

  close(code = 1000) {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    try { this.raw.end(this._frame(0x8, p)); } catch { /* */ }
  }

  terminate() { this.readyState = 3; try { this.raw.destroy(); } catch { /* */ } this.emit('close'); }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > MAX_PAYLOAD) return this.close(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { try { this.raw.write(this._frame(0xA, data)); } catch { /* */ } continue; }
      if (opcode === 0xA) { this.alive = true; continue; }
      if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1) this.frag = [];
        if (!this.frag) return this.close(1002);
        this.frag.push(data);
        if (this.frag.reduce((n, x) => n + x.length, 0) > MAX_PAYLOAD) return this.close(1009);
        if (fin) { const msg = Buffer.concat(this.frag).toString('utf8'); this.frag = null; this.emit('message', msg); }
      }
    }
  }
}

function attach(server, path, onConnection) {
  server.on('upgrade', (req, raw) => {
    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (url !== path || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      raw.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      raw.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    raw.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    raw.setNoDelay(true);
    const ws = new Socket(raw);
    onConnection(ws, req);
  });
}

module.exports = { attach };
