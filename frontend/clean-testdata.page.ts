import {
  $, NamedPage, Notification, addPage, confirm, i18n, request, size, tpl,
} from '@hydrooj/ui-default';

type FileStatus = 'ok' | 'broken' | 'binary' | 'unchecked';
type RowStatus = 'accepted' | 'broken' | 'unchecked' | 'empty';
type Operation = 'check' | 'fix';
type NotifyLevel = 'success' | 'info' | 'warn' | 'error';

interface FileIssue {
  type: 'bom' | 'crlf' | 'cr';
  count: number;
}

interface RowFile {
  name: string;
  size: number;
  status: FileStatus;
  issues: FileIssue[];
  fixable: boolean;
  encoding: string;
}

interface RowData {
  docId: number;
  pid: string;
  title: string;
  owner: number;
  ownerName: string;
  hidden: boolean;
  type: string;
  typeText: string;
  spj: boolean;
  files: RowFile[];
  fileCount: number;
  totalSize: number;
  status: RowStatus;
  issueFileCount: number;
  binaryCount: number;
  uncheckedCount: number;
}

interface CleanTestdataPayload {
  rows: RowData[];
  backupDefault: boolean;
  scanLimit: number;
  truncated: boolean;
  totalProblems: number;
  totalMatched: number;
}

interface FileResult extends RowFile {
  changed: boolean;
  skipped: 'binary' | 'utf16' | null;
  backup: string;
  backupUrl: string;
  issuesBefore: FileIssue[];
}

interface OperationResponse {
  file: FileResult;
  row: RowData;
}

interface Task {
  row: RowData;
  file: RowFile;
}

const LOG_LIMIT = 300;

function notify(message: string, level: NotifyLevel = 'info') {
  if (level === 'success') Notification.success(message);
  else if (level === 'warn') Notification.warn(message);
  else if (level === 'error') Notification.error(message);
  else Notification.info(message);
}

function issuesText(issues: FileIssue[]) {
  if (!issues.length) return i18n('clean_testdata.log.ok');
  return issues
    .map((issue) => `${i18n(`clean_testdata.issue.${issue.type}`)}${issue.count > 1 ? ` ×${issue.count}` : ''}`)
    .join(', ');
}

