import { yaml, type FileInfo, type ProblemDoc } from 'hydrooj';
import { isFixable, type ScanResult } from './scan';
import { signature, type TestdataCheckDoc } from './store';

/** per file state */
export type FileStatus = 'ok' | 'broken' | 'binary' | 'unchecked';
/** per problem state */
export type RowStatus = 'accepted' | 'broken' | 'unchecked' | 'empty';

export interface FileIssue {
    type: 'bom' | 'crlf' | 'cr';
    count: number;
}

export interface RowFile {
    name: string;
    size: number;
    status: FileStatus;
    issues: FileIssue[];
    /** whether the plugin is able to normalize the file automatically */
    fixable: boolean;
    encoding: string;
}

export interface RowData {
    docId: number;
    pid: string;
    title: string;
    owner: number;
    ownerName: string;
    hidden: boolean;
    type: string;
    /** i18n key of the problem type */
    typeText: string;
    spj: boolean;
    files: RowFile[];
    fileCount: number;
    totalSize: number;
    status: RowStatus;
    issueFileCount: number;
    binaryCount: number;
    uncheckedCount: number;
    lastCheckedAt: Date | null;
}

export const TYPE_TEXTS: Record<string, string> = {
    default: 'problem_type.default',
    interactive: 'problem_type.interactive',
    communication: 'problem_type.communication',
    submit_answer: 'problem_type.submit_answer',
    objective: 'problem_type.objective',
    remote_judge: 'problem_type.remote_judge',
};

export const CONFIG_FILES = ['config.yaml', 'config.yml', 'Config.yaml', 'Config.yml'];

export function isConfigFile(name: string) {
    return CONFIG_FILES.includes(name);
}

export function isTargetFile(name: string) {
    return /\.(?:in|out|ans)$/i.test(name);
}

export function parseProblemConfig(config: unknown): { type: string, checkerType: string, spj: boolean } {
    let raw: any = config;
    if (typeof raw === 'string') {
        try {
            raw = (yaml.load(raw) as any) || {};
        } catch (e) {
            raw = {};
        }
    }
    if (!raw || typeof raw !== 'object') raw = {};
    const type = typeof raw.type === 'string' ? raw.type : 'default';
    const checkerType = typeof raw.checker_type === 'string' ? raw.checker_type : '';
    return { type, checkerType, spj: !!checkerType && !['default', 'strict'].includes(checkerType) };
}

export function issuesOf(rec: Pick<TestdataCheckDoc, 'bom' | 'crlf' | 'cr'>): FileIssue[] {
    const issues: FileIssue[] = [];
    if (rec.bom) issues.push({ type: 'bom', count: 1 });
    if (rec.crlf) issues.push({ type: 'crlf', count: rec.crlf });
    if (rec.cr) issues.push({ type: 'cr', count: rec.cr });
    return issues;
}

/** Build the status of one testdata file out of a scan result */
export function scanToFile(name: string, scan: Pick<ScanResult, 'size' | 'bom' | 'crlf' | 'cr' | 'nul'>): RowFile {
    if (scan.nul) return { name, size: scan.size, status: 'binary', issues: [], fixable: false, encoding: 'binary' };
    const issues = issuesOf(scan);
    const encoding = scan.bom === 'utf16le' ? 'UTF-16LE' : scan.bom === 'utf16be' ? 'UTF-16BE' : scan.bom === 'utf8' ? 'UTF-8 BOM' : 'UTF-8';
    if (!issues.length) return { name, size: scan.size, status: 'ok', issues: [], fixable: false, encoding };
    return { name, size: scan.size, status: 'broken', issues, fixable: isFixable(scan), encoding };
}

/** Build the status of one testdata file out of its stored record */
export function buildFile(info: FileInfo, rec?: TestdataCheckDoc | null): RowFile {
    if (!rec || rec.signature !== signature(info)) {
        return { name: info.name, size: info.size || 0, status: 'unchecked', issues: [], fixable: false, encoding: 'unknown' };
    }
    return scanToFile(info.name, {
        size: rec.size || info.size || 0,
        bom: rec.bom,
        crlf: rec.crlf,
        cr: rec.cr,
        nul: rec.binary,
    });
}

export function buildRow(pdoc: ProblemDoc, records: TestdataCheckDoc[]): RowData {
    const recMap = new Map(records.map((r) => [r.name, r]));
    const files: RowFile[] = [];
    let totalSize = 0;
    let issueFileCount = 0;
    let binaryCount = 0;
    let uncheckedCount = 0;
    let lastCheckedAt: Date | null = null;
    for (const info of (pdoc.data || []).filter((i) => isTargetFile(i.name))) {
        totalSize += info.size || 0;
        const rec = recMap.get(info.name);
        if (rec?.checkedAt && rec.signature === signature(info)
            && (!lastCheckedAt || rec.checkedAt > lastCheckedAt)) lastCheckedAt = rec.checkedAt;
        const file = buildFile(info, rec);
        if (file.status === 'broken') issueFileCount++;
        else if (file.status === 'binary') binaryCount++;
        else if (file.status === 'unchecked') uncheckedCount++;
        files.push(file);
    }
    const status: RowStatus = issueFileCount ? 'broken'
        : !files.length ? 'empty'
            : uncheckedCount ? 'unchecked' : 'accepted';
    const config = parseProblemConfig(pdoc.config);
    return {
        docId: pdoc.docId,
        pid: pdoc.pid || `P${pdoc.docId}`,
        title: pdoc.title,
        owner: pdoc.owner,
        ownerName: '',
        hidden: !!pdoc.hidden,
        type: config.type,
        typeText: TYPE_TEXTS[config.type] || config.type,
        spj: config.spj,
        files,
        fileCount: files.length,
        totalSize,
        status,
        issueFileCount,
        binaryCount,
        uncheckedCount,
        lastCheckedAt,
    };
}

export function summarize(rows: RowData[]) {
    const stats = { total: rows.length, accepted: 0, broken: 0, unchecked: 0, empty: 0 };
    for (const row of rows) stats[row.status]++;
    return stats;
}
