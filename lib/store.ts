import { db } from 'hydrooj';
import type { BomType } from './scan';

export interface TestdataCheckDoc {
    /** `${domainId}/${docId}/${name}` */
    _id: string;
    domainId: string;
    docId: number;
    name: string;
    /** signature of the testdata file when it was checked, used to detect modification */
    signature: string;
    size: number;
    checkedAt: Date;
    checkedBy: number;
    /** file contains NUL bytes, line ending checks are meaningless */
    binary: boolean;
    bom: BomType | null;
    crlf: number;
    cr: number;
    fixedAt?: Date;
    fixedBy?: number;
    /** storage path of the backup created before modification */
    backup?: string;
}

declare module 'hydrooj' {
    interface Collections {
        testdataCheck: TestdataCheckDoc;
    }
}

export function key(domainId: string, docId: number, name: string) {
    return `${domainId}/${docId}/${name}`;
}

/** Signature of a testdata file entry in ProblemDoc.data */
export function signature(info: { size?: number, etag?: string, lastModified?: Date | string } | null | undefined) {
    if (!info) return '';
    const size = info.size === undefined || info.size === null ? '' : info.size;
    const etag = info.etag || '';
    const lastModified = info.lastModified ? +new Date(info.lastModified) : '';
    return `${size}:${lastModified}:${etag}`;
}

export const coll = () => db.collection('testdataCheck');

export async function getMulti(domainId: string, docIds: number[]) {
    if (!docIds.length) return [];
    return await coll().find({ domainId, docId: { $in: Array.from(new Set(docIds)) } }).toArray();
}

export async function set(doc: TestdataCheckDoc) {
    const { _id, ...rest } = doc;
    await coll().updateOne({ _id }, { $set: rest }, { upsert: true });
}

export async function del(domainId: string, docId: number, names: string[]) {
    if (!names.length) return;
    await coll().deleteMany({ domainId, docId, name: { $in: names } });
}

export async function delProblem(domainId: string, docId: number) {
    await coll().deleteMany({ domainId, docId });
}

export async function dropDomain(domainId: string) {
    await coll().deleteMany({ domainId });
}
