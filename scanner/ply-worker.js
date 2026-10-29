import { parsePly } from "./ply-parser.mjs";
self.onmessage = (e) => {
  try {
    const r = parsePly(e.data);
    const transfer = [r.positions.buffer];
    if (r.colors) transfer.push(r.colors.buffer);
    self.postMessage({ ok: true, ...r }, transfer);
  } catch (e) {
    self.postMessage({ ok: false, error: e.message });
  }
};
