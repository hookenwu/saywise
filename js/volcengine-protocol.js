/**
 * 火山引擎双向流式 TTS WebSocket 协议实现
 * 基于 protocols.ts 改写为纯浏览器 JavaScript（无 ES module）
 *
 * Copied verbatim from public/js/volcengine-protocols.js (tasks.md T3.1) —
 * only change is adding `export` to the public surface so this can be
 * imported as an ES module. No logic changes.
 */

// 高频诊断日志开关：默认关，避免移动 WebView 上 console.log 累积影响性能。
// 三个开关任一开启即生效：
//   1) URL 含 ?devtools=true             —— 进站即开
//   2) localStorage.active-eruda='true'  —— 沿用现有 eruda 调试开关
//   3) localStorage.verbose-logs='true'  —— 远程指引用户在控制台开启
// 调用方：window.__vlog(...)。低频汇总 / 错误日志仍直接用 console.log/warn/error。
(function () {
  let enabled = false;
  try {
    enabled = /devtools=true/.test(location.toString())
      || (typeof localStorage !== 'undefined' && (
        localStorage.getItem('active-eruda') === 'true'
        || localStorage.getItem('verbose-logs') === 'true'
      ));
  } catch (_) { /* localStorage 在某些隐私模式下会抛 */ }
  window.__vlog = enabled ? console.log.bind(console) : function () {};
  window.__vlogEnabled = enabled;
  if (enabled) console.log('[vlog] verbose logs enabled');
})();

export const EventType = {
  None: 0,

  // 连接事件 (1-99)
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,

  // 会话事件 (100-199)
  StartSession: 100,
  CancelSession: 101,
  FinishSession: 102,
  SessionStarted: 150,
  SessionCanceled: 151,
  SessionFinished: 152,
  SessionFailed: 153,
  UsageResponse: 154,

  // 通用事件 (200-299)
  TaskRequest: 200,
  UpdateConfig: 201,
  AudioMuted: 250,

  // TTS 事件 (300-399)
  SayHello: 300,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  TTSEnded: 359
};

export const MsgType = {
  Invalid: 0,
  FullClientRequest: 0b0001,
  AudioOnlyClient: 0b0010,
  FullServerResponse: 0b1001,
  AudioOnlyServer: 0b1011,
  FrontEndResultServer: 0b1100,
  Error: 0b1111
};

export const MsgTypeFlagBits = {
  NoSeq: 0,
  PositiveSeq: 0b001,
  LastNoSeq: 0b010,
  NegativeSeq: 0b011,
  WithEvent: 0b100
};

export const VersionBits = {
  Version1: 1,
  Version2: 2,
  Version3: 3,
  Version4: 4
};

export const HeaderSizeBits = {
  HeaderSize4: 1,
  HeaderSize8: 2,
  HeaderSize12: 3,
  HeaderSize16: 4
};

export const SerializationBits = {
  Raw: 0,
  JSON: 0b0001,
  Thrift: 0b0011,
  Custom: 0b1111
};

export const CompressionBits = {
  None: 0,
  Gzip: 0b0001,
  Custom: 0b1111
};

export function getEventTypeName(eventType) {
  for (const name of Object.keys(EventType)) {
    if (EventType[name] === eventType) return name;
  }
  return `unknown(${eventType})`;
}

export function getMsgTypeName(msgType) {
  for (const name of Object.keys(MsgType)) {
    if (MsgType[name] === msgType) return name;
  }
  return `unknown(${msgType})`;
}

export function messageToString(msg) {
  const eventStr = msg.event !== undefined ? getEventTypeName(msg.event) : 'NoEvent';
  const typeStr = getMsgTypeName(msg.type);
  switch (msg.type) {
    case MsgType.AudioOnlyServer:
    case MsgType.AudioOnlyClient:
      return `MsgType:${typeStr} Event:${eventStr} PayloadSize:${msg.payload.length}`;
    case MsgType.Error:
      return `MsgType:${typeStr} Event:${eventStr} ErrorCode:${msg.errorCode} Payload:${new TextDecoder().decode(msg.payload)}`;
    default:
      return `MsgType:${typeStr} Event:${eventStr} Payload:${new TextDecoder().decode(msg.payload)}`;
  }
}

export function createMessage(msgType, flag) {
  return {
    type: msgType,
    flag: flag,
    version: VersionBits.Version1,
    headerSize: HeaderSizeBits.HeaderSize4,
    serialization: SerializationBits.JSON,
    compression: CompressionBits.None,
    payload: new Uint8Array(0),
    toString() { return messageToString(this); }
  };
}

export function marshalMessage(msg) {
  const buffers = [];

  const headerSize = 4 * msg.headerSize;
  const header = new Uint8Array(headerSize);
  header[0] = (msg.version << 4) | msg.headerSize;
  header[1] = (msg.type << 4) | msg.flag;
  header[2] = (msg.serialization << 4) | msg.compression;
  buffers.push(header);

  for (const writer of _getWriters(msg)) {
    const data = writer(msg);
    if (data) buffers.push(data);
  }

  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of buffers) { result.set(b, offset); offset += b.length; }
  return result;
}

export function unmarshalMessage(data) {
  if (data.length < 3) throw new Error(`data too short: ${data.length} bytes`);

  let offset = 0;
  const versionAndHeaderSize = data[offset++];
  const typeAndFlag = data[offset++];
  const serializationAndCompression = data[offset++];

  const msg = {
    version: versionAndHeaderSize >> 4,
    headerSize: versionAndHeaderSize & 0x0f,
    type: typeAndFlag >> 4,
    flag: typeAndFlag & 0x0f,
    serialization: serializationAndCompression >> 4,
    compression: serializationAndCompression & 0x0f,
    payload: new Uint8Array(0),
    toString() { return messageToString(this); }
  };

  offset = 4 * msg.headerSize;

  for (const reader of _getReaders(msg)) {
    offset = reader(msg, data, offset);
  }
  return msg;
}

