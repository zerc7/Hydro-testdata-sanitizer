import { Context, PERM, Schema } from 'hydrooj';
import { CleanTestdataHandler, configure } from './lib/handler';
import * as store from './lib/store';

export const name = 'clean-testdata';

export const Config = Schema.object({
    scanLimit: Schema.number().step(1).min(1).default(2000)
        .description('Maximum number of problems scanned by the Clean Testdata page.'),
    defaultBackup: Schema.boolean().default(true)
        .description('Create a restorable backup of every testdata file before modifying it.'),
});

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
    configure({
        scanLimit: config.scanLimit,
        defaultBackup: config.defaultBackup,
    });

    ctx.Route('clean_testdata', '/clean-testdata', CleanTestdataHandler, PERM.PERM_EDIT_DOMAIN);

    // only domain root can see this entry
    ctx.injectUI(
        'ProblemAdd', 'clean_testdata',
        { title: 'Manage', text: 'Clean Testdata', icon: 'wrench' },
        // Use the native permission checker so the node is filtered in exactly
        // the same way as the route (and remains visible after UI hot reload).
        PERM.PERM_ALL,
    );

    const drop = (domainId: string, docId?: number, names?: string[]) => {
        const task = docId === undefined ? store.dropDomain(domainId)
            : names === undefined ? store.delProblem(domainId, docId)
                : store.del(domainId, docId, names);
        return task.catch((e) => ctx.logger('clean-testdata').warn('Failed to clean check records: %o', e));
    };

    // keep the check records in sync with the testdata
    ctx.on('problem/delTestdata', (domainId, docId, names) => drop(domainId, docId, names));
    ctx.on('problem/renameTestdata', (domainId, docId, name, newName) => drop(domainId, docId, [name, newName]));
    ctx.on('problem/delete', (domainId, docId) => drop(domainId, docId));
    ctx.on('domain/delete', (domainId) => drop(domainId));

    ctx.inject(['db'], ({ db }) => {
        db.ensureIndexes(
            db.collection('testdataCheck'),
            { key: { domainId: 1, docId: 1 }, name: 'domainId_docId' },
        ).catch((e) => ctx.logger('clean-testdata').warn('Failed to create index: %o', e));
    });
}
