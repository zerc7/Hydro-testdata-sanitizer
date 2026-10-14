import os from 'os';
import path from 'path';
import {
    CreateError, type FileInfo, ForbiddenError, Handler, Logger, OplogModel, PERM, type ProblemDoc,
    ProblemModel, ProblemNotFoundError, StorageModel, SystemModel, Types, UserFacingError, UserModel,
    ValidationError, type Filter, fs, nanoid, param, query, yaml,
} from 'hydrooj';
import { hasIssues, isFixable, normalizedSize, normalizeStream, scanStream, type ScanResult } from './scan';
import * as store from './store';
import {
    buildFile, buildRow, isConfigFile, isTargetFile, scanToFile, summarize, type FileIssue, type RowData, type RowFile,
} from './status';

export interface CleanTestdataOptions {
    scanLimit: number;
    defaultBackup: boolean;
}

const logger = new Logger('clean-testdata');

export const TestdataReadError = CreateError('TestdataReadError', UserFacingError, 'Failed to read testdata file {0}. ({1})', 400);
export const TestdataChangedError = CreateError(
    'TestdataChangedError', UserFacingError,
    'Testdata file {0} was modified while processing, the operation was aborted.', 400,
);
export const TestdataConfigError = CreateError(
    'TestdataConfigError', UserFacingError,
    'The normalized {0} is not a valid yaml file, the operation was aborted. ({1})', 400,
);
export const TestdataWriteError = CreateError(
    'TestdataWriteError', UserFacingError,
    'Failed to write testdata file {0}, the original file was restored from the backup. ({1})', 500,
);
export const RequireDomainRootError = CreateError(
    'RequireDomainRootError', ForbiddenError,
    'Only domain root can access the Clean Testdata page.', 403,
);

/** fields required to render the page */
const PROJECTION: (keyof ProblemDoc)[] = [
    'domainId', 'docId', 'pid', 'title', 'owner', 'data', 'config', 'hidden',
];

const tmpDir = path.join(os.tmpdir(), 'hydro', 'clean-testdata');

const statusRange = ['all', 'accepted', 'broken', 'unchecked', 'empty'];
const typeRange = ['all', 'default', 'spj', 'interactive', 'communication', 'submit_answer', 'objective', 'remote_judge'];
const falseValues = ['false', 'off', 'no', '0', 0, false, ''];

let options: CleanTestdataOptions = { scanLimit: 2000, defaultBackup: true };

export function configure(opts: CleanTestdataOptions) {
    options = opts;
}

function escapeRegExp(str: string) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildQueryString(obj: Record<string, any>) {
    return Object.entries(obj).filter(([key, value]) => value && !key.startsWith('__'))
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

function testdataPath(domainId: string, docId: number, name: string) {
    // Names are database data, not trusted input. Keep storage keys confined to
    // the problem's testdata directory even if a malformed ProblemDoc exists.
    if (!isSafeTestdataName(name)) {
        throw new ValidationError('name');
    }
    return `problem/${domainId}/${docId}/testdata/${name}`;
}

function backupPath(domainId: string, docId: number, name: string) {
    if (!isSafeTestdataName(name)) throw new ValidationError('name');
    return `problem/${domainId}/${docId}/testdata-backup/${Date.now()}/${name}`;
}

function isSafeTestdataName(name: unknown): name is string {
    return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
        && !name.includes('/') && !name.includes('\\') && !name.includes('..')
        && !/[\u0000-\u001f\u007f]/.test(name);
}

/**
 * Serialize operations on the same testdata file inside one worker process,
 * so that two concurrent requests can not write the same file at the same time.
 */
const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, func: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) || Promise.resolve();
    let release: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = prev.then(() => gate);
    locks.set(key, current);
    await prev;
    try {
        return await func();
    } finally {
        release!();
        if (locks.get(key) === current) locks.delete(key);
    }
}

async function loadProblem(domainId: string, pid: number | string) {
    const pdoc = await ProblemModel.get(domainId, pid, PROJECTION, true);
    if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
    return pdoc;
}

function findTestdata(pdoc: ProblemDoc, name: string): FileInfo {
    if (!isTargetFile(name)) throw new ValidationError('name');
    const info = (pdoc.data || []).find((i) => i.name === name);
    if (!info) throw new ValidationError('name');
    return info;
}

async function scanStorage(domainId: string, docId: number, name: string): Promise<ScanResult> {
    if (!isTargetFile(name)) throw new ValidationError('name');
    const stream = await StorageModel.get(testdataPath(domainId, docId, name))
        .catch((e) => { throw new TestdataReadError(name, e.message); });
    if (!stream) throw new TestdataReadError(name, 'File not found');
    return await scanStream(stream);
}

function recordOf(
    domainId: string, pdoc: ProblemDoc, info: FileInfo, scan: ScanResult, uid: number,
): store.TestdataCheckDoc {
    return {
        _id: store.key(domainId, pdoc.docId, info.name),
        domainId,
        docId: pdoc.docId,
        name: info.name,
        signature: store.signature(info),
        size: scan.size,
        bom: scan.bom,
        crlf: scan.crlf,
        cr: scan.cr,
        binary: scan.nul,
        checkedAt: new Date(),
        checkedBy: uid,
    };
}