addPage(new NamedPage('clean_testdata', () => {
  const payload = (UiContext.cleanTestdata || { rows: [] }) as CleanTestdataPayload;
  const rows = new Map<number, RowData>();
  for (const row of payload.rows || []) rows.set(row.docId, row);

  const $backup = $('input[name="clean-testdata-backup"]');
  const $log = $('[name="clean-testdata-log"]');
  const $logList = $('[name="clean-testdata-log-list"]');
  const $stop = $('[name="clean-testdata-stop"]');
  const $batch = $('[name="clean-testdata-check-all"], [name="clean-testdata-fix-all"]');
  const $rowButtons = $('[name="clean-testdata-check"], [name="clean-testdata-fix"]');

  let running = false;
  let stopped = false;

  function renderStatusCell(row: RowData, operation?: Operation, done = 0, total = 0) {
    const statusClass = operation ? 'progress'
      : row.status === 'accepted' ? 'pass' : row.status === 'broken' ? 'fail' : row.status === 'unchecked' ? 'pending' : 'ignored';
    const text = operation
      ? i18n(`clean_testdata.running.${operation}`, done, total)
      : i18n(`clean_testdata.status.${row.status}`);
    const progress = operation
      ? tpl`<div class="col--status__progress-container"><div class="col--status__progress" style="width: ${Math.round(done * 100 / total)}%"></div></div>`
      : '';
    const $status = $(`tr[data-clean-testdata-pid="${row.docId}"] .clean-testdata-status-cell`);
    $status.attr('data-status', operation || row.status)
      .attr('class', `col--status record-status--border ${statusClass} clean-testdata-status-cell`)
      .removeAttr('title')
      .html(tpl`<div class="col--status__text"><span class="icon record-status--icon ${statusClass}"></span> <a href="javascript:;" class="clean-testdata-view record-status--text ${statusClass}" data-pid="${row.docId}">${text}</a></div>` + progress);
  }

  function updateRow(row: RowData) {
    rows.set(row.docId, row);
    $(`tr[data-clean-testdata-pid="${row.docId}"] .col--testdata`).text(`${row.fileCount} / ${size(row.totalSize)}`);
  }

  function updateStats() {
    const stats = {
      total: rows.size, accepted: 0, broken: 0, unchecked: 0, empty: 0,
    };
    for (const row of rows.values()) stats[row.status]++;
    $('[name="clean-testdata-stat"]').text(
      i18n('clean_testdata.scan.stat', stats.total, stats.accepted, stats.broken, stats.unchecked, stats.empty),
    );
  }

  function log(text: string, className = '', backupUrl = '') {
    $log.show();
    const $item = $('<li></li>').addClass(className ? `record-status--text ${className === 'error' ? 'fail' : className === 'changed' ? 'pass' : 'ignored'}` : '').text(`[${new Date().toLocaleString()}] ${text}`);
    if (backupUrl) {
      $item.append(' ').append(
        $('<a target="_blank" rel="noopener"></a>').attr('href', backupUrl).text(`[${i18n('Download backup')}]`),
      );
    }
    $logList.append($item);
    const $children = $logList.children();
    if ($children.length > LOG_LIMIT) $children.slice(0, $children.length - LOG_LIMIT).remove();
    $logList.scrollTop($logList[0].scrollHeight);
  }

  function fileIssuesText(file: RowFile) {
    if (file.status === 'ok') return i18n('clean_testdata.status.normal');
    if (file.status === 'binary') return i18n('clean_testdata.issue.binary');
    if (file.status === 'unchecked') return i18n('clean_testdata.status.unchecked');
    return file.issues.map((issue) => `${i18n(`clean_testdata.issue.${issue.type}`)}${issue.count > 1 ? ` × ${issue.count}` : ''}`).join(' / ');
  }

  function setRunning(value: boolean) {
    running = value;
    $batch.prop('disabled', value);
    $rowButtons.prop('disabled', value);
    $stop.prop('disabled', false).toggle(value);
  }

  function collectTasks(operation: Operation, pid?: number): Task[] {
    const tasks: Task[] = [];
    for (const row of rows.values()) {
      if (pid !== undefined && row.docId !== pid) continue;
      for (const file of row.files) {
        // files known to be fine (or binary) can not be normalized
        if (operation === 'fix' && (file.status === 'ok' || file.status === 'binary')) continue;
        tasks.push({ row, file });
      }
    }
    return tasks;
  }

  async function run(operation: Operation, pid?: number) {
    if (running) return;
    const tasks = collectTasks(operation, pid);
    if (!tasks.length) {
      notify(i18n('clean_testdata.nothing'), 'info');
      return;
    }
    if (operation === 'fix' && !await confirm(i18n('clean_testdata.confirm.fix', tasks.length))) return;
    stopped = false;
    setRunning(true);
    const totals = new Map<number, number>();
    const completed = new Map<number, number>();
    for (const task of tasks) totals.set(task.row.docId, (totals.get(task.row.docId) || 0) + 1);
    let done = 0;
    let changed = 0;
    let unchanged = 0;
    let skippedCount = 0;
    let failed = 0;
    let found = 0;
    let activePid: number | undefined;
    try {
      for (const task of tasks) {
        if (stopped) break;
        activePid = task.row.docId;
        const total = totals.get(activePid)!;
        const rowDone = completed.get(activePid) || 0;
        renderStatusCell(rows.get(activePid)!, operation, rowDone, total);
        try {
          const res = await request.post(window.location.pathname, {
            operation,
            pid: task.row.docId,
            name: task.file.name,
            backup: !!$backup.prop('checked'),
          }) as OperationResponse;
          updateRow(res.row);
          if (operation === 'check') {
            if (res.file.status === 'broken') found++;
            log(i18n('clean_testdata.log.checked', task.row.pid, task.file.name, issuesText(res.file.issues)),
              res.file.status === 'broken' ? 'error' : '');
          } else if (res.file.changed) {
            changed++;
            log(
              i18n('clean_testdata.log.changed', task.row.pid, task.file.name, issuesText(res.file.issuesBefore)),
              'changed', res.file.backupUrl,
            );
          } else if (res.file.skipped === 'binary') {
            skippedCount++;
            log(i18n('clean_testdata.log.binary', task.row.pid, task.file.name), 'skipped');
          } else if (res.file.skipped === 'utf16') {
            skippedCount++;
            log(i18n('clean_testdata.log.utf16', task.row.pid, task.file.name), 'error');
          } else {
            unchanged++;
            log(i18n('clean_testdata.log.unchanged', task.row.pid, task.file.name), 'skipped');
          }
        } catch (e) {
          failed++;
          log(i18n('clean_testdata.log.error', task.row.pid, task.file.name, e.message), 'error');
        }
        done++;
        completed.set(activePid, rowDone + 1);
        const currentRow = rows.get(activePid)!;
        if (rowDone + 1 === total) {
          renderStatusCell(currentRow);
          activePid = undefined;
        } else {
          renderStatusCell(currentRow, operation, rowDone + 1, total);
        }
      }
    } finally {
      setRunning(false);
      updateStats();
      if (activePid !== undefined) renderStatusCell(rows.get(activePid)!);
    }
    if (operation === 'check') notify(i18n('clean_testdata.summary.checked', done, found), found ? 'warn' : 'success');
    else notify(i18n('clean_testdata.summary.changed', changed, unchanged, skippedCount, failed), failed ? 'warn' : 'success');
  }

  function start(operation: Operation, pid?: number) {
    run(operation, pid).catch((e) => {
      console.error(e);
      notify(e?.message || String(e), 'error');
    });
  }

  $('.clean-testdata-table').on('click', '[name="clean-testdata-check"]', (ev) => {
    ev.preventDefault();
    start('check', +$(ev.currentTarget).data('pid'));
  });
  $('.clean-testdata-table').on('click', '.clean-testdata-view', (ev) => {
    ev.preventDefault();
    const row = ($(ev.currentTarget).data('row') || rows.get(+$(ev.currentTarget).data('pid'))) as RowData;
    const table = row.files.length
      ? `<table class="data-table clean-testdata-detail-table"><colgroup><col class="col--file"><col class="col--encoding"><col class="col--state"></colgroup><thead><tr><th>${i18n('File Name')}</th><th>${i18n('Encoding')}</th><th>${i18n('Status')}</th></tr></thead><tbody>${row.files.map((file) => `<tr><td><code>${$('<div>').text(file.name).html()}</code></td><td>${$('<div>').text(file.encoding).html()}</td><td>${fileIssuesText(file)}</td></tr>`).join('')}</tbody></table>`
      : `<p>${i18n('clean_testdata.nothing')}</p>`;
    $('[name="clean-testdata-detail-body"]').html(table);
    $('[name="clean-testdata-detail-dialog"]').css({ display: 'flex', opacity: 1 });
  });
  $('[name="clean-testdata-detail-close"]').on('click', (ev) => {
    ev.preventDefault();
    $(ev.currentTarget).closest('.clean-testdata-dialog').hide();
  });
  $('.clean-testdata-dialog').on('click', (ev) => {
    if (ev.target === ev.currentTarget) $(ev.currentTarget).hide();
  });
  $('.clean-testdata-dialog .dialog__content').on('click', (ev) => ev.stopPropagation());
  $('.clean-testdata-table').on('click', '[name="clean-testdata-fix"]', (ev) => {
    ev.preventDefault();
    start('fix', +$(ev.currentTarget).data('pid'));
  });
  $('[name="clean-testdata-check-all"]').on('click', (ev) => {
    ev.preventDefault();
    start('check');
  });
  $('[name="clean-testdata-fix-all"]').on('click', (ev) => {
    ev.preventDefault();
    start('fix');
  });
  $stop.on('click', (ev) => {
    ev.preventDefault();
    stopped = true;
  });
}));
