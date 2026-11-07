import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Public endpoint, not a credential. Original tables are read only by this builder.
const SOURCE_URL = 'https://script.google.com/macros/s/AKfycbzF0FnUNaAnyyyu6RY7W-TG8tMG8ynUuo1M9eeg0QWIFzWKcf9ctjAZLsDcxIZjfZP4/exec';
const REPOSITORY = 'anetik85-commits/svoi-catalog-data';
const BRANCH = 'main';
const RUBRICS = new Set(['R01', 'R10', 'R05', 'R04', 'sport-fitness', 'R02',
  'R06', 'R07', 'R08', 'R09', 'R03', 'R11']);
const FIELDS = ['id', 'name', 'type', 'rubric', 'rubricBook', 'member', 'desc',
  'cta', 'services', 'phones', 'address', 'gis', 'targetLink', 'targetLabel',
  'textID', 'offer'];
const TEXT = ['id', 'name', 'type', 'rubric', 'rubricBook', 'member', 'desc',
  'cta', 'address', 'gis', 'targetLink', 'targetLabel', 'textID'];
const OFFER = ['text', 'terms', 'footnote', 'audience'];

export function fingerprint(items) {
  const canonical = items.map(c => Object.fromEntries(FIELDS.map(k => [k, c[k]])));
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export function validate(p) {
  assert(p && p.schemaVersion === 2 && p.ok === true, 'Сборщик не подтвердил успешную выдачу');
  assert(Object.keys(p).every(k => ['schemaVersion', 'ok', 'hash', 'count', 'items'].includes(k)),
    'Неожиданные поля: не публикуем непроверенные данные');
  assert(Array.isArray(p.items) && Number.isInteger(p.count) && p.count === p.items.length,
    'Неверное количество компаний');
  assert(/^[a-f0-9]{64}$/.test(p.hash), 'Неверный хеш');
  const seen = new Set();
  for (const c of p.items) {
    assert(c && typeof c === 'object', 'Неверная карточка');
    assert(Object.keys(c).every(k => FIELDS.includes(k)), 'Неожиданные поля карточки');
    assert(TEXT.every(k => typeof c[k] === 'string'), 'Неверные текстовые поля');
    assert(/^B\d{3,}$/.test(c.id) && !seen.has(c.id), 'Неверный или повторный BusinessID');
    seen.add(c.id);
    assert(c.name.trim(), 'Пустое название');
    assert(RUBRICS.has(c.rubric), 'Неизвестная сайту рубрика: сначала обновите Tilda');
    assert(Array.isArray(c.services) && c.services.every(s => typeof s === 'string'),
      'Неверные услуги');
    assert(Array.isArray(c.phones) && c.phones.length > 0, 'Нет телефона');
    for (const phone of c.phones) {
      assert(phone && Object.keys(phone).every(k => ['num', 'tel', 'label'].includes(k)),
        'Неверные поля телефона');
      assert(['num', 'tel', 'label'].every(k => typeof phone[k] === 'string'),
        'Неверный телефон');
      assert(/^\+\d{7,15}(;ext=\d{1,6})?$/.test(phone.tel), 'Неверная ссылка телефона');
    }
    assert(c.offer === null || (c.offer && OFFER.every(k => typeof c.offer[k] === 'string') &&
      Object.keys(c.offer).every(k => OFFER.includes(k))), 'Неверное предложение');
    for (const key of ['gis', 'targetLink']) {
      assert(!c[key] || /^https?:\/\//i.test(c[key]), 'Небезопасная ссылка');
    }
  }
  assert.equal(fingerprint(p.items), p.hash, 'Содержимое не соответствует хешу сборщика');
  return p;
}

function github(method, endpoint, body) {
  const args = ['api', '--method', method, endpoint];
  if (body !== undefined) args.push('--input', '-');
  const result = execFileSync('gh', args, {
    encoding: 'utf8', timeout: 60000,
    input: body === undefined ? undefined : JSON.stringify(body),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.trim() ? JSON.parse(result) : null;
}

function summary(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n');
  }
}

function keepScheduleAlive() {
  // Public GitHub schedules can stop after 60 days without repository activity.
  // At most once in 45 quiet days create an empty service commit, not a data rewrite.
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const ageDays = (Date.now() - Number(git('log', '-1', '--format=%ct')) * 1000) / 86400000;
  assert(Number.isFinite(ageDays), 'Не удалось проверить срок активности репозитория');
  if (ageDays < 45) return;
  const head = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const commit = github('POST', `repos/${REPOSITORY}/git/commits`, {
    message: 'Keep daily catalog schedule active (no data changes)',
    tree, parents: [head],
  });
  github('PATCH', `repos/${REPOSITORY}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha, force: false,
  });
  summary('Служебная отметка активности: данные каталога не изменены.');
}

async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY, 'Запуск не в том репозитории');
  assert.equal(process.env.GITHUB_REF_NAME, BRANCH, 'Запуск разрешён только из main');
  const response = await fetch(SOURCE_URL, {
    redirect: 'follow', signal: AbortSignal.timeout(90000),
  });
  assert(response.ok, `Сборщик ответил HTTP ${response.status}`);
  const text = await response.text();
  assert(Buffer.byteLength(text, 'utf8') < 5 * 1024 * 1024, 'Слишком большой ответ сборщика');
  const fresh = validate(JSON.parse(text));

  const endpoint = `repos/${REPOSITORY}/contents/catalog.json`;
  const stored = github('GET', `${endpoint}?ref=${BRANCH}`);
  const old = validate(JSON.parse(Buffer.from(stored.content, 'base64').toString('utf8')));
  if (fresh.hash === old.hash) {
    summary(`Без изменений: ${fresh.count} компаний. catalog.json не перезаписывался.`);
    keepScheduleAlive();
    return;
  }
  // GitHub replaces the whole file atomically; SHA prevents overwriting a concurrent edit.
  github('PUT', endpoint, {
    message: `Update catalog: ${fresh.count} companies`,
    branch: BRANCH, sha: stored.sha,
    content: Buffer.from(JSON.stringify(fresh, null, 2) + '\n', 'utf8').toString('base64'),
  });
  summary(`Обновлено: ${fresh.count} компаний. Новый хеш ${fresh.hash}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Обновление остановлено: ${error.message}`);
    console.error('Непроверенный файл не опубликован. См. шаг и историю catalog.json.');
    process.exitCode = 1;
  });
}