async function checkFile(domainId: string, pdoc: ProblemDoc, info: FileInfo, uid: number) {
    const scan = await scanStorage(domainId, pdoc.docId, info.name);
    const doc = recordOf(domainId, pdoc, info, scan, uid);
    await store.set(doc);
    return doc;
}

interface FixResult extends RowFile {
    changed: boolean;
    skipped: 'binary' | 'utf16' | null;
    backup: string;
    backupUrl: string;
    /** issues found before the modification, for reporting */
    issuesBefore: FileIssue[];
}

interface FixOutput {
    result: FixResult;
    /** problem document after the modification (or the original one if nothing changed) */
    pdoc: ProblemDoc;
}

async function fixFile(
    domainId: string, pdoc: ProblemDoc, info: FileInfo, uid: number, backupEnable: boolean,
): Promise<FixOutput> {
    const key = testdataPath(domainId, pdoc.docId, info.name);
    // always rescan the file on the server side, never trust the client
    const before = await scanStorage(domainId, pdoc.docId, info.name);
    const file = scanToFile(info.name, before);
    const base: FixResult = {
        ...file,
        changed: false,
        skipped: null,
        backup: '',
        backupUrl: '',
        issuesBefore: file.issues,
    };
    if (before.nul) {
        await store.set(recordOf(domainId, pdoc, info, before, uid));
        return { result: { ...base, status: 'binary', skipped: 'binary' }, pdoc };
    }
    if (!hasIssues(before) || !isFixable(before)) {
        await store.set(recordOf(domainId, pdoc, info, before, uid));
        return {
            result: { ...base, skipped: hasIssues(before) ? 'utf16' : null },
            pdoc,
        };
    }

    await fs.ensureDir(tmpDir);
    const tmp = path.join(tmpDir, `${nanoid()}.tmp`);
    let backup = '';
    try {
        const stream = await StorageModel.get(key).catch((e) => { throw new TestdataReadError(info.name, e.message); });
        if (!stream) throw new TestdataReadError(info.name, 'File not found');
        const written = await normalizeStream(stream, tmp);
        const stat = await fs.stat(tmp);
        const expected = normalizedSize(before);
        // the file was modified between the scan and the modification, abort to stay safe
        if (written !== expected || stat.size !== expected) throw new TestdataChangedError(info.name);
        if (isConfigFile(info.name)) {
            const content = await fs.readFile(tmp, 'utf-8');
            try {
                yaml.load(content);
            } catch (e) {
                throw new TestdataConfigError(info.name, e.message);
            }
        }
        // Always keep a restorable copy of the original file until the new content is committed,
        // so that a failed upload can be rolled back. `StorageModel.copy` shares the underlying
        // blob, so this does not duplicate any data on disk.
        const backupKey = backupPath(domainId, pdoc.docId, info.name);
        await StorageModel.copy(key, backupKey);
        try {
            await ProblemModel.addTestdata(domainId, pdoc.docId, info.name, tmp, uid);
        } catch (e) {
            // the upload may have removed the original file already, put it back
            let restored = false;
            try {
                const backupStream = await StorageModel.get(backupKey);
                if (!backupStream) throw new TestdataReadError(info.name, 'Backup not found');
                await ProblemModel.addTestdata(domainId, pdoc.docId, info.name, backupStream, uid);
                restored = true;
            } catch (restoreError) {
                logger.error('Failed to restore testdata %s from %s: %o', info.name, backupKey, restoreError);
            }
            if (restored && !backupEnable) {
                await StorageModel.del([backupKey]).catch((err) => logger.warn('Failed to remove backup: %o', err));
            }
            if (restored) throw new TestdataWriteError(info.name, e.message);
            throw e;
        }
        if (backupEnable) backup = backupKey;
        else {
            // the user did not ask for a backup, drop it (still recoverable until storage pruning)
            await StorageModel.del([backupKey]).catch((e) => logger.warn('Failed to remove backup: %o', e));
        }
        // file size / signature changed, reload the problem to get the new metadata
        const fresh = await loadProblem(domainId, pdoc.docId);
        const freshInfo = (fresh.data || []).find((i) => i.name === info.name) || info;
        await store.set({
            _id: store.key(domainId, pdoc.docId, info.name),
            domainId,
            docId: pdoc.docId,
            name: info.name,
            signature: store.signature(freshInfo),
            size: expected,
            bom: null,
            crlf: 0,
            cr: 0,
            binary: false,
            checkedAt: new Date(),
            checkedBy: uid,
            fixedAt: new Date(),
            fixedBy: uid,
            backup,
        });
        return {
            result: {
                ...base,
                size: expected,
                status: 'ok',
                issues: [],
                fixable: false,
                changed: true,
                backup,
                backupUrl: backup ? await StorageModel.signDownloadLink(backup, info.name) : '',
            },
            pdoc: fresh,
        };
    } finally {
        await fs.remove(tmp);
    }
}

