import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { createWriteStream } from 'fs';

export type BomType = 'utf8' | 'utf16le' | 'utf16be';

export interface ScanResult {
    /** total bytes of the file */
    size: number;
    /** detected byte order mark, null if none */
    bom: BomType | null;
    /** count of CRLF sequences */
    crlf: number;
    /** count of CR not followed by LF */
    cr: number;
    /** true if a 0x00 byte was found, such file is always treated as binary and never modified */
    nul: boolean;
    /** true when the non-binary bytes are not valid UTF-8 */
    invalidUtf8: boolean;
}

const CR = 0x0D;
const LF = 0x0A;

export function detectBom(head: Buffer): BomType | null {
    if (head.length >= 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) return 'utf8';
    if (head.length >= 2 && head[0] === 0xFF && head[1] === 0xFE) return 'utf16le';
    if (head.length >= 2 && head[0] === 0xFE && head[1] === 0xFF) return 'utf16be';
    return null;
}

function toBuffer(chunk: any): Buffer {
    return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/** Was anything found that makes this file not a "LF only, no BOM" text file? */
export function hasIssues(scan: Pick<ScanResult, 'bom' | 'crlf' | 'cr'>) {
    return !!scan.bom || scan.crlf > 0 || scan.cr > 0;
}

/**
 * Only UTF-8 BOM / CRLF / CR can be normalized automatically.
 * Binary files and UTF-16 encoded files are reported but left untouched.
 */
export function isFixable(scan: Pick<ScanResult, 'bom' | 'crlf' | 'cr' | 'nul'>) {
    if (scan.nul) return false;
    if (scan.bom === 'utf16le' || scan.bom === 'utf16be') return false;
    return hasIssues(scan);
}

/** Size of the normalized file, used to detect concurrent modification. */
export function normalizedSize(scan: Pick<ScanResult, 'size' | 'bom' | 'crlf'>) {
    return scan.size - (scan.bom === 'utf8' ? 3 : 0) - scan.crlf;
}

/**
 * Scan a stream without buffering the whole file in memory.
 * The stream is fully consumed, the caller must not reuse it afterwards.
 */
export async function scanStream(input: Readable): Promise<ScanResult> {
    const res: ScanResult = { size: 0, bom: null, crlf: 0, cr: 0, nul: false, invalidUtf8: false };
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let head = Buffer.alloc(0);
    let bomChecked = false;
    // CR at the end of a chunk may be followed by LF in the next chunk
    let pendingCR = false;
    for await (const chunk of input) {
        const buf = toBuffer(chunk);
        res.size += buf.length;
        try { decoder.decode(buf, { stream: true }); } catch { res.invalidUtf8 = true; }
        if (!bomChecked) {
            head = Buffer.concat([head, buf.subarray(0, Math.max(0, 3 - head.length))]);
            const bom = detectBom(head);
            if (bom) {
                res.bom = bom;
                bomChecked = true;
            } else if (head.length >= 3) bomChecked = true;
        }
        for (let i = 0; i < buf.length; i++) {
            const b = buf[i];
            if (pendingCR) {
                pendingCR = false;
                if (b === LF) { res.crlf++; continue; }
                res.cr++;
            }
            if (b === CR) pendingCR = true;
            else if (b === 0) res.nul = true;
        }
    }
    if (pendingCR) res.cr++;
    try { decoder.decode(); } catch { res.invalidUtf8 = true; }
    return res;
}

/**
 * Write a normalized copy of `input` (UTF-8 BOM removed, all line breaks converted to LF)
 * into `dest`. Returns the number of bytes written.
 *
 * The source file is never touched, so an aborted / failed operation can not damage testdata.
 */
export function normalizeStream(input: Readable, dest: string): Promise<number> {
    let written = 0;
    let pendingCR = false;
    let atHead = true;
    let head = Buffer.alloc(0);
    // a CR at the end of a chunk is only resolved when the next byte is known,
    // otherwise a CRLF pair splitted between two chunks would produce two line breaks
    const convert = (buf: Buffer): Buffer => {
        const res = Buffer.allocUnsafe(buf.length + (pendingCR ? 1 : 0));
        let o = 0;
        for (let i = 0; i < buf.length; i++) {
            const b = buf[i];
            if (pendingCR) {
                pendingCR = false;
                if (b === LF) {
                    res[o++] = LF;
                    continue;
                }
                res[o++] = LF;
            }
            if (b === CR) {
                if (i + 1 < buf.length) {
                    if (buf[i + 1] === LF) i++;
                    res[o++] = LF;
                } else pendingCR = true;
            } else res[o++] = b;
        }
        written += o;
        return Buffer.from(res.subarray(0, o));
    };
    const flushPendingCR = (): Buffer | null => {
        if (!pendingCR) return null;
        pendingCR = false;
        written += 1;
        return Buffer.from([LF]);
    };
    const transform = new Transform({
        transform(chunk, _encoding, callback) {
            try {
                let buf = toBuffer(chunk);
                if (atHead) {
                    buf = Buffer.concat([head, buf]);
                    head = Buffer.alloc(0);
                    if (buf.length < 3) {
                        // the whole file may be shorter than a BOM, keep buffering
                        head = buf;
                        callback();
                        return;
                    }
                    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.subarray(3);
                    atHead = false;
                }
                const out = convert(buf);
                if (out.length) this.push(out);
                callback();
            } catch (e) {
                callback(e as Error);
            }
        },
        flush(callback) {
            try {
                if (head.length) {
                    atHead = false;
                    const out = convert(head);
                    head = Buffer.alloc(0);
                    if (out.length) this.push(out);
                }
                const tail = flushPendingCR();
                if (tail) this.push(tail);
                callback();
            } catch (e) {
                callback(e as Error);
            }
        },
    });
    return pipeline(input, transform, createWriteStream(dest)).then(() => written);
}
