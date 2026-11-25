import { timingSafeEqual } from "node:crypto";

// Workers add crypto.subtle.timingSafeEqual; Node doesn't have it. Same contract: equal-length
// buffers, constant-time comparison (Workers throws on a length mismatch).
const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean };
if (!subtle.timingSafeEqual) {
	const bytes = (b: BufferSource) =>
		ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
	Object.defineProperty(subtle, "timingSafeEqual", {
		value: (a: BufferSource, b: BufferSource) => {
			const x = bytes(a);
			const y = bytes(b);
			if (x.byteLength !== y.byteLength) throw new TypeError("Input buffers must have the same byte length");
			return timingSafeEqual(x, y);
		},
	});
}