async function rowPayload(domainId: string, pdoc: ProblemDoc): Promise<RowData> {
    const records = await store.getMulti(domainId, [pdoc.docId]);
    const row = buildRow(pdoc, records);
    const udict = await UserModel.getList(domainId, [pdoc.owner]);
    row.ownerName = udict[pdoc.owner]?.uname || `#${pdoc.owner}`;
    return row;
}

export class CleanTestdataHandler extends Handler {
    /** batch operations issue one request per testdata file, do not count them in the global rate limit */
    notUsage = true;

    async prepare() {
        // only domain root can use this tool
        if (!this.user.hasPerm(PERM.PERM_ALL)) throw new RequireDomainRootError();
    }

    @query('page', Types.PositiveInt, true)
    @query('q', Types.Content, true)
    @query('status', Types.Range(statusRange), true)
    @query('type', Types.Range(typeRange), true)
    async get(domainId: string, page = 1, q = '', statusFilter = 'all', typeFilter = 'all') {
        this.response.template = 'clean_testdata.html';
        const filter: Filter<ProblemDoc> = {};
        if (q) {
            const regex = new RegExp(escapeRegExp(q), 'i');
            filter.$or = [{ pid: regex }, { title: regex }];
        }
        const [total, pdocs] = await Promise.all([
            ProblemModel.count(domainId, filter),
            ProblemModel.getMulti(domainId, filter, PROJECTION).sort({ sort: 1, docId: 1 }).limit(options.scanLimit).toArray(),
        ]);
        const records = await store.getMulti(domainId, pdocs.map((i) => i.docId));
        const recMap = new Map<number, store.TestdataCheckDoc[]>();
        for (const rec of records) {
            if (!recMap.has(rec.docId)) recMap.set(rec.docId, []);
            recMap.get(rec.docId)!.push(rec);
        }
        let rows = pdocs.map((pdoc) => buildRow(pdoc, recMap.get(pdoc.docId) || []));
        const stats = summarize(rows);
        if (statusFilter !== 'all') rows = rows.filter((row) => row.status === statusFilter);
        if (typeFilter !== 'all') {
            rows = rows.filter((row) => (typeFilter === 'spj' ? row.spj : row.type === typeFilter));
        }
        const limit = SystemModel.get('pagination.problem') || 100;
        const pageCount = Math.max(1, Math.ceil(rows.length / limit));
        const current = Math.min(Math.max(page, 1), pageCount);
        const pageRows = rows.slice((current - 1) * limit, current * limit);
        const udict = await UserModel.getList(domainId, pageRows.map((row) => row.owner));
        for (const row of pageRows) row.ownerName = udict[row.owner]?.uname || `#${row.owner}`;
        const truncated = total > pdocs.length;
        this.response.body = {
            rows: pageRows,
            page: current,
            pageCount,
            q,
            status: statusFilter,
            type: typeFilter,
            stats,
            truncated,
            scanLimit: options.scanLimit,
            backupDefault: options.defaultBackup,
            totalProblems: total,
            totalMatched: rows.length,
            qs: buildQueryString({
                q,
                status: statusFilter === 'all' ? '' : statusFilter,
                type: typeFilter === 'all' ? '' : typeFilter,
            }),
            payload: {
                rows: pageRows,
                backupDefault: options.defaultBackup,
                scanLimit: options.scanLimit,
                truncated,
                totalProblems: total,
                totalMatched: rows.length,
            },
        };
    }

    @param('pid', Types.ProblemId)
    @param('name', Types.String)
    async postCheck(domainId: string, pid: number | string, name: string) {
        this.checkPerm(PERM.PERM_READ_PROBLEM_DATA);
        const pdoc = await loadProblem(domainId, pid);
        const info = findTestdata(pdoc, name);
        const doc = await withLock(store.key(domainId, pdoc.docId, name), () => checkFile(domainId, pdoc, info, this.user._id));
        this.response.body = {
            file: buildFile(info, doc),
            row: await rowPayload(domainId, pdoc),
        };
    }

    @param('pid', Types.ProblemId)
    @param('name', Types.String)
    async postFix(domainId: string, pid: number | string, name: string) {
        this.checkPerm(PERM.PERM_EDIT_PROBLEM);
        this.checkPerm(PERM.PERM_READ_PROBLEM_DATA);
        const backup = this.args.backup === undefined
            ? options.defaultBackup
            : !falseValues.includes(this.args.backup);
        const pdoc = await loadProblem(domainId, pid);
        const info = findTestdata(pdoc, name);
        const { result, pdoc: fresh } = await withLock(
            store.key(domainId, pdoc.docId, name),
            () => fixFile(domainId, pdoc, info, this.user._id, backup),
        );
        if (result.changed) {
            await OplogModel.log(this, 'clean-testdata.fix', {
                domainId,
                pid: pdoc.docId,
                name,
                size: result.size,
                backup: result.backup,
            });
        }
        this.response.body = {
            file: result,
            row: await rowPayload(domainId, fresh),
        };
    }
}