// ── internal writers ──────────────────────────────────────────────────────────

function _getWriters(msg) {
  const writers = [];
  if (msg.flag === MsgTypeFlagBits.WithEvent) {
    writers.push(_writeEvent, _writeSessionId);
  }
  switch (msg.type) {
    case MsgType.AudioOnlyClient:
    case MsgType.AudioOnlyServer:
    case MsgType.FrontEndResultServer:
    case MsgType.FullClientRequest:
    case MsgType.FullServerResponse:
      if (msg.flag === MsgTypeFlagBits.PositiveSeq || msg.flag === MsgTypeFlagBits.NegativeSeq) {
        writers.push(_writeSequence);
      }
      break;
    case MsgType.Error:
      writers.push(_writeErrorCode);
      break;
    default:
      throw new Error(`unsupported message type: ${msg.type}`);
  }
  writers.push(_writePayload);
  return writers;
}

function _getReaders(msg) {
  const readers = [];
  switch (msg.type) {
    case MsgType.AudioOnlyClient:
    case MsgType.AudioOnlyServer:
    case MsgType.FrontEndResultServer:
    case MsgType.FullClientRequest:
    case MsgType.FullServerResponse:
      if (msg.flag === MsgTypeFlagBits.PositiveSeq || msg.flag === MsgTypeFlagBits.NegativeSeq) {
        readers.push(_readSequence);
      }
      break;
    case MsgType.Error:
      readers.push(_readErrorCode);
      break;
    default:
      throw new Error(`unsupported message type: ${msg.type}`);
  }
  if (msg.flag === MsgTypeFlagBits.WithEvent) {
    readers.push(_readEvent, _readSessionId, _readConnectId);
  }
  readers.push(_readPayload);
  return readers;
}

function _writeEvent(msg) {
  if (msg.event === undefined) return null;
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, msg.event, false);
  return new Uint8Array(buf);
}

function _writeSessionId(msg) {
  if (msg.event === undefined) return null;
  switch (msg.event) {
    case EventType.StartConnection:
    case EventType.FinishConnection:
    case EventType.ConnectionStarted:
    case EventType.ConnectionFailed:
      return null;
  }
  const sessionId = msg.sessionId || '';
  const bytes = new TextEncoder().encode(sessionId);
  const sizeBuf = new ArrayBuffer(4);
  new DataView(sizeBuf).setUint32(0, bytes.length, false);
  const result = new Uint8Array(4 + bytes.length);
  result.set(new Uint8Array(sizeBuf), 0);
  result.set(bytes, 4);
  return result;
}

function _writeSequence(msg) {
  if (msg.sequence === undefined) return null;
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, msg.sequence, false);
  return new Uint8Array(buf);
}

function _writeErrorCode(msg) {
  if (msg.errorCode === undefined) return null;
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, msg.errorCode, false);
  return new Uint8Array(buf);
}

function _writePayload(msg) {
  const sizeBuf = new ArrayBuffer(4);
  new DataView(sizeBuf).setUint32(0, msg.payload.length, false);
  const result = new Uint8Array(4 + msg.payload.length);
  result.set(new Uint8Array(sizeBuf), 0);
  result.set(msg.payload, 4);
  return result;
}

function _readEvent(msg, data, offset) {
  if (offset + 4 > data.length) throw new Error('insufficient data for event');
  msg.event = new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, false);
  return offset + 4;
}

function _readSessionId(msg, data, offset) {
  if (msg.event === undefined) return offset;
  switch (msg.event) {
    case EventType.StartConnection:
    case EventType.FinishConnection:
    case EventType.ConnectionStarted:
    case EventType.ConnectionFailed:
    case EventType.ConnectionFinished:
      return offset;
  }
  if (offset + 4 > data.length) throw new Error('insufficient data for session ID size');
  const size = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
  offset += 4;
  if (size > 0) {
    msg.sessionId = new TextDecoder().decode(data.slice(offset, offset + size));
    offset += size;
  }
  return offset;
}

function _readConnectId(msg, data, offset) {
  if (msg.event === undefined) return offset;
  switch (msg.event) {
    case EventType.ConnectionStarted:
    case EventType.ConnectionFailed:
    case EventType.ConnectionFinished:
      break;
    default:
      return offset;
  }
  if (offset + 4 > data.length) throw new Error('insufficient data for connect ID size');
  const size = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
  offset += 4;
  if (size > 0) {
    msg.connectId = new TextDecoder().decode(data.slice(offset, offset + size));
    offset += size;
  }
  return offset;
}

function _readSequence(msg, data, offset) {
  if (offset + 4 > data.length) throw new Error('insufficient data for sequence');
  msg.sequence = new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, false);
  return offset + 4;
}

function _readErrorCode(msg, data, offset) {
  if (offset + 4 > data.length) throw new Error('insufficient data for error code');
  msg.errorCode = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
  return offset + 4;
}

function _readPayload(msg, data, offset) {
  if (offset + 4 > data.length) throw new Error('insufficient data for payload size');
  const size = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
  offset += 4;
  if (size > 0) {
    msg.payload = data.slice(offset, offset + size);
    offset += size;
  }
  return offset;
}
