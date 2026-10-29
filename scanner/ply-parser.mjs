export function parsePly(buffer, maxPoints = 150000) {
  const prefix = new TextDecoder().decode(
      buffer.slice(0, Math.min(buffer.byteLength, 1048576)),
    ),
    end = /end_header\r?\n/.exec(prefix);
  if (!/^ply\r?\n/.test(prefix) || !end) throw new Error("Invalid PLY header.");
  const chars = end.index + end[0].length,
    offset = new TextEncoder().encode(prefix.slice(0, chars)).length;
  const lines = prefix.slice(0, end.index).split(/\r?\n/),
    format = (lines.find((l) => l.startsWith("format ")) || "").split(/\s+/)[1];
  if (!["ascii", "binary_little_endian", "binary_big_endian"].includes(format))
    throw new Error("Unsupported PLY encoding.");
  let count = 0,
    inVertex = false,
    seen = false;
  const props = [];
  for (const line of lines) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "element") {
      if (!seen && p[1] !== "vertex" && Number(p[2]) > 0)
        throw new Error("Export PLY with vertices before other elements.");
      inVertex = p[1] === "vertex";
      if (inVertex) {
        count = Number(p[2]);
        seen = true;
      }
    } else if (p[0] === "property" && inVertex) {
      if (p[1] === "list")
        throw new Error("Variable-length vertex fields are not supported.");
      props.push({ type: p[1], name: p[2] });
    }
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 20000000)
    throw new Error("Invalid vertex count.");
  const idx = (n) => props.findIndex((p) => p.name === n),
    xyz = ["x", "y", "z"].map(idx),
    rgb = ["red", "green", "blue"].map(idx);
  if (xyz.some((i) => i < 0))
    throw new Error("PLY must contain x, y and z coordinates.");
  const stride = Math.max(1, Math.ceil(count / maxPoints)),
    capacity = Math.ceil(count / stride),
    positions = new Float32Array(capacity * 3),
    colors = rgb.every((i) => i >= 0) ? new Float32Array(capacity * 3) : null;
  let used = 0,
    origin = null;
  function add(values) {
    const p = xyz.map((i) => Number(values[i]));
    if (p.some((v) => !Number.isFinite(v))) return;
    if (!origin) origin = p.slice();
    const k = used * 3;
    p.forEach((n, i) => (positions[k + i] = n - origin[i]));
    if (colors)
      rgb.forEach((j, i) => {
        const v = Number(values[j]);
        colors[k + i] = Math.max(
          0,
          Math.min(1, Number.isFinite(v) ? v / 255 : 0.7),
        );
      });
    used++;
  }
  if (format === "ascii") {
    const text = new TextDecoder().decode(buffer);
    let cursor = chars;
    for (let i = 0; i < count; i++) {
      if (cursor >= text.length) throw new Error("PLY is truncated.");
      let finish = text.indexOf("\n", cursor);
      if (finish < 0) finish = text.length;
      if (i % stride === 0) {
        const row = text.slice(cursor, finish).trim().split(/\s+/);
        if (row.length < props.length)
          throw new Error("Incomplete PLY vertex.");
        add(row);
      }
      cursor = finish + 1;
    }
  } else {
    const types = {
      char: [1, "getInt8"],
      int8: [1, "getInt8"],
      uchar: [1, "getUint8"],
      uint8: [1, "getUint8"],
      short: [2, "getInt16"],
      int16: [2, "getInt16"],
      ushort: [2, "getUint16"],
      uint16: [2, "getUint16"],
      int: [4, "getInt32"],
      int32: [4, "getInt32"],
      uint: [4, "getUint32"],
      uint32: [4, "getUint32"],
      float: [4, "getFloat32"],
      float32: [4, "getFloat32"],
      double: [8, "getFloat64"],
      float64: [8, "getFloat64"],
    };
    let rowBytes = 0;
    const layout = props.map((p) => {
      const t = types[p.type];
      if (!t) throw new Error("Unsupported PLY property: " + p.type);
      const x = { offset: rowBytes, method: t[1] };
      rowBytes += t[0];
      return x;
    });
    if (offset + count * rowBytes > buffer.byteLength)
      throw new Error("Binary PLY is truncated.");
    const view = new DataView(buffer),
      little = format === "binary_little_endian";
    for (let i = 0; i < count; i += stride)
      add(
        layout.map((p) =>
          view[p.method](offset + i * rowBytes + p.offset, little),
        ),
      );
  }
  if (!used) throw new Error("No finite coordinates found.");
  return {
    positions: positions.slice(0, used * 3),
    colors: colors ? colors.slice(0, used * 3) : null,
    origin,
    count,
    displayed: used,
  };
}
